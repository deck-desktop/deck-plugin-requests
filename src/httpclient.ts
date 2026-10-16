// The HTTP client's data model, persistence, and variable substitution.
//
// Collections live in %APPDATA%\Deck\requests-collections.json, on this machine, in Deck's config
// dir like every other config.
import { configRead, configWrite, httpSendAs, httpCancel } from "../shim/bridge.js";
import { dynamicValues } from "./httpdynamic";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type Method = (typeof METHODS)[number];

/** A header/query row. `on` lets a row be kept but skipped, which is why rows aren't a map. */
export interface Row {
  on: boolean;
  key: string;
  value: string;
  /** Form rows only. "file" means `value` is a PATH to upload rather than text, which makes the
   *  whole body multipart/form-data. Absent means text, so collections written before file rows
   *  existed still parse unchanged. */
  kind?: "text" | "file";
  /** File rows only, both optional. Unset, the file's own name is sent and the type is guessed
   *  from its extension. */
  filename?: string;
  contentType?: string;
}

/** One multipart part, shaped for the Rust side. `path` set = send a file. */
export interface FormPart {
  key: string;
  value: string;
  path?: string;
  filename?: string;
  content_type?: string;
}

export type BodyKind = "none" | "json" | "text" | "form";

export interface Request {
  id: string;
  name: string;
  method: Method;
  url: string;
  headers: Row[];
  /** Query params. Kept in sync with the URL's query string in both directions. */
  params: Row[];
  /** Path variables, discovered from /:name segments in the URL. Keys are read-only. */
  pathParams: Row[];
  bodyKind: BodyKind;
  /** Raw text for json/text; ignored for form (which uses formRows). */
  body: string;
  formRows: Row[];
  auth: Auth;
  /**
   * JavaScript run before the request is sent / after the response arrives. Optional so files
   * written before scripts existed load unchanged. Both run in a worker with no network access —
   * see httpscript.worker.ts for why that matters when a collection is imported from a file.
   */
  preScript?: string;
  postScript?: string;
}

/** Only the two schemes worth special-casing; anything else is a header the user types. */
export type Auth =
  | { kind: "none" }
  | { kind: "bearer"; token: string }
  | { kind: "basic"; user: string; pass: string };

/**
 * A node in the collection tree. A collection and a folder are the same thing — a collection is
 * simply one with no parent — so there is no kind flag to keep in sync.
 */
export interface Folder {
  id: string;
  name: string;
  /** Owning workspace. Set on every node, not just roots, so filtering the tree is one test
   *  rather than a walk up to the root on each row. */
  workspaceId: string;
  /** null = a collection, i.e. a root of the tree. */
  parentId: string | null;
  /** Child ids in display order, folders and requests mixed. Resolve against `folders` first,
   *  then `requests`. Order lives here so a move is one list edit. */
  children: string[];
}

/** The old shape, still on disk for anyone who used the first version. */
interface LegacyFolder { id: string; name: string; requestIds?: string[] }

export interface Environment {
  id: string;
  name: string;
  vars: Row[];
  /** Owning workspace. Environments are per-workspace so switching workspace switches the
   *  server and credentials with it — a work API and a local one never share a {{base}}. */
  workspaceId: string;
}

/** A top-level partition: its own collections, its own environments, its own active one. */
export interface Workspace { id: string; name: string; activeEnvId: string | null }

export interface Collections {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  folders: Folder[];
  requests: Record<string, Request>;
  environments: Environment[];
}

export const emptyCollections = (): Collections => ({
  workspaces: [], activeWorkspaceId: null, folders: [], requests: {}, environments: [],
});

export const newId = () => Math.random().toString(36).slice(2, 10);

export const newRequest = (name = "New Request"): Request => ({
  id: newId(), name, method: "GET", url: "", headers: [], params: [], pathParams: [],
  bodyKind: "none", body: "", formRows: [], auth: { kind: "none" },
});

// ---- persistence ------------------------------------------------------------

const STORE = "requests-collections";

export async function loadCollections(): Promise<Collections> {
  // Every path goes through migrate, including the empty one: it is what creates the default
  // workspace, and without a workspace there is nowhere to put a collection — the sidebar's
  // add button would do nothing on a fresh install.
  try {
    const t = await configRead(STORE);
    if (!t.trim()) return migrate(emptyCollections());
    // Spread over the empty shape so a file written by an older version (missing a field added
    // later) loads instead of crashing the module on a property of undefined.
    return migrate({ ...emptyCollections(), ...JSON.parse(t) });
  } catch {
    return migrate(emptyCollections());
  }
}

