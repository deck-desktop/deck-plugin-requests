// The Requests plugin's model for its MCP tools (mcp.ts): CRUD over workspaces, collections,
// folders, requests and environments. Moved here from Deck's MCP server with the plugin.
//
// Same contract as the rest of the server: edit the JSON file Deck watches and let its
// file-watcher apply the change live. The file is read and written through the server's own
// helpers, handed in by init(), so the path is resolved in exactly one place (and follows DECK_DEV).
import type { DeckMcp } from "../shim/mcp.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromFiles, safePath, toFiles, type Files, type WsParts, type WsSecrets } from "./folderlayout";

let deck: DeckMcp;
const readJson = <T,>(name: string, fallback: T): T => deck.readJson(name, fallback);
const writeJson = (name: string, data: unknown) => deck.writeJson(name, data);

// Names, not paths.
const FILE = "requests-collections";
const SETTINGS = "settings";

// ---- the model (mirrors src/core/httpclient.ts) ----

export interface KeyVal { on: boolean; key: string; value: string }
export type BodyKind = "none" | "json" | "text" | "form";
export type Auth =
  | { kind: "none" }
  | { kind: "bearer"; token: string }
  | { kind: "basic"; user: string; pass: string };

export interface Request {
  id: string;
  name: string;
  method: string;
  url: string;
  params: KeyVal[];
  pathParams: KeyVal[];
  headers: KeyVal[];
  bodyKind: BodyKind;
  body: string;
  formRows: KeyVal[];
  auth: Auth;
  /** JavaScript run before the send / on the response. See the deck-http skill for the pm API. */
  preScript?: string;
  postScript?: string;
}

export interface Folder {
  id: string;
  name: string;
  workspaceId: string;
  parentId: string | null;
  children: string[];
}

export interface Environment {
  id: string;
  name: string;
  vars: KeyVal[];
  workspaceId: string;
}

export interface Workspace { id: string; name: string; activeEnvId: string | null; teamId?: string; folder?: string }

export interface Collections {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  folders: Folder[];
  requests: Record<string, Request>;
  environments: Environment[];
}

export function read(): Collections {
  // Each field defaulted rather than trusting the file: a half-written or hand-edited
  // collections file should read as empty, not crash every tool that touches it.
  const f = readJson<Partial<Collections>>(FILE, {});
  let c: Collections = {
    workspaces: f.workspaces ?? [],
    activeWorkspaceId: f.activeWorkspaceId ?? null,
    folders: f.folders ?? [],
    requests: f.requests ?? {},
    environments: f.environments ?? [],
  };
  // A workspace kept in a folder (folderlayout.ts) is read from it, as the app reads it.
  const secrets = readJson<Record<string, WsSecrets>>(SECRETS, {});
  for (const w of c.workspaces) {
    if (!w.folder) continue;
    try {
      const parts = fromFiles(readFolder(w.folder), secrets[w.id]);
      if (parts) c = withWorkspace(c, w.id, { ...parts, id: w.id } as unknown as WsParts);
    } catch { /* a folder that is away reads as empty, and is not written */ }
  }
  return c;
}

export function write(c: Collections) {
  const secrets = readJson<Record<string, WsSecrets>>(SECRETS, {});
  let file = c;
  for (const w of c.workspaces) {
    if (!w.folder || !existsSync(w.folder)) continue;
    const { files, secrets: kept } = toFiles(partsOf(c, w.id) as unknown as WsParts);
    writeFolder(w.folder, files);
    secrets[w.id] = kept;
    file = withWorkspace(file, w.id, { id: w.id, name: w.name, folders: [], requests: {}, environments: [] });
  }
  if (c.workspaces.some((w) => w.folder)) writeJson(SECRETS, secrets);
  writeJson(FILE, file);
}

// ---- workspaces kept in a folder, through node (the app does it through the bridge, folderstore.ts) ----

const SECRETS = "folder-secrets";

/** A folder's own files: its directories with a folder.json, and environments/. */
function readFolder(root: string): Files {
  const files: Files = new Map();
  const walk = (dir: string, rel: string) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (rel && rel !== "environments" && !entries.some((e) => e.isFile() && e.name === "folder.json")) return;
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!e.name.startsWith(".") && e.name !== "node_modules") walk(join(dir, e.name), r); }
      else if (e.name.endsWith(".json")) files.set(r, readFileSync(join(dir, e.name), "utf8"));
    }
  };
  walk(root, "");
  return files;
}

/** Write what changed, and take away the workspace's files it no longer has. */
function writeFolder(root: string, files: Files) {
  const prev = readFolder(root);
  for (const [rel, text] of files) {
    if (!safePath(rel)) continue; // only paths that stay inside the folder
    if (prev.get(rel) === text) continue;
    const at = join(root, ...rel.split("/"));
    mkdirSync(join(at, ".."), { recursive: true });
    writeFileSync(at, text, "utf8");
  }
  for (const rel of prev.keys()) if (!files.has(rel)) rmSync(join(root, ...rel.split("/")), { force: true });
}

