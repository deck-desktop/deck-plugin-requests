// Shared workspaces, live: teamsync.ts run over each team's channel (Deck's teams). Started at
// plugin load, so a workspace keeps in step while the Requests tab is closed, and stopped by the
// plugin's dispose.
//
// What a Deck says to a member who connects: a digest (every record's revision) of each workspace
// shared with their team; they send back what they have newer, and their own digest if this one has
// something newer. After that, each save sends what it changed to everyone online.
//
// Two writers, one path: while the Requests tab is open, what arrives goes into the tab's state
// (and is saved by the tab, as an edit there would be); with no tab, it is written here.
import { teamChannel, myTeamId, subscribeTeams, teamsView, type TeamChannel, type Member } from "../shim/p2p.js";
import { configRead, configWrite } from "../shim/bridge.js";
import { loadCollections, saveCollections, setSaveHook, type Collections } from "./httpclient";
import { apply, behind, digest, localChanges, newerThan, recsFor, type Meta, type Rec } from "./teamsync";
import { validId } from "./secrets";

type Msg =
  | { t: "digest"; ws: string; d: Record<string, [number, string]>; ask: boolean }
  | { t: "recs"; ws: string; recs: Rec[] };

const META = "team-sync";
let col: Collections | null = null;
let meta: Record<string, Meta> = {};
let metaText = "";
let me = "";
let stopped = false;
let loadedMeta = false;
let unTeams: (() => void) | null = null;
// Typed loosely: a record's data is whatever JSON the record holds.
const chans = new Map<string, TeamChannel<any>>();
/** The open tab's way in: it applies a change to its own state, then saves it. */
let tab: ((f: (c: Collections) => Collections) => void) | null = null;

function saveMeta() {
  const t = JSON.stringify(meta);
  if (t === metaText) return;
  metaText = t;
  void configWrite(META, t).catch((e) => console.warn("[requests] saving the team sync state failed", e));
}

const shared = (c: Collections) => c.workspaces.filter((w) => w.teamId);

/** A channel for every team this Deck is in, so a workspace a member shares reaches it even before
 *  anything is shared from here; one for a team it left closes. */
function channels() {
  if (!col || stopped) return;
  const want = new Set(teamsView().map((t) => t.id));
  for (const [team, ch] of chans) if (!want.has(team)) { ch.close(); chans.delete(team); }
  for (const team of want) {
    if (chans.has(team)) continue;
    chans.set(team, teamChannel<any>(team, "requests", {
      joined: (m) => hello(team, m),
      message: (msg: Msg, from) => onMsg(team, msg, from),
    }));
  }
}

function hello(team: string, m: Member) {
  if (!col) return;
  for (const w of shared(col)) if (w.teamId === team) void chans.get(team)?.send({ t: "digest", ws: w.id, d: digest(meta[w.id] ?? {}), ask: true }, m.id);
}

function onMsg(team: string, msg: Msg, from: Member) {
  if (!col || stopped || !msg || !validId(msg.ws)) return;
  if (msg.t === "digest" && (!msg.d || typeof msg.d !== "object" || !Object.values(msg.d).every((v) => Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "string"))) return;
  const w = col.workspaces.find((x) => x.id === msg.ws);
  // A workspace of this Deck's that is not shared with this team is never touched by it, and one
  // this Deck had and deleted (its revisions are still kept) does not come back.
  if (w ? w.teamId !== team : meta[msg.ws]) return;
  const m = meta[msg.ws] ?? {};
  const ch = chans.get(team);
  if (msg.t === "digest") {
    const keys = w ? newerThan(m, msg.d) : [];
    if (keys.length) void ch?.send({ t: "recs", ws: msg.ws, recs: recsFor(col, msg.ws, m, keys) }, from.id);
    if (msg.ask && behind(m, msg.d)) void ch?.send({ t: "digest", ws: msg.ws, d: digest(m), ask: false }, from.id);
  } else if (msg.t === "recs" && Array.isArray(msg.recs)) {
    const r = apply(col, msg.ws, team, m, msg.recs);
    if (!r.changed) return;
    meta[msg.ws] = r.meta;
    saveMeta();
    // Kept here at once, so a digest answered before the next save sends what these records say.
    col = r.col;
    // The same records against the open tab's own state (apply is pure); the tab saves it.
    if (tab) tab((c) => apply(c, msg.ws, team, m, msg.recs).col);
    else void saveCollections(r.col);
  }
}

/** Every save, from the tab or here: what changed in a shared workspace goes to those online. */
function saved(c: Collections) {
  col = c;
  if (stopped || !loadedMeta) return;
  // This Deck's identity only once something is shared: asking makes one.
  if (!me) {
    if (!shared(c).length) return;
    void myTeamId().then((id) => { me = id; saved(col ?? c); }).catch((e) => console.warn("[requests] team sync needs a newer Deck", e));
    return;
  }
  for (const w of shared(c)) {
    const r = localChanges(c, w.id, meta[w.id] ?? {}, me, Date.now());
    if (!r.out.length) continue;
    meta[w.id] = r.meta;
    void chans.get(w.teamId!)?.send({ t: "recs", ws: w.id, recs: r.out });
  }
  saveMeta();
  channels();
}

export async function startTeamSync() {
  stopped = false;
  setSaveHook(saved);
  const [c, t] = await Promise.all([loadCollections(), configRead(META).catch(() => "")]);
  if (stopped) return;
  metaText = t;
  try { meta = t.trim() ? JSON.parse(t) : {}; } catch { meta = {}; }
  loadedMeta = true;
  col = col ?? c;
  // Joining or leaving a team opens or closes its channel; the teams already joined, now.
  unTeams = subscribeTeams(() => channels());
  channels();
  // Edits made while no one was connected (or before this ran) are counted now.
  saved(col ?? c);
}

export function stopTeamSync() {
  stopped = true;
  setSaveHook(null);
  unTeams?.();
  unTeams = null;
  for (const ch of chans.values()) ch.close();
  chans.clear();
}

/** The Requests tab, while open, takes what arrives into its own state. */
export function attachTab(f: (patch: (c: Collections) => Collections) => void): () => void {
  tab = f;
  return () => { if (tab === f) tab = null; };
}

/** Who is online in a workspace's team, for the line under its name. */
export const teamOnline = (team: string): Member[] => chans.get(team)?.online() ?? [];

/** The revisions of requests sent here since a teammate changed them, by "<ws>:<id>". */
const acked = new Map<string, number>();

/**
 * Who last changed a request in a shared workspace, when that was a teammate and it has not been
 * sent from here since: a teammate's change (its address, its scripts, a header) runs here with this
 * Deck's environment values and credentials, so it is shown before it is sent. Null otherwise.
 */
export function teammateChange(id: string): { name: string; key: string; t: number } | null {
  for (const [ws, m] of Object.entries(meta)) {
    const e = m[`r:${id}`];
    if (!e || e.del || (me && e.by === me) || acked.get(`${ws}:${id}`) === e.t) continue;
    const name = teamsView().flatMap((t) => t.members).find((x) => x.id === e.by)?.name ?? "A teammate";
    return { name, key: `${ws}:${id}`, t: e.t };
  }
  return null;
}
/** The person sending said yes to this version of the request: it is not asked about again. */
export const acknowledge = (c: { key: string; t: number }) => void acked.set(c.key, c.t);
