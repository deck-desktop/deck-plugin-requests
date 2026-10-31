// A workspace kept in a folder: one file per request, a folder per folder, so it can live in a
// project's repository (or OneDrive) and be shared the way that folder is. Pure: the files for a
// workspace, and a workspace from its files. folderstore.ts reads and writes them; the MCP tools
// (mcpstore.ts) do the same through node.
//
//   <folder>/
//     workspace.json            the workspace's id and name, and its collections in order
//     environments/Dev.json     an environment's variables: names and switches, no values
//     Users/                    a collection (or a folder in one)
//       folder.json             its id and name, and its children in order
//       Get user.json           a request
//       Admin/folder.json ...   a folder inside it
//
// Ids are in the files; names only make them readable, so a rename moves a file and a duplicate
// name gets the id after it. What a file names its children by is their id, so a reordered or
// merged folder still knows its own. Anything a folder.json does not list (a file added by hand, or
// by someone else in a merge) is still loaded, after the ones it lists.
//
// Secrets never go in the folder (secrets.ts): they stay on this Deck, in WsSecrets.
import type { Environment, Folder, Request } from "./httpclient";
import { joinEnv, joinRequest, splitEnv, splitRequest, type EnvShape, type ReqSecrets } from "./secrets";

/** A folder's files: path relative to it, with "/" → text. */
export type Files = Map<string, string>;
/** What a folder workspace keeps on this Deck: environment values and request credentials. */
export interface WsSecrets { env: Record<string, Record<string, string>>; req: Record<string, ReqSecrets> }
/** A workspace's part of the collections, as a folder holds it. */
export interface WsParts { id: string; name: string; folders: Folder[]; requests: Record<string, Request>; environments: Environment[] }

const MARK = "deck-requests-workspace";
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/** A name that is safe as a Windows file name, and readable. */
export function fileName(name: string): string {
  let s = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/, "").trim();
  if (!s) s = "untitled";
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `_${s}`;
  return s.slice(0, 80);
}

/** The files of workspace `ws` of `parts` (a workspace's folders, requests and environments), and what stays here. */
export function toFiles(parts: WsParts): { files: Files; secrets: WsSecrets } {
  const files: Files = new Map();
  const secrets: WsSecrets = { env: {}, req: {} };
  const byId = new Map(parts.folders.map((f) => [f.id, f]));
  const roots = parts.folders.filter((f) => !f.parentId || !byId.has(f.parentId));
  files.set("workspace.json", json({ deck: MARK, version: 1, id: parts.id, name: parts.name, collections: roots.map((f) => f.id) }));
  /** One name per entry in a directory: a second one with the same name gets its id after it. */
  const unique = (taken: Set<string>, base: string, id: string) => {
    let n = fileName(base);
    if (taken.has(n.toLowerCase())) n = `${n} (${id})`;
    taken.add(n.toLowerCase());
    return n;
  };
  const top = new Set(["workspace.json", "environments"]);
  const write = (f: Folder, dir: string, seen: Set<string>) => {
    if (seen.has(f.id)) return; // a folder listed twice, or inside itself, is written once
    seen.add(f.id);
    files.set(`${dir}/folder.json`, json({ id: f.id, name: f.name, children: f.children }));
    const taken = new Set(["folder.json"]);
    for (const ch of f.children) {
      const sub = byId.get(ch);
      if (sub) { write(sub, `${dir}/${unique(taken, sub.name, sub.id)}`, seen); continue; }
      const r = parts.requests[ch];
      if (!r) continue;
      const { pub, secret } = splitRequest(r);
      if (secret) secrets.req[r.id] = secret;
      files.set(`${dir}/${unique(taken, r.name, r.id)}.json`, json(pub));
    }
  };
  const seen = new Set<string>();
  for (const f of roots) write(f, unique(top, f.name, f.id), seen);
  const envNames = new Set<string>();
  for (const e of parts.environments) {
    const { pub, values } = splitEnv(e);
    if (Object.keys(values).length) secrets.env[e.id] = values;
    files.set(`environments/${unique(envNames, e.name, e.id)}.json`, json(pub));
  }
  return { files, secrets };
}

/** Whether a folder's files are a workspace: its workspace.json says so. */
export function isWorkspace(files: Files): boolean {
  try { return JSON.parse(files.get("workspace.json") ?? "").deck === MARK; } catch { return false; }
}