/**
 * Bring a stored file up to the current shape.
 *
 * The first version had flat folders holding `requestIds`; each of those becomes a root
 * collection whose children are those requests. Idempotent, so it is safe on every load.
 */
export function migrate(c: Collections): Collections {
  // Step 1: flat folders holding requestIds became a nested tree.
  let folders = c.folders.map((f) => {
    const legacy = f as unknown as LegacyFolder;
    if (Array.isArray(f.children) && f.parentId !== undefined) return f;
    return { id: f.id, name: f.name, workspaceId: f.workspaceId, parentId: null, children: legacy.requestIds ?? [] };
  });

  // Step 2: everything gained a workspace. Existing data goes into one default workspace, and
  // its previously-global active environment becomes that workspace's — nothing moves on
  // screen, it just gains a level above it.
  let workspaces = c.workspaces ?? [];
  let activeWorkspaceId = c.activeWorkspaceId ?? null;
  let environments = c.environments ?? [];

  const needsWorkspace = folders.some((f) => !f.workspaceId) || environments.some((e) => !e.workspaceId);
  if (workspaces.length === 0 || needsWorkspace) {
    const ws = workspaces[0] ?? {
      ...newWorkspace("Default"),
      // The pre-workspace shape kept the active environment at the top level.
      activeEnvId: (c as unknown as { activeEnvId?: string | null }).activeEnvId ?? null,
    };
    if (workspaces.length === 0) workspaces = [ws];
    activeWorkspaceId = activeWorkspaceId ?? ws.id;
    folders = folders.map((f) => (f.workspaceId ? f : { ...f, workspaceId: ws.id }));
    environments = environments.map((e) => (e.workspaceId ? e : { ...e, workspaceId: ws.id }));
  }

  // A store that has workspaces but no active one (the last was deleted) still has to open.
  if (!workspaces.some((w) => w.id === activeWorkspaceId)) activeWorkspaceId = workspaces[0]?.id ?? null;

  return { ...c, workspaces, activeWorkspaceId, folders, environments };
}

export const saveCollections = (c: Collections) =>
  configWrite(STORE, JSON.stringify(c, null, 2)).catch((e) => console.warn("[requests] collections save failed", e));

// ---- tree ------------------------------------------------------------------
//
// Moves are where a tree like this goes wrong silently — a node in two parents, or a folder
// dropped inside itself, leaves an unreachable subtree rather than an error. These are pure so
// the check can cover exactly that.

export const newFolder = (name: string, workspaceId: string, parentId: string | null = null): Folder =>
  ({ id: newId(), name, workspaceId, parentId, children: [] });

export const newWorkspace = (name = "New Workspace"): Workspace =>
  ({ id: newId(), name, activeEnvId: null });

/** The folder holding `id`, or null for a root collection / an orphan. */
export function parentOf(folders: Folder[], id: string): Folder | null {
  return folders.find((f) => f.children.includes(id)) ?? null;
}

/** Is `id` the same as `ancestorId`, or somewhere beneath it? */
export function isInside(folders: Folder[], id: string, ancestorId: string): boolean {
  let cur: string | null = id;
  const seen = new Set<string>();
  while (cur) {
    if (cur === ancestorId) return true;
    // A malformed file could contain a cycle; stop rather than spin.
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = folders.find((f) => f.id === cur)?.parentId ?? null;
  }
  return false;
}

/** Every folder and request under `id`, inclusive — for a recursive delete. */
export function subtree(folders: Folder[], id: string): { folderIds: string[]; requestIds: string[] } {
  const folderIds: string[] = [];
  const requestIds: string[] = [];
  const walk = (fid: string) => {
    const f = folders.find((x) => x.id === fid);
    if (!f) return;
    folderIds.push(f.id);
    for (const c of f.children) {
      if (folders.some((x) => x.id === c)) walk(c);
      else requestIds.push(c);
    }
  };
  walk(id);
  return { folderIds, requestIds };
}

/**
 * Move a folder or request into `toFolderId`, optionally before `beforeId`.
 *
 * Refuses to move a folder into itself or its own descendant — that would detach the subtree
 * from every root and it would simply vanish from the tree.
 */
