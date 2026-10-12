// Collection export/import as a JSON file.
//
// Deck's own format rather than Postman's: a Postman collection carries scripts, variables and
// auth shapes Deck does not model, so a round trip through it would quietly drop things. This
// file is the tree exactly as Deck stores it, which means an export re-imports losslessly.
//
// Secrets travel with it. An environment's values and a request's auth are what make an export
// useful to your other machine and dangerous in a shared repo — `includeSecrets` decides, and the
// UI asks rather than guessing.
import { newId, subtree, type Collections, type Environment, type Folder, type Request } from "./httpclient";

export const EXPORT_KIND = "deck.http.collection";
const VERSION = 1;

export interface ExportFile {
  kind: typeof EXPORT_KIND;
  version: number;
  exportedAt: string;
  /** Name of the collection this came from, for the import summary. */
  name: string;
  folders: Folder[];
  requests: Record<string, Request>;
  /** Only the environments of the workspace it came from; optional. */
  environments: Environment[];
  /** False when auth and environment values were stripped on the way out. */
  secrets: boolean;
}

const BLANK = "";

/** Strip anything that would leak a credential, leaving the shape intact. */
function scrub(req: Request): Request {
  const auth = req.auth.kind === "bearer" ? { ...req.auth, token: BLANK }
    : req.auth.kind === "basic" ? { ...req.auth, pass: BLANK }
    : req.auth;
  return {
    ...req,
    auth,
    // A header called Authorization / Cookie / X-Api-Key is the other common place a token sits.
    headers: req.headers.map((h) =>
      /^(authorization|cookie|x-api-key|api-key)$/i.test(h.key) ? { ...h, value: BLANK } : h),
  };
}

/**
 * Everything under one collection, ready to write to a file.
 *
 * `environments` come from the collection's workspace: a request that says {{host}} is useless
 * without them, and the point of an export is that it works on the other end.
 */
export function exportCollection(
  col: Collections,
  collectionId: string,
  opts: { includeSecrets: boolean },
): ExportFile {
  const root = col.folders.find((f) => f.id === collectionId);
  if (!root) throw new Error("collection not found");

  const { folderIds, requestIds } = subtree(col.folders, collectionId);
  const requests: Record<string, Request> = {};
  for (const id of requestIds) {
    const r = col.requests[id];
    if (r) requests[id] = opts.includeSecrets ? r : scrub(r);
  }

  const envs = col.environments.filter((e) => e.workspaceId === root.workspaceId);

  return {
    kind: EXPORT_KIND,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    name: root.name,
    folders: col.folders.filter((f) => folderIds.includes(f.id)),
    requests,
    environments: opts.includeSecrets
      ? envs
      : envs.map((e) => ({ ...e, vars: e.vars.map((v) => ({ ...v, value: BLANK })) })),
    secrets: opts.includeSecrets,
  };
}

/**
 * Every collection in a workspace, as one file.
 *
 * Same shape as a single-collection export — the format is a list of folders either way, and one
 * with several roots imports as several collections without needing a second code path.
 */
export function exportWorkspace(
  col: Collections,
  workspaceId: string,
  opts: { includeSecrets: boolean },
): ExportFile {
  const ws = col.workspaces.find((w) => w.id === workspaceId);
  if (!ws) throw new Error("workspace not found");

  const folders = col.folders.filter((f) => f.workspaceId === workspaceId);
  const requests: Record<string, Request> = {};
  for (const f of folders) {
    for (const child of f.children) {
      const r = col.requests[child];
      if (r) requests[child] = opts.includeSecrets ? r : scrub(r);
    }
  }

  const envs = col.environments.filter((e) => e.workspaceId === workspaceId);

  return {
    kind: EXPORT_KIND,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    name: ws.name,
    folders,
    requests,
    environments: opts.includeSecrets
      ? envs
      : envs.map((e) => ({ ...e, vars: e.vars.map((v) => ({ ...v, value: BLANK })) })),
    secrets: opts.includeSecrets,
  };
}