/**
 * The workspace a folder's files hold, with this Deck's secrets put back. Files that are not valid
 * are skipped and named in `skipped`. Null when the folder is not a workspace.
 */
export function fromFiles(files: Files, secrets?: WsSecrets): (WsParts & { skipped: string[] }) | null {
  const skipped: string[] = [];
  const read = <T,>(p: string): T | null => { try { return JSON.parse(files.get(p)!) as T; } catch { skipped.push(p); return null; } };
  const head = read<{ deck?: string; id?: string; name?: string; collections?: string[] }>("workspace.json");
  if (!head || head.deck !== MARK || typeof head.id !== "string") return null;
  const ws = head.id;
  const folders = new Map<string, Folder>();
  const dirOf = new Map<string, string>(); // directory -> folder id
  const requests: Record<string, Request> = {};
  const inDir = new Map<string, string[]>(); // directory -> ids found in it, in file order
  const paths = [...files.keys()].sort();
  // Folders first, by their folder.json.
  for (const p of paths) {
    if (!p.endsWith("/folder.json")) continue;
    const f = read<{ id?: string; name?: string; children?: string[] }>(p);
    if (!f || typeof f.id !== "string") { if (f) skipped.push(p); continue; }
    const dir = p.slice(0, -"/folder.json".length);
    folders.set(f.id, { id: f.id, name: String(f.name ?? dir.split("/").pop()), workspaceId: ws, parentId: null, children: Array.isArray(f.children) ? f.children.filter((x) => typeof x === "string") : [] });
    dirOf.set(dir, f.id);
  }
  const parentDir = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
  for (const [dir, id] of dirOf) {
    const up = dirOf.get(parentDir(dir));
    if (up) { folders.get(id)!.parentId = up; (inDir.get(parentDir(dir)) ?? inDir.set(parentDir(dir), []).get(parentDir(dir))!).push(id); }
  }
  // Then requests: a .json beside a folder.json.
  for (const p of paths) {
    if (p.endsWith("/folder.json") || p === "workspace.json" || p.startsWith("environments/") || !p.endsWith(".json")) continue;
    const dir = parentDir(p);
    if (!dirOf.has(dir)) continue; // not inside a folder of this workspace
    const r = read<Request>(p);
    if (!r || typeof r.id !== "string" || typeof r.url !== "string") { if (r) skipped.push(p); continue; }
    requests[r.id] = joinRequest(normalise(r), secrets?.req[r.id]);
    (inDir.get(dir) ?? inDir.set(dir, []).get(dir)!).push(r.id);
  }
  // Each folder's children: those it lists that exist, then any it does not list.
  for (const [dir, id] of dirOf) {
    const f = folders.get(id)!;
    const here = inDir.get(dir) ?? [];
    const listed = f.children.filter((ch) => here.includes(ch));
    f.children = [...listed, ...here.filter((ch) => !listed.includes(ch))];
  }
  const environments: Environment[] = [];
  for (const p of paths) {
    if (!p.startsWith("environments/") || !p.endsWith(".json")) continue;
    const e = read<EnvShape>(p);
    if (!e || typeof e.id !== "string" || !Array.isArray(e.vars)) { if (e) skipped.push(p); continue; }
    environments.push(joinEnv(e, ws, secrets?.env[e.id]));
  }
  // The collections in the order workspace.json gives, then any it does not list.
  const order = Array.isArray(head.collections) ? head.collections : [];
  const roots = [...folders.values()].filter((f) => f.parentId === null);
  const sorted = [...order.flatMap((id) => roots.filter((f) => f.id === id)), ...roots.filter((f) => !order.includes(f.id))];
  const rest = [...folders.values()].filter((f) => f.parentId !== null);
  return { id: ws, name: String(head.name ?? "Workspace"), folders: [...sorted, ...rest], requests, environments, skipped };
}

/** A request file read back, with whatever a hand edit or an older version left out filled in. */
function normalise(r: Partial<Request> & { id: string; url: string }): Request {
  return {
    id: r.id, name: r.name ?? "Request", method: r.method ?? "GET", url: r.url,
    headers: r.headers ?? [], params: r.params ?? [], pathParams: r.pathParams ?? [],
    bodyKind: r.bodyKind ?? "none", body: r.body ?? "", formRows: r.formRows ?? [], auth: r.auth ?? { kind: "none" },
    ...(r.preScript ? { preScript: r.preScript } : {}), ...(r.postScript ? { postScript: r.postScript } : {}),
  };
}
