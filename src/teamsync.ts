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
import type { Auth, BodyKind, Collections, Folder, Request, Row } from "./httpclient";
import { joinRequest, splitEnv, splitRequest, validId } from "./secrets";

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
  out.set("w", { name: w.name, ...(w.owner ? { owner: w.owner } : {}) });
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

// ---- what a record from another Deck may hold ----
//
// A teammate's Deck is trusted to be a teammate, not to be well-behaved: a record is rebuilt from
// the fields it should have, of the types they should be, within sizes, or refused. Its revision may
// not be from far in the future (it would win over every edit for good), and a form row that
// uploads a file arrives without its path: a path names a file on the sender's machine, and sent
// from here it would upload whatever this machine has there.

/** How far ahead of this machine's clock a revision may be: clocks drift, but not by days. */
const FUTURE = 10 * 60_000;
const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : null);
const METHODS = /^[A-Z]{1,16}$/;
const BODY_KINDS: BodyKind[] = ["none", "json", "text", "form"];

function rows(v: unknown, files: boolean): Row[] | null {
  if (!Array.isArray(v) || v.length > 500) return null;
  const out: Row[] = [];
  for (const x of v) {
    const key = str(x?.key, 1000), value = str(x?.value, 100_000);
    if (key === null || value === null) return null;
    const file = files && x.kind === "file";
    out.push({ on: x.on !== false, key, value: file ? "" : value, ...(file ? { kind: "file" as const } : {}),
      ...(file && str(x.filename, 300) ? { filename: x.filename } : {}), ...(file && str(x.contentType, 200) ? { contentType: x.contentType } : {}) });
  }
  return out;
}

function auth(v: unknown): Auth | null {
  const a = v as { kind?: unknown; token?: unknown; user?: unknown; pass?: unknown } | null;
  if (a?.kind === "none") return { kind: "none" };
  if (a?.kind === "bearer") { const token = str(a.token, 10_000); return token === null ? null : { kind: "bearer", token }; }
  if (a?.kind === "basic") { const user = str(a.user, 1000), pass = str(a.pass, 10_000); return user === null || pass === null ? null : { kind: "basic", user, pass }; }
  return null;
}

function request(id: string, d: any): (Request & { parent: string | null }) | null {
  const name = str(d?.name, 300), url = str(d?.url, 8000), method = str(d?.method, 16), body = str(d?.body ?? "", 5_000_000);
  const headers = rows(d?.headers, false), params = rows(d?.params ?? [], false), pathParams = rows(d?.pathParams ?? [], false), formRows = rows(d?.formRows ?? [], true);
  const a = auth(d?.auth ?? { kind: "none" });
  const pre = d?.preScript === undefined ? "" : str(d.preScript, 200_000), post = d?.postScript === undefined ? "" : str(d.postScript, 200_000);
  if (name === null || url === null || method === null || !METHODS.test(method) || body === null || !headers || !params || !pathParams
    || !formRows || !a || pre === null || post === null || !BODY_KINDS.includes(d?.bodyKind)) return null;
  const parent = d?.parent === null || d?.parent === undefined ? null : validId(d.parent) ? d.parent : undefined;
  if (parent === undefined) return null;
  return { id, name, method: method as Request["method"], url, headers, params, pathParams, bodyKind: d.bodyKind, body, formRows, auth: a,
    ...(pre ? { preScript: pre } : {}), ...(post ? { postScript: post } : {}), parent };
}

