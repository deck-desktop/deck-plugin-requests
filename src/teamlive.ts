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
import { loadCollections, readWorkspaceFolder, saveCollections, setSaveHook, withWorkspace, type Collections } from "./httpclient";
import { onFolderChange } from "./folderstore";
import { apply, behind, digest, localChanges, newerThan, recsFor, type Meta, type Rec } from "./teamsync";

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
let unFolders: (() => void) | null = null;
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
  if (!col || stopped || !msg || typeof msg.ws !== "string") return;
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
  // A folder workspace changed underneath (a git pull) while no tab is open: what changed goes to
  // the team. With the tab open, the tab reads it and its save does the same.
  unFolders = onFolderChange((root) => {
    const w = col?.workspaces.find((x) => x.folder === root);
    if (!w || tab) return;
    void readWorkspaceFolder(w).then((parts) => { if (parts && col) saved(withWorkspace(col, w.id, parts)); })
      .catch((e) => console.warn("[requests] reading the changed workspace folder failed", e));
  });
  // Edits made while no one was connected (or before this ran) are counted now.
  saved(col ?? c);
}

export function stopTeamSync() {
  stopped = true;
  setSaveHook(null);
  unTeams?.();
  unTeams = null;
  unFolders?.();
  unFolders = null;
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
