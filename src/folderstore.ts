// Workspaces kept in folders, on disk: reading one (folderlayout.ts turns the files into a
// workspace), writing only the files that changed, and noticing when something else changed them
// (a git pull, OneDrive, a hand edit) so the workspace is read again.
//
// What this Deck keeps back from a folder (environment values, credentials) is in its own config,
// folder-secrets, by workspace.
import { configRead, configWrite, fsCreateDir, fsDelete, fsList, fsRead, fsWrite, watchFiles } from "../shim/bridge.js";
import { listen } from "../shim/event.js";
import type { Files, WsSecrets } from "./folderlayout";

const SECRETS = "folder-secrets";
const sep = (root: string) => (root.includes("\\") ? "\\" : "/");
const abs = (root: string, rel: string) => (rel ? root.replace(/[\\/]+$/, "") + sep(root) + rel.split("/").join(sep(root)) : root);

/** What this Deck last read from or wrote to each folder, to write only what changed and to tell its own writes from someone else's. */
const last = new Map<string, Files>();
/** Folders that could not be read: never written, so a folder that was briefly away is not overwritten with nothing. */
const unreadable = new Set<string>();
const busy = new Map<string, Promise<void>>();
/** A folder that could not be read: its workspace stays in the collections file until it can. */
export const folderAway = (root: string) => unreadable.has(root);

/**
 * A folder's own directories are walked; a repository's others (.git, node_modules, a src folder)
 * are not. `look`: only looking (is there a workspace here?), so a folder that is not there yet is
 * not counted as one that went away.
 */
export async function readFolder(root: string, look = false): Promise<Files> {
  const files: Files = new Map();
  const walk = async (dir: string, rel: string) => {
    const entries = await fsList(dir, true);
    const mine = !rel || entries.some((e) => !e.dir && e.name === "folder.json") || rel === "environments";
    if (!mine) return;
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.dir) { if (!e.name.startsWith(".") && e.name !== "node_modules") await walk(e.path, r); }
      else if (e.name.endsWith(".json")) files.set(r, await fsRead(e.path));
    }
  };
  try {
    await walk(root, "");
    unreadable.delete(root);
  } catch (e) {
    if (!look) unreadable.add(root);
    throw e;
  }
  last.set(root, files);
  return files;
}

const dirsOf = (files: Files) => {
  const out = new Set<string>();
  for (const p of files.keys()) { const parts = p.split("/"); for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/")); }
  return out;
};

/** Write a workspace's files: only those that changed; those it no longer has go, and so does a directory left empty. */
export function writeFolder(root: string, files: Files): Promise<void> {
  const run = async () => {
    if (unreadable.has(root)) throw new Error(`${root} could not be read`);
    const prev = last.get(root) ?? new Map<string, string>();
    quiet.set(root, Date.now() + 1500);
    await fsCreateDir(root, "").catch(() => {});
    const had = dirsOf(prev);
    for (const d of [...dirsOf(files)].sort()) if (!had.has(d)) await fsCreateDir(root, d.split("/").join(sep(root))).catch(() => {});
    for (const [p, t] of files) if (prev.get(p) !== t) await fsWrite(abs(root, p), t);
    for (const p of prev.keys()) if (!files.has(p)) await fsDelete(abs(root, p)).catch((e) => console.warn("[requests] removing a file from the workspace folder failed", e));
    const keep = dirsOf(files);
    for (const d of [...had].filter((x) => !keep.has(x)).sort((a, b) => b.length - a.length)) {
      // Only when nothing else is in it: a folder someone put their own files in stays.
      const left = await fsList(abs(root, d), true).catch(() => null);
      if (left && !left.length) await fsDelete(abs(root, d)).catch(() => {});
    }
    last.set(root, new Map(files));
    quiet.set(root, Date.now() + 800);
    watch();
  };
  const next = (busy.get(root) ?? Promise.resolve()).then(run, run);
  busy.set(root, next.catch(() => {}));
  return next;
}

// ---- this Deck's secrets for its folder workspaces ----

let secrets: Record<string, WsSecrets> | null = null;
let secretsText = "";
export async function loadSecrets(): Promise<Record<string, WsSecrets>> {
  if (secrets) return secrets;
  secretsText = await configRead(SECRETS).catch(() => "");
  try { secrets = secretsText.trim() ? JSON.parse(secretsText) : {}; } catch { secrets = {}; }
  return secrets!;
}
export async function saveSecrets(ws: string, s: WsSecrets) {
  const all = await loadSecrets();
  all[ws] = s;
  const t = JSON.stringify(all);
  if (t === secretsText) return;
  secretsText = t;
  await configWrite(SECRETS, t).catch((e) => console.warn("[requests] saving the folder workspace secrets failed", e));
}

// ---- noticing changes made elsewhere ----

/** Until when a folder's changes are this Deck's own writing. */
const quiet = new Map<string, number>();
let roots: string[] = [];
const subs = new Set<(root: string) => void>();
let unlisten: Promise<() => void> | null = null;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Watch these folders (each one's directories: the watcher does not go into subfolders by itself). */
export function watchFolders(next: string[]) {
  roots = next;
  watch();
}
function watch() {
  const paths = roots.flatMap((r) => [r, ...[...dirsOf(last.get(r) ?? new Map())].map((d) => abs(r, d))]);
  void watchFiles(paths, "requests-folders").catch((e) => console.warn("[requests] watching the workspace folders failed", e));
  if (roots.length && !unlisten) unlisten = listen<string>("fs-changed", (e) => changed(e.payload));
}
function changed(path: string) {
  const p = path.toLowerCase();
  const root = roots.find((r) => p.startsWith(r.toLowerCase()));
  if (!root) return;
  clearTimeout(timers.get(root));
  // One reading per burst (a pull changes many files at once), after this Deck's own writing.
  timers.set(root, setTimeout(() => void (async () => {
    if ((quiet.get(root) ?? 0) > Date.now()) return;
    const before = last.get(root);
    const now = await readFolder(root).catch(() => null);
    if (!now || (before && same(before, now))) return;
    subs.forEach((f) => f(root));
  })(), 400));
}
const same = (a: Files, b: Files) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** Told when a folder changed underneath: read the workspace again. */
export function onFolderChange(f: (root: string) => void): () => void {
  subs.add(f);
  return () => { subs.delete(f); };
}
/** The files last read from a folder, so a change seen here need not read it again. */
export const lastRead = (root: string) => last.get(root);

export function stopFolders() {
  roots = [];
  void watchFiles([], "requests-folders").catch(() => {});
  void unlisten?.then((f) => f());
  unlisten = null;
  timers.forEach(clearTimeout);
}
