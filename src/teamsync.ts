// A shared workspace kept in step with a team's members (Deck's teams), as records: the workspace's
// name, each folder, each request, each environment. Pure: what changed here, what to send, and
// what to take from someone else. teamlive.ts runs it over the team's channel.
//
// Each record carries a revision (a time and who made it); the newer one wins, record by record, so
// two people editing different requests never clash, and two editing the same one end with the
// later edit. A deleted record leaves a tombstone, so a copy that has not heard of the delete yet
// does not bring it back.
//
// What never leaves this Deck is secrets.ts's to say (environment values, credentials). A record's
// hash is of what is sent, so changing a secret here is not a change to send.
import type { Collections, Folder, Request } from "./httpclient";
import { joinRequest, splitEnv, splitRequest } from "./secrets";

export interface Rev { t: number; by: string }
export interface MetaEntry extends Rev { h: string; del?: boolean }
/** One workspace's records, by key ("w", "f:<id>", "r:<id>", "e:<id>"). */
export type Meta = Record<string, MetaEntry>;
export interface Rec { k: string; rev: Rev; del?: boolean; d?: unknown }

/** A request as it is sent: without its credentials, with the folder it is in. */
const sendable = (r: Request, parent: string | null) => ({ ...splitRequest(r).pub, parent });

/** Every record of a workspace, as it would be sent. */
export function records(c: Collections, ws: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const w = c.workspaces.find((x) => x.id === ws);
  if (!w) return out;
  out.set("w", { name: w.name });
  const parentOf = new Map<string, string>();
  for (const f of c.folders) if (f.workspaceId === ws) for (const ch of f.children) parentOf.set(ch, f.id);
  for (const f of c.folders) {
    if (f.workspaceId !== ws) continue;
    out.set(`f:${f.id}`, { id: f.id, name: f.name, parentId: f.parentId, children: f.children });
    for (const ch of f.children) {
      const r = c.requests[ch];
      if (r) out.set(`r:${r.id}`, sendable(r, f.id));
    }
  }
  for (const e of c.environments) if (e.workspaceId === ws) out.set(`e:${e.id}`, splitEnv(e).pub);
  return out;
}

const hash = (d: unknown) => JSON.stringify(d);
/** Whether revision `a` wins over `b`. */
export const newer = (a: Rev, b?: Rev) => !b || a.t > b.t || (a.t === b.t && a.by > b.by);

/** What changed here since the meta was last brought up to date: new revisions, and the records to send. */
export function localChanges(c: Collections, ws: string, meta: Meta, me: string, now: number): { meta: Meta; out: Rec[] } {
  const next: Meta = { ...meta };
  const out: Rec[] = [];
  const recs = records(c, ws);
  for (const [k, d] of recs) {
    const h = hash(d), m = next[k];
    if (m && !m.del && m.h === h) continue;
    const rev = { t: Math.max(now, (m?.t ?? 0) + 1), by: me };
    next[k] = { ...rev, h };
    out.push({ k, rev, d });
  }
  for (const [k, m] of Object.entries(next)) {
    if (m.del || recs.has(k)) continue;
    const rev = { t: Math.max(now, m.t + 1), by: me };
    next[k] = { ...rev, h: "", del: true };
    out.push({ k, rev, del: true });
  }
  return { meta: next, out };
}

/** Every record's revision, to tell another Deck what this one has. */
export const digest = (meta: Meta): Record<string, [number, string]> =>
  Object.fromEntries(Object.entries(meta).map(([k, m]) => [k, [m.t, m.by]]));
/** The records this Deck has newer than what `theirs` says they have. */
export const newerThan = (meta: Meta, theirs: Record<string, [number, string]>): string[] =>
  Object.entries(meta).filter(([k, m]) => { const t = theirs[k]; return newer(m, t && { t: t[0], by: t[1] }); }).map(([k]) => k);
/** Whether `theirs` has anything newer than this Deck. */
export const behind = (meta: Meta, theirs: Record<string, [number, string]>) =>
  Object.entries(theirs).some(([k, [t, by]]) => newer({ t, by }, meta[k]));