export function moveNode(
  c: Collections, id: string, toFolderId: string, beforeId?: string,
): Collections {
  if (id === toFolderId) return c;
  const isFolder = c.folders.some((f) => f.id === id);
  if (isFolder && isInside(c.folders, toFolderId, id)) return c;
  if (!c.folders.some((f) => f.id === toFolderId)) return c;

  const folders = c.folders.map((f) => {
    let children = f.children.filter((x) => x !== id);
    if (f.id === toFolderId) {
      // Index is computed AFTER the removal, so a reorder inside one folder lands where the
      // user aimed rather than one slot off.
      const at = beforeId ? children.indexOf(beforeId) : -1;
      children = at < 0 ? [...children, id] : [...children.slice(0, at), id, ...children.slice(at)];
    }
    return f.children === children ? f : { ...f, children };
  });

  return {
    ...c,
    folders: isFolder ? folders.map((f) => (f.id === id ? { ...f, parentId: toFolderId } : f)) : folders,
  };
}

/** Move a node to the top level as its own collection. */
export function moveToRoot(c: Collections, id: string): Collections {
  if (!c.folders.some((f) => f.id === id)) return c; // requests must live in a folder
  return {
    ...c,
    folders: c.folders.map((f) =>
      f.id === id ? { ...f, parentId: null } : { ...f, children: f.children.filter((x) => x !== id) }),
  };
}

// ---- variables --------------------------------------------------------------

/**
 * Replace every {{name}} with the active environment's value.
 *
 * Unknown names are left as-is rather than blanked: `{{token}}` visible in a 401 response tells
 * the user their variable is missing, where an empty string looks like a server problem.
 *
 * Single-pass — a value containing {{...}} is not re-expanded. That rules out both accidental
 * and deliberate recursion (a self-referencing var would hang), and nesting has no real use here.
 */