function partsOf(c: Collections, ws: string) {
  const w = c.workspaces.find((x) => x.id === ws);
  const folders = c.folders.filter((f) => f.workspaceId === ws);
  const requests: Record<string, Request> = {};
  for (const f of folders) for (const ch of f.children) if (c.requests[ch]) requests[ch] = c.requests[ch];
  return { id: ws, name: w?.name ?? "Workspace", folders, requests, environments: c.environments.filter((e) => e.workspaceId === ws) };
}

function withWorkspace(c: Collections, ws: string, parts: WsParts): Collections {
  const old = partsOf(c, ws);
  const requests = { ...c.requests };
  for (const id of Object.keys(old.requests)) delete requests[id];
  Object.assign(requests, parts.requests);
  return {
    ...c,
    workspaces: c.workspaces.map((w) => (w.id === ws ? { ...w, name: parts.name } : w)),
    folders: [...c.folders.filter((f) => f.workspaceId !== ws), ...parts.folders.map((f) => ({ ...f, workspaceId: ws }))],
    requests,
    environments: [...c.environments.filter((e) => e.workspaceId !== ws), ...parts.environments.map((e) => ({ ...e, workspaceId: ws }))],
  } as Collections;
}

/**
 * Whether environment values may be returned in full.
 *
 * Off by default: these hold API tokens, and a listing that includes them puts them into the
 * conversation and its logs. Hasan turns it on in Deck's Settings (httpMcpRevealSecrets).
 */
export function revealAllowed(): boolean {
  return readJson<Record<string, unknown>>(SETTINGS, {}).httpMcpRevealSecrets === true;
}

export const mask = (v: string) => (v ? "••••" : "");

const rid = () => `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export const newRequestId = rid;

export function newRequest(name = "New Request"): Request {
  return {
    id: rid(), name, method: "GET", url: "",
    params: [], pathParams: [], headers: [], bodyKind: "none", body: "", formRows: [],
    auth: { kind: "none" },
  };
}

// ---- tree helpers (mirror the app's, so a move made here is the same shape) ----

export const parentOf = (folders: Folder[], id: string) =>
  folders.find((f) => f.children.includes(id)) ?? null;

/** Is `id` the same as `ancestorId`, or somewhere beneath it? */
export function isInside(folders: Folder[], id: string, ancestorId: string): boolean {
  let cur: string | null = id;
  while (cur) {
    if (cur === ancestorId) return true;
    cur = folders.find((f) => f.id === cur)?.parentId ?? null;
  }
  return false;
}

/** Every folder and request id at or beneath `id`. */
export function subtree(c: Collections, id: string): string[] {
  const out = [id];
  const f = c.folders.find((x) => x.id === id);
  if (f) for (const child of f.children) out.push(...subtree(c, child));
  return out;
}

// ---- zod pieces shared by the tools ----
//
// Built from the server's zod (a bundled copy would make schemas the server cannot read), which
// exists only once register() hands it over: hence built in init() rather than at import.

const makeKeyVal = (z: DeckMcp["z"]) => z.object({
  on: z.boolean().default(true),
  key: z.string(),
  value: z.string().default(""),
});

/**
 * A form-body row, which unlike a header or query row can carry a file.
 *
 * Strict on purpose. Zod drops unknown keys silently by default, so a misspelled or invented
 * field used to be accepted and then ignored — the request went out missing what the caller
 * thought they had set, and the only symptom was a confusing error from the far end. Rejecting
 * here costs one round trip instead of one debugging session.
 */
const makeFormRow = (z: DeckMcp["z"]) => z.object({
  on: z.boolean().default(true),
  key: z.string(),
  value: z.string().default("")
    .describe('For kind "file", the path to upload. Otherwise the text value.'),
  kind: z.enum(["text", "file"]).optional()
    .describe(
      'Defaults to "text". "file" reads `value` as a local path and uploads it as a real ' +
      "multipart file part; one file row makes the entire body multipart/form-data.",
    ),
  filename: z.string().optional()
    .describe("File rows only. The name sent to the server. Defaults to the file's own name."),
  contentType: z.string().optional()
    .describe("File rows only. Defaults to a type guessed from the file extension."),
}).strict();

export let keyVal: ReturnType<typeof makeKeyVal>;
export let formRow: ReturnType<typeof makeFormRow>;

/** Hand over the server's helpers. Called first thing in register(). */
export function init(d: DeckMcp) {
  deck = d;
  keyVal = makeKeyVal(d.z);
  formRow = makeFormRow(d.z);
}

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