/** A record from another Deck as this one will take it, or null when it is not one. */
export function cleanRec(r: unknown, now: number): Rec | null {
  const x = r as Rec | null;
  if (!x || typeof x.k !== "string" || !x.rev || typeof x.rev.t !== "number" || !Number.isFinite(x.rev.t) || x.rev.t <= 0
    || x.rev.t > now + FUTURE || str(x.rev.by, 64) === null || (x.del !== undefined && typeof x.del !== "boolean")) return null;
  const rev = { t: x.rev.t, by: x.rev.by };
  const [kind, id] = x.k === "w" ? ["w", ""] : x.k.split(/:(.*)/s);
  if (kind !== "w" && !validId(id)) return null;
  if (x.del) return kind === "w" ? null : { k: x.k, rev, del: true };
  const d = x.d as any;
  if (kind === "w") {
    const name = str(d?.name, 300), owner = d?.owner === undefined ? "" : str(d.owner, 64);
    const end = d?.end === undefined ? undefined : d.end === "stop" || d.end === "delete" ? d.end : null;
    if (name === null || owner === null || end === null) return null;
    return { k: "w", rev, d: { name, ...(owner ? { owner } : {}), ...(end ? { end } : {}) } };
  }
  if (kind === "f") {
    const name = str(d?.name, 300);
    const parentId = d?.parentId === null || d?.parentId === undefined ? null : validId(d.parentId) ? d.parentId : undefined;
    if (name === null || parentId === undefined || !Array.isArray(d?.children) || d.children.length > 5000 || !d.children.every(validId)) return null;
    return { k: x.k, rev, d: { id, name, parentId, children: [...d.children] } };
  }
  if (kind === "r") { const req = request(id, d); return req ? { k: x.k, rev, d: req } : null; }
  if (kind === "e") {
    const name = str(d?.name, 300);
    if (name === null || !Array.isArray(d?.vars) || d.vars.length > 1000) return null;
    const vars = d.vars.map((v: any) => (str(v?.key, 1000) === null ? null : { on: v.on !== false, key: v.key }));
    return vars.includes(null) ? null : { k: x.k, rev, d: { id, name, vars } };
  }
  return null;
}

/** Whether member `who` may stop sharing a workspace, or delete it for everyone: who shared it, or
 *  the team's owner. */
export const mayManage = (owner: string | undefined, who: string, teamOwner: string | undefined) =>
  !!who && (who === owner || who === teamOwner);

/**
 * Take another Deck's records that are newer than this one's. A workspace this Deck does not have
 * yet is made, shared with `team`. What this Deck keeps for itself stays: a variable's value, and a
 * credential the other side did not send.
 */
export function apply(c: Collections, ws: string, team: string, meta: Meta, given: unknown[], now = Date.now(), teamOwner?: string): { col: Collections; meta: Meta; changed: boolean } {
  // Only records that are what they say (cleanRec), and not more of them than a workspace holds.
  const recs = given.slice(0, 20_000).flatMap((r) => cleanRec(r, now) ?? []);
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
  // Sharing ended by whoever may end it: "stop" leaves this Deck a copy of its own, "delete" takes it.
  let end: "stop" | "delete" | null = null;
  const owner = c.workspaces.find((w) => w.id === ws)?.owner;
  const parents = new Map<string, string>();
  for (const r of recs) {
    if (!newer(r.rev, next[r.k])) continue;
    // An end from anyone else is not taken at all, so it cannot win over a later one that is.
    const wd = r.k === "w" ? (r.d as { name?: string; owner?: string; end?: "stop" | "delete" } | undefined) : undefined;
    if (wd?.end && !mayManage(owner ?? wd.owner, r.rev.by, teamOwner)) continue;
    next[r.k] = { ...r.rev, h: r.del ? "" : hash(r.d), ...(r.del ? { del: true } : {}) };
    changed = true;
    const [kind, id] = r.k.split(/:(.*)/s);
    if (kind === "w") {
      if (r.del) continue;
      wsName = String(wd?.name ?? "Shared");
      if (wd?.end) end = wd.end;
      // A workspace new here is the sharer's: who that is comes with it, and never changes after.
      if (!owner && wd?.owner) col = { ...col, workspaces: col.workspaces.map((w) => (w.id === ws && !w.owner ? { ...w, owner: wd.owner } : w)) };
      continue;
    }
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
  if (end === "stop") col = { ...col, workspaces: col.workspaces.map((w) => (w.id === ws ? { ...w, teamId: undefined } : w)) };
  if (end === "delete") {
    const gone = new Set(col.folders.filter((f) => f.workspaceId === ws).map((f) => f.id));
    const kids = new Set(col.folders.filter((f) => gone.has(f.id)).flatMap((f) => f.children));
    const rest = col.workspaces.filter((w) => w.id !== ws);
    col = {
      ...col,
      workspaces: rest,
      activeWorkspaceId: col.activeWorkspaceId === ws ? rest[0]?.id ?? null : col.activeWorkspaceId,
      folders: col.folders.filter((f) => !gone.has(f.id)),
      requests: Object.fromEntries(Object.entries(col.requests).filter(([id]) => !kids.has(id))),
      environments: col.environments.filter((e) => e.workspaceId !== ws),
    };
  }
  return { col, meta: next, changed: true };
}