export function substitute(text: string, vars: Record<string, string>): string {
  // $ is allowed so the built-in {{$guid}} / {{$timestamp}} names match too.
  return text.replace(/\{\{\s*(\$?[\w.-]+)\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole);
}

/** The active workspace's active environment, flattened for substitute(). */
export function envVars(c: Collections): Record<string, string> {
  const ws = c.workspaces.find((w) => w.id === c.activeWorkspaceId);
  const env = c.environments.find((e) => e.id === ws?.activeEnvId);
  const out: Record<string, string> = {};
  for (const r of env?.vars ?? []) if (r.on && r.key.trim()) out[r.key.trim()] = r.value;
  return out;
}

// ---- sending ----------------------------------------------------------------

export interface HttpResult {
  status: number;
  status_text: string;
  headers: [string, string][];
  body: string;
  /** Present only when the body is not valid UTF-8 — see http.rs. `body` is lossy in that case,
   *  so this is what a download or an image preview has to use. */
  body_b64?: string;
  size: number;
  truncated: boolean;
  elapsed_ms: number;
}

/** Build the wire-level request: substitute vars, merge params, apply auth. Pure — testable. */
export function buildSend(req: Request, vars: Record<string, string>) {
  const sub = (s: string) => substitute(s, vars);
  const live = (rows: Row[]) => rows.filter((r) => r.on && r.key.trim());

  // The URL is the single source of truth for the query string. The params grid rewrites the URL
  // as it is edited (applyParamsToUrl), so appending every enabled row here would send each one
  // twice, and disabled rows are simply absent from the URL.
  //
  // That invariant holds for anything typed in the app, but a request can also be written from
  // outside it — the MCP tools, an imported collection — and nothing there runs applyParamsToUrl.
  // Such a request has params the URL does not mention, and they used to vanish at send time. So
  // rows the URL is missing are merged in here: present rows stay the URL's business, absent ones
  // are appended.
  let url = sub(req.url.trim());
  const inUrl = new Set(paramsFromUrl(req.url, []).map((r) => r.key));
  const missing = live(req.params).filter((r) => !inUrl.has(r.key.trim()));
  if (missing.length) {
    // Substitute first, then encode — but never encode a {{name}} that had no value, or it
    // becomes %7B%7Bname%7D%7D and can never resolve. Same reasoning as applyParamsToUrl.
    const enc = (text: string) => {
      const done = sub(text);
      return done.includes("{{") ? done : encodeURIComponent(done);
    };
    const qs = missing.map((r) => `${enc(r.key.trim())}=${enc(r.value)}`).join("&");
    const [head, hash = ""] = splitHash(url);
    url = `${head}${head.includes("?") ? "&" : "?"}${qs}${hash ? `#${hash}` : ""}`;
  }

  // Path variables substitute into /:name segments. Done before the query so a value containing
  // "?" cannot smuggle itself into the query string.
  for (const p of live(req.pathParams)) {
    url = url.replace(new RegExp(`/:${escapeRe(p.key)}(?![\\w])`, "g"), `/${encodeURIComponent(sub(p.value))}`);
  }

  const headers: [string, string][] = live(req.headers).map((r) => [sub(r.key), sub(r.value)]);

  // The Auth tab loses to an explicit Authorization header. reqwest's .header() APPENDS (see
  // the note in src-tauri/src/http.rs), so pushing unconditionally sent the header twice —
  // which servers are free to reject or to resolve either way, and which showed up as a
  // duplicated line in Copy as cURL. The typed header wins because it is the more specific
  // thing: the Auth tab is the default for the request, a header is this request's override.
  const hasAuthHeader = headers.some(([k]) => k.trim().toLowerCase() === "authorization");
  if (!hasAuthHeader) {
    if (req.auth.kind === "bearer") {
      headers.push(["Authorization", `Bearer ${sub(req.auth.token)}`]);
    } else if (req.auth.kind === "basic") {
      headers.push(["Authorization", `Basic ${btoa(`${sub(req.auth.user)}:${sub(req.auth.pass)}`)}`]);
    }
  }

  let body: string | null = null;
  let multipart: FormPart[] | null = null;
  if (req.bodyKind === "form") {
    const rows = live(req.formRows);
    // One file row makes the whole body multipart — that is the only way to carry bytes, and a
    // form cannot be half urlencoded. No separate bodyKind for it: the rows say what is needed,
    // and every collection saved before file rows existed keeps working untouched.
    if (rows.some((r) => r.kind === "file")) {
      multipart = rows.map((r) => r.kind === "file"
        // The path is substituted like any other value, so {{scratch}}/out.mp3 resolves.
        ? {
            key: sub(r.key), value: "", path: sub(r.value),
            ...(r.filename ? { filename: sub(r.filename) } : {}),
            ...(r.contentType ? { content_type: sub(r.contentType) } : {}),
          }
        : { key: sub(r.key), value: sub(r.value) });
      // Deliberately no Content-Type: reqwest writes its own, with the boundary it generated.
    } else {
      body = rows
        .map((r) => `${encodeURIComponent(sub(r.key))}=${encodeURIComponent(sub(r.value))}`)
        .join("&");
      if (!hasHeader(headers, "content-type")) headers.push(["Content-Type", "application/x-www-form-urlencoded"]);
    }
  } else if (req.bodyKind !== "none" && req.body.trim()) {
    body = sub(req.body);
    // Only default the type when the user hasn't set one — an explicit header always wins.
    if (!hasHeader(headers, "content-type")) {
      headers.push(["Content-Type", req.bodyKind === "json" ? "application/json" : "text/plain"]);
    }
  }

  // `multipart` is omitted entirely unless there is a file: its mere presence switches the Rust
  // side onto the multipart path, so an empty array would change how a plain form is sent.
  return { method: req.method, url, headers, body, ...(multipart ? { multipart } : {}) };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** ["https://x.dev/a?b=1", "frag"] — appending a query after a fragment would be part of it. */
const splitHash = (url: string): [string, string] => {
  const i = url.indexOf("#");
  return i < 0 ? [url, ""] : [url.slice(0, i), url.slice(i + 1)];
};

const hasHeader = (headers: [string, string][], name: string) =>
  headers.some(([k]) => k.toLowerCase() === name);

/** Send, tagged with `sendId` so it can be cancelled while in flight. */
/**
 * Send, tagged with `sendId` so it can be cancelled while in flight.
 *
 * Dynamic values are generated once here, not per substitution, so one {{$guid}} used in both a
 * header and the body resolves to the same id within a request. The environment wins on a name
 * clash: someone who defines their own $timestamp meant theirs.
 */
export const sendRequest = (req: Request, vars: Record<string, string>, sendId: string) =>
  httpSendAs<HttpResult>(sendId, buildSend(req, { ...dynamicValues(), ...vars }));

export const cancelRequest = (sendId: string) =>
  httpCancel(sendId).catch(() => {});

// ---- response helpers -------------------------------------------------------

/** Monaco language for a response body, from its Content-Type. */
export function bodyLanguage(headers: [string, string][]): string {
  const ct = headers.find(([k]) => k.toLowerCase() === "content-type")?.[1].toLowerCase() ?? "";
  if (ct.includes("json")) return "json";
  if (ct.includes("html")) return "html";
  if (ct.includes("xml")) return "xml";
  if (ct.includes("css")) return "css";
  if (ct.includes("javascript")) return "javascript";
  return "plaintext";
}

/** The header's value with any parameters stripped: "image/png; charset=x" -> "image/png". */
const mimeOf = (headers: [string, string][]) =>
  (headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "").split(";")[0].trim().toLowerCase();

/**
 * What kind of viewer a response wants, or null for the text/code box.
 *
 * By content type rather than by file extension — a response has no filename, and the server has
 * already said what it sent. The editor's mediaKind() is the same idea keyed on a path.
 */
export type MediaKind = "image" | "video" | "audio" | "pdf";
export function responseMedia(headers: [string, string][]): MediaKind | null {
  const m = mimeOf(headers);
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "pdf";
  return null;
}

/** True when the response is an image the pane can show inline. */
export const isImageResponse = (headers: [string, string][]) => responseMedia(headers) === "image";

/**
 * The response as a data: URI, for an <img>/<video>/<audio>/<iframe> src.
 *
 * A data: URI rather than a blob: URL because the webview's CSP-less origin treats them alike
 * here and this needs no revoke — the pane is remounted per response anyway.
 */
export function mediaDataUri(r: HttpResult): string {
  const mime = mimeOf(r.headers) || "application/octet-stream";
  // Text-typed media (an SVG, an XML playlist) never gets body_b64, so encode the string.
  if (!r.body_b64) return `data:${mime};base64,${btoa(unescape(encodeURIComponent(r.body)))}`;
  return `data:${mime};base64,${r.body_b64}`;
}

// Only the types worth naming; anything else falls back to the URL's own extension or .bin. A
// mime library would be a dependency for a dozen strings.
const EXT_BY_MIME: Record<string, string> = {
  "application/json": "json", "text/html": "html", "text/plain": "txt", "text/css": "css",
  "text/csv": "csv", "application/javascript": "js", "text/javascript": "js",
  "application/xml": "xml", "text/xml": "xml", "application/pdf": "pdf", "application/zip": "zip",
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "image/svg+xml": "svg", "image/x-icon": "ico", "audio/mpeg": "mp3", "video/mp4": "mp4",
};

/**
 * What to call the downloaded file.
 *
 * Content-Disposition wins — the server named it. Otherwise the URL's last path segment, which
 * is usually the resource name, and finally "response". The extension comes from the content
 * type unless the name already carries one.
 */
export function downloadName(r: HttpResult, url: string): string {
  const cd = r.headers.find(([k]) => k.toLowerCase() === "content-disposition")?.[1] ?? "";
  // filename*=UTF-8''name.png takes precedence over filename="name.png" per RFC 6266.
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd)?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(cd)?.[1];
  const fromCd = (star ? decodeURIComponent(star.trim()) : plain?.trim()) ?? "";
  if (fromCd) return fromCd.replace(/[\\/:*?"<>|]/g, "_");

  // Drop the scheme and host first: "https://a.com/" would otherwise yield "a.com" as the
  // filename once the trailing slash is stripped.
  const path = url.split(/[?#]/)[0].replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, "").replace(/\/+$/, "");
  const seg = path.slice(path.lastIndexOf("/") + 1).trim();
  const base = (seg || "response").replace(/[\\/:*?"<>|]/g, "_");
  if (/\.[a-z0-9]{1,5}$/i.test(base)) return base;
  return `${base}.${EXT_BY_MIME[mimeOf(r.headers)] ?? "bin"}`;
}

/** The response as the bytes it arrived as, ready to write to disk. */
export function responseBytes(r: HttpResult): Uint8Array {
  if (r.body_b64) {
    const bin = atob(r.body_b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new TextEncoder().encode(r.body);
}

/** Pretty-print JSON for display; anything unparseable comes back untouched. */
export function formatBody(body: string, lang: string): string {
  if (lang !== "json") return body;
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** One parsed Set-Cookie header. */
export interface Cookie {
  name: string; value: string; domain: string; path: string; flags: string[];
}

/**
 * Parse the response's Set-Cookie headers for the Cookies tab.
 *
 * Display only — Deck does not keep a cookie jar, so this never feeds back into a request.
 * Expires/Max-Age are shown as flags rather than parsed into dates; the point is to see what a
 * server set, not to reimplement RFC 6265.
 */
export function parseCookies(headers: [string, string][]): Cookie[] {
  return headers
    .filter(([k]) => k.toLowerCase() === "set-cookie")
    .map(([, raw]) => {
      const [pair, ...attrs] = raw.split(";");
      const eq = pair.indexOf("=");
      // A Set-Cookie with no "=" is malformed; keep it visible rather than dropping it silently.
      const name = eq < 0 ? pair.trim() : pair.slice(0, eq).trim();
      const value = eq < 0 ? "" : pair.slice(eq + 1).trim();
      const attr = (want: string) =>
        attrs.find((a) => a.trim().toLowerCase().startsWith(`${want}=`))?.split("=").slice(1).join("=").trim() ?? "";
      const flags = attrs
        .map((a) => a.trim())
        .filter((a) => !/^(domain|path)=/i.test(a) && a !== "");
      return { name, value, domain: attr("domain"), path: attr("path") || "/", flags };
    });
}

// ---- URL <-> params sync ----------------------------------------------------
//
// The URL bar and the Params grid are two views of one thing. Editing either updates the other,
// which is what every API client does and what makes pasting a full URL useful: the query
// arrives already broken into rows.

/**
 * Read the query string into rows.
 *
 * Disabled rows are preserved (they are not in the URL by definition, so parsing alone would
 * delete them the moment you unticked one).
 */
export function paramsFromUrl(url: string, existing: Row[]): Row[] {
  const disabled = existing.filter((r) => !r.on);
  const q = url.indexOf("?");
  if (q < 0) return disabled;
  const qs = url.slice(q + 1);
  if (!qs) return disabled;

  const rows: Row[] = [];
  for (const seg of qs.split("&")) {
    if (!seg) continue;
    const eq = seg.indexOf("=");
    const rawKey = eq < 0 ? seg : seg.slice(0, eq);
    const rawVal = eq < 0 ? "" : seg.slice(eq + 1);
    // decodeURIComponent throws on a stray "%" — which is exactly what a half-typed URL or a
    // {{var}} standing in for an encoded value looks like. Keep the raw text in that case.
    let key = rawKey, value = rawVal;
    try { key = decodeURIComponent(rawKey); } catch { /* keep raw */ }
    try { value = decodeURIComponent(rawVal); } catch { /* keep raw */ }
    rows.push({ on: true, key, value });
  }
  return [...rows, ...disabled];
}

/** Write enabled rows back into the URL's query string, leaving path and hash alone. */
export function applyParamsToUrl(url: string, params: Row[]): string {
  const hashAt = url.indexOf("#");
  const hash = hashAt < 0 ? "" : url.slice(hashAt);
  const noHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const base = noHash.split("?")[0];

  const qs = params
    .filter((r) => r.on && (r.key.trim() !== "" || r.value.trim() !== ""))
    // Not encodeURIComponent: a {{var}} in a param would come back as %7B%7Bvar%7D%7D and never
    // match at send time. Encoding happens in the backend against the final URL.
    .map((r) => (r.value === "" ? r.key : `${r.key}=${r.value}`))
    .join("&");

  return qs ? `${base}?${qs}${hash}` : `${base}${hash}`;
}

/** Discover /:name path variables in the URL, keeping values already entered for them. */
export function pathParamsFromUrl(url: string, existing: Row[]): Row[] {
  const end = url.search(/[?#]/);
  const path = end < 0 ? url : url.slice(0, end);
  const names: string[] = [];
  for (const m of path.matchAll(/\/:([a-zA-Z_]\w*)/g)) if (!names.includes(m[1])) names.push(m[1]);
  const byKey = new Map(existing.map((r) => [r.key, r]));
  return names.map((n) => byKey.get(n) ?? { on: true, key: n, value: "" });
}

// ---- history ----------------------------------------------------------------

export interface HistoryEntry {
  id: string;
  /** The URL as typed, variables NOT substituted — so a replayed entry stays parameterised and
   *  no expanded token is baked into the log. */
  url: string;
  method: Method;
  status: number;
  elapsed_ms: number;
  size: number;
  sentAt: number;
  /** Enough to rebuild the request in a new tab. */
  request: Request;
}

const HISTORY = "requests-history";
// A working log, not an archive. Entries carry resolved URLs (and therefore whatever a token
// expanded to), so an unbounded file would accumulate credentials indefinitely.
const HISTORY_CAP = 200;

export async function loadHistory(): Promise<HistoryEntry[]> {
  try {
    const t = await configRead(HISTORY);
    return t.trim() ? (JSON.parse(t) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export const saveHistory = (h: HistoryEntry[]) =>
  configWrite(HISTORY, JSON.stringify(h.slice(0, HISTORY_CAP), null, 2)).catch((e) => console.warn("[requests] history save failed", e));