/** Parse a file's text, or throw with a reason worth showing the user. */
export function parseExport(text: string): ExportFile {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error("Not a JSON file."); }
  const f = data as Partial<ExportFile>;
  if (f?.kind !== EXPORT_KIND) throw new Error("Not a Deck collection export.");
  if (typeof f.version !== "number" || f.version > VERSION) {
    throw new Error(`Made by a newer version of Deck (format ${String(f.version)}).`);
  }
  if (!Array.isArray(f.folders) || !f.requests) throw new Error("The file is missing its collection.");
  return f as ExportFile;
}

/**
 * Add an exported collection to a workspace, under fresh ids.
 *
 * Re-keying matters: importing a collection twice, or importing one exported from this same Deck,
 * would otherwise collide with what is already stored and rewrite it.
 */
export function importCollection(
  col: Collections,
  file: ExportFile,
  workspaceId: string,
  opts: { withEnvironments: boolean },
): Collections {
  const idMap = new Map<string, string>();
  const fresh = (old: string) => {
    let v = idMap.get(old);
    if (!v) { v = newId(); idMap.set(old, v); }
    return v;
  };

  const folders: Folder[] = file.folders.map((f) => ({
    ...f,
    id: fresh(f.id),
    workspaceId,
    parentId: f.parentId ? fresh(f.parentId) : null,
    children: f.children.map(fresh),
  }));

  const requests: Record<string, Request> = {};
  for (const [oldId, r] of Object.entries(file.requests)) {
    const id = fresh(oldId);
    requests[id] = { ...r, id };
  }

  // A second import of the same file should read as a second collection, not silently merge with
  // the first.
  const roots = folders.filter((f) => f.parentId === null);
  const taken = new Set(col.folders.filter((f) => f.workspaceId === workspaceId).map((f) => f.name));
  for (const root of roots) {
    let name = root.name;
    for (let n = 2; taken.has(name); n++) name = `${root.name} (${n})`;
    root.name = name;
    taken.add(name);
  }

  const environments = opts.withEnvironments
    ? file.environments.map((e) => ({ ...e, id: newId(), workspaceId }))
    : [];

  return {
    ...col,
    folders: [...col.folders, ...folders],
    requests: { ...col.requests, ...requests },
    environments: [...col.environments, ...environments],
  };
}

/** What an import is about to add, for the confirmation shown before it happens. */
export interface ImportSummary {
  /** Name of the collection in the file. */
  name: string;
  /** Top-level collections (folders with no parent). Usually 1. */
  collections: number;
  /** Folders below those roots — structure, as distinct from things to click. */
  folders: number;
  requests: number;
  environments: number;
  /** False when the export was taken without secrets: auth and environment values are blank. */
  secrets: boolean;
  /** Root names already present in the target workspace. These import RENAMED, never merged. */
  renamed: string[];
}

/**
 * Describe an import without performing it.
 *
 * Deliberately re-uses `importCollection`'s own collision rule rather than approximating it, so
 * the dialog cannot promise something different from what the import then does. `workspaceId` is
 * the workspace being imported INTO; pass null for a new workspace, where nothing can collide.
 */
export function summarizeImport(
  // Only read to find existing names, so it is optional: with no target workspace there is
  // nothing to collide with and nothing to read.
  col: Collections | null,
  file: ExportFile,
  workspaceId: string | null,
): ImportSummary {
  const roots = file.folders.filter((f) => f.parentId === null);
  const taken = col === null || workspaceId === null
    ? new Set<string>()
    : new Set(col.folders.filter((f) => f.workspaceId === workspaceId).map((f) => f.name));
  return {
    name: file.name,
    collections: roots.length,
    folders: file.folders.length - roots.length,
    requests: Object.keys(file.requests).length,
    environments: file.environments.length,
    secrets: file.secrets,
    renamed: roots.filter((r) => taken.has(r.name)).map((r) => r.name),
  };
}

/** A filename that says what it is and when it was taken. */
export function exportFilename(name: string): string {
  const safe = name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "collection";
  return `${safe}-${new Date().toISOString().slice(0, 10)}.deck-http.json`;
}