/** The records for some keys, as they are now (a tombstone for a deleted one). */
export function recsFor(c: Collections, ws: string, meta: Meta, keys: string[]): Rec[] {
  const recs = records(c, ws);
  return keys.flatMap((k): Rec[] => {
    const m = meta[k];
    if (!m) return [];
    if (m.del || !recs.has(k)) return [{ k, rev: { t: m.t, by: m.by }, del: true }];
    return [{ k, rev: { t: m.t, by: m.by }, d: recs.get(k) }];
  });
}

/**
 * Take another Deck's records that are newer than this one's. A workspace this Deck does not have
 * yet is made, shared with `team`. What this Deck keeps for itself stays: a variable's value, and a
 * credential the other side did not send.
 */
export function apply(c: Collections, ws: string, team: string, meta: Meta, recs: Rec[]): { col: Collections; meta: Meta; changed: boolean } {
  let col = c;
  const next: Meta = { ...meta };
  let changed = false;
  if (!col.workspaces.some((w) => w.id === ws)) {
    col = { ...col, workspaces: [...col.workspaces, { id: ws, name: "Shared", activeEnvId: null, teamId: team }] };
    changed = true;
  }
  const folders = new Map(col.folders.map((f) => [f.id, f]));
  const requests = { ...col.requests };
  const envs = new Map(col.environments.map((e) => [e.id, e]));
  let wsName: string | null = null;
  const parents = new Map<string, string>();
  for (const r of recs) {
    if (!newer(r.rev, next[r.k])) continue;
    next[r.k] = { ...r.rev, h: r.del ? "" : hash(r.d), ...(r.del ? { del: true } : {}) };
    changed = true;
    const [kind, id] = r.k.split(/:(.*)/s);
    if (kind === "w") { if (!r.del) wsName = String((r.d as { name?: string }).name ?? "Shared"); continue; }
    if (kind === "f") {
      if (r.del) { folders.delete(id); continue; }
      const d = r.d as Pick<Folder, "id" | "name" | "parentId" | "children">;
      folders.set(id, { id, name: d.name, parentId: d.parentId, children: [...d.children], workspaceId: ws });
    } else if (kind === "r") {
      if (r.del) { delete requests[id]; continue; }
      const { parent, ...d } = r.d as Request & { parent: string | null };
      // The credentials this Deck kept stay: the other side did not send them.
      requests[id] = joinRequest(d, c.requests[id] ? splitRequest(c.requests[id]).secret : null);
      if (parent) parents.set(id, parent);
    } else if (kind === "e") {
      if (r.del) { envs.delete(id); continue; }
      const d = r.d as { id: string; name: string; vars: { on: boolean; key: string }[] };
      const mine = envs.get(id);
      envs.set(id, { id, name: d.name, workspaceId: ws, vars: d.vars.map((v) => ({ ...v, value: mine?.vars.find((x) => x.key === v.key)?.value ?? "" })) });
    }
  }
  if (!changed) return { col: c, meta, changed: false };
  // A deleted request or folder leaves no dangling child; one no folder lists yet is added to the
  // folder it came from, so an add that met an older copy of its folder is not lost.
  for (const [fid, f] of folders) {
    if (f.workspaceId !== ws) continue;
    const kids = f.children.filter((ch) => folders.has(ch) || requests[ch]);
    if (kids.length !== f.children.length) folders.set(fid, { ...f, children: kids });
  }
  const listed = new Set([...folders.values()].flatMap((f) => f.children));
  for (const [id, p] of parents) {
    const f = folders.get(p);
    if (f && !listed.has(id)) { folders.set(p, { ...f, children: [...f.children, id] }); listed.add(id); }
  }
  for (const f of folders.values()) {
    const p = f.parentId && folders.get(f.parentId);
    if (p && !listed.has(f.id)) { folders.set(p.id, { ...p, children: [...p.children, f.id] }); listed.add(f.id); }
  }
  // A request left in no folder at all (its folder was deleted) goes.
  const anywhere = new Set([...folders.values()].flatMap((f) => f.children));
  for (const id of Object.keys(requests)) if (!anywhere.has(id)) delete requests[id];
  col = {
    ...col,
    workspaces: col.workspaces.map((w) => (w.id === ws && wsName !== null ? { ...w, name: wsName } : w)),
    folders: [...folders.values()],
    requests,
    environments: [...envs.values()],
  };
  return { col, meta: next, changed: true };
}
