// Deck's HTTP client — a request builder for hitting APIs without leaving the app.
//
// Layout follows the shape every API client has converged on: an icon rail for collections and
// history, open requests as tabs across the top, the URL bar under them, and the response in a
// resizable pane below so it stays visible while you edit.
//
// Collections live in %APPDATA%\Deck\requests-collections.json, deliberately not in the open
// project — requests carry tokens and internal hostnames.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "../shim/react-dom.js";
import { onKeys, useScope } from "../shim/ui.js";
import { notice, failure } from "./notice";
import {
  Plus, Trash2, FolderPlus, Loader2, Search, Globe, X, Upload, TerminalSquare, Download,
  FolderTree, History as HistoryIcon, Save, ChevronDown, Pencil, PanelLeft, Send,
} from "lucide-react";
import {
  loadCollections, saveCollections, cancelRequest, envVars, newRequest, newId,
  loadHistory, saveHistory, paramsFromUrl, applyParamsToUrl, pathParamsFromUrl,
  newFolder, newWorkspace, moveNode, moveToRoot, subtree, parentOf,
  type Collections, type Request, type HttpResult, type BodyKind, type Workspace,
  type Environment,
  type HistoryEntry,
} from "./httpclient";
import {
  ContextMenu, useNarrow, useResize, ActivityBar, TabStrip, ConfirmDialog, NamePrompt,
  type MenuEntry, type ConfirmState, type NamePromptState,
} from "../shim/ui.js";

/** The attribute components/dragrow marks a draggable row with. The ui shim forwards functions
 *  only, so the constant is restated here. */
const ROW_ATTR = "data-drag-id";
import ResponseView from "./ResponseView";
import KeyValueGrid from "./KeyValueGrid";
import VarInput from "./VarInput";
import MethodPicker from "./MethodPicker";
import { METHOD_TONE } from "./methods";
import HistoryPanel from "./HistoryPanel";
import CollectionTree from "./CollectionTree";
import CodeBox from "./CodeBox";
import { parseCurl, toCurl } from "./curl";
import { exportCollection, exportWorkspace, importCollection, parseExport, exportFilename,
  summarizeImport, type ImportSummary } from "./httpexport";
import { pickSavePath, pickFile, fsRead, fsWrite } from "../shim/bridge.js";
import { setTemplateVars } from "./monacovars";
import { type ScriptResult } from "./httpscript";
import { runRequest, withScriptEnv } from "./httprun";
import { PM_REFERENCE, SNIPPETS, SANDBOX_NOTE } from "./scriptdocs";
import { loadHttpSession, saveHttpSession } from "./httpsession";
import { COMMON_HEADERS, QUICK_HEADERS } from "./headers";

type ReqTab = "params" | "headers" | "body" | "auth" | "scripts";

/**
 * One open tab. `draft` is the working copy; `saved` is what the collection holds.
 *
 * Edits go to the draft only, so an open request is never written back until Ctrl+S — the same
 * model as Deck's editor, and the reason a tab can be dirty at all. A scratch tab (no
 * `requestId`) is a request that does not belong to a collection yet.
 */
interface Tab {
  id: string;
  requestId: string | null;
  draft: Request;
  saved: Request | null;
  /** Opened by a single click and not yet touched: shown in italics, and replaced by the next
   *  preview instead of accumulating. Editing it, or double-clicking the tab, makes it stick —
   *  VS Code's rule, and the editor's. */
  preview?: boolean;
}

const sameRequest = (a: Request, b: Request) => JSON.stringify(a) === JSON.stringify(b);

/** What one send's scripts produced. Either half may be absent — most requests have neither. */
interface ScriptRun { pre?: ScriptResult | null; post?: ScriptResult | null }



export default function Requests() {
  // Restored once, synchronously, so the first render already has the tabs — mounting empty and
  // filling in afterwards flashes the empty state and loses the active tab's scroll position.
  const [saved0] = useState(loadHttpSession);

  const [col, setCol] = useState<Collections | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [tabs, setTabs] = useState<Tab[]>(saved0.tabs ?? []);
  const [activeId, setActiveId] = useState<string | null>(saved0.activeId ?? null);
  const [reqTab, setReqTab] = useState<ReqTab>("params");
  const [rail, setRail] = useState<"collections" | "history">(saved0.rail === "history" ? "history" : "collections");
  const [filter, setFilter] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set(saved0.collapsed ?? []));
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[]; alignRight?: boolean } | null>(null);
  const [respCollapsed, setRespCollapsed] = useState(false);
  const [editEnv, setEditEnv] = useState<string | null>(null); // environment open in the editor dialog
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  // The file operations report through Deck's notifications — they are silent otherwise, and a failed
  // import that says nothing looks like a broken button.
  const [exportAsk, setExportAsk] = useState<{ scope: "collection" | "workspace"; id: string; name: string } | null>(null);
  const [sidebarW, setSidebarW] = useState(saved0.sidebarW ?? 256); // px; the drag handle beside the sidebar resizes
  const asideRef = useRef<HTMLDivElement>(null);
  // In a narrow pane the sidebar is a drawer over the requests, opened from the tab strip, rather
  // than a column that would leave the request a sliver. 640px: a 256px sidebar plus a request
  // view that still fits a URL and a Send button.
  const [narrow, rootRef] = useNarrow(640);
  const [sideOpen, setSideOpen] = useState(false);
  const drawer = narrow && sideOpen;

  // Per-tab, so switching tabs never loses a response.
  const [results, setResults] = useState<Record<string, HttpResult>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<Record<string, string>>({}); // tabId -> sendId
  // Pre/post script output, per tab so switching tabs keeps it alongside the response.
  const [scriptRuns, setScriptRuns] = useState<Record<string, ScriptRun>>({});

  // invert: the response pane is BELOW its drag handle, so dragging down must shrink it.
  const [respHeight, respDrag] = useResize({ initial: 300, min: 90, max: 900, direction: "vertical", invert: true });

  // Pointer events, not a mousedown/mousemove pair: setPointerCapture keeps the drag alive when
  // the cursor outruns the 4px handle. Same implementation as the editor's sidebar.
  const dragSidebar = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    // The window the tab is in: Deck's main one, or a floating window, whose moves the main one
    // never hears.
    const win = e.currentTarget.ownerDocument.defaultView ?? window;
    const move = (ev: PointerEvent) => {
      const left = asideRef.current?.getBoundingClientRect().left ?? 0;
      setSidebarW(Math.min(560, Math.max(160, ev.clientX - left)));
    };
    const up = () => { win.removeEventListener("pointermove", move); win.removeEventListener("pointerup", up); };
    win.addEventListener("pointermove", move);
    win.addEventListener("pointerup", up);
  };

  // Persist the session whenever any part of it changes. Cheap enough to do eagerly: the payload
  // is a handful of drafts, and writing on change means a crash or a force-quit still leaves the
  // last state on disk.
  useEffect(() => {
    saveHttpSession({ tabs, activeId, rail, sidebarW, collapsed: [...collapsedFolders] });
  }, [tabs, activeId, rail, sidebarW, collapsedFolders]);

  // Restored tabs can outlive what they point at: the request may have been deleted, or it may
  // belong to a workspace that is no longer the active one. Rather than dropping the tab and the
  // user's unsaved draft with it, detach it into a scratch tab — the same thing deleteRequest
  // does to an open tab.
  const pruneRestoredTabs = (c: Collections) => {
    const live = new Set(
      c.folders.filter((f) => f.workspaceId === c.activeWorkspaceId).flatMap((f) => f.children),
    );
    setTabs((ts) => {
      let changed = false;
      const next = ts.map((t) => {
        if (!t.requestId || live.has(t.requestId)) return t;
        changed = true;
        return { ...t, requestId: null, saved: null };
      });
      return changed ? next : ts;
    });
  };

  useEffect(() => {
    void loadCollections().then((c) => { setCol(c); pruneRestoredTabs(c); });
    void loadHistory().then(setHistory);
  }, []);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const update = (patch: (c: Collections) => Collections) => {
    setCol((c) => {
      if (!c) return c;
      const next = patch(c);
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void saveCollections(next), 400);
      return next;
    });
  };

  const tab = tabs.find((t) => t.id === activeId) ?? null;
  const active = tab?.draft ?? null;
  const dirty = (t: Tab) => !t.saved || !sameRequest(t.draft, t.saved);

  const patchActive = (patch: Partial<Request>) =>
    setTabs((ts) => ts.map((t) => (t.id === activeId
      ? { ...t, draft: { ...t.draft, ...patch }, preview: false }
      : t)));

  const vars = useMemo(() => (col ? envVars(col) : {}), [col]);

  /**
   * Write variables a script set back into the active environment.
   *
   * With no active environment there is nowhere to put them; rather than inventing one, the
   * writes are dropped and the script panel says so — creating an environment behind the user's
   * back would then silently become the active one.
   */
  const applyScriptEnv = useCallback((changes: Record<string, string | null>) => {
    let saved = true;
    update((c) => {
      const next = withScriptEnv(c, changes);
      if (!next) { saved = false; return c; }
      return next;
    });
    return saved;
  }, []);

  // Monaco's completion and hover providers are global, so they read the variables through a
  // getter rather than being re-registered whenever the environment changes.
  useEffect(() => { setTemplateVars(() => vars); }, [vars]);

  // ---- tabs -----------------------------------------------------------------

  const openRequest = (r: Request) => {
    setSideOpen(false); // the drawer, if it is one, has done its job
    const existing = tabs.find((t) => t.requestId === r.id);
    if (existing) { setActiveId(existing.id); return; }
    const t: Tab = { id: newId(), requestId: r.id, draft: r, saved: r, preview: true };
    setTabs((ts) => {
      // A preview tab is a slot, not an addition: browsing the tree replaces it rather than
      // leaving a trail of tabs behind. A dirty one holds real edits, so it is left alone.
      const slot = ts.findIndex((x) => x.preview && !dirty(x));
      if (slot < 0) return [...ts, t];
      const next = [...ts];
      next[slot] = t;
      return next;
    });
    setActiveId(t.id);
  };

  /** Make a preview tab permanent — on double-clicking its tab. */
  const promoteTab = (id: string) =>
    setTabs((ts) => (ts.some((t) => t.id === id && t.preview)
      ? ts.map((t) => (t.id === id ? { ...t, preview: false } : t))
      : ts));

  /** Open a copy that is not attached to any collection — used by history replay. */
  const openScratch = (base?: Request) => {
    const t: Tab = { id: newId(), requestId: null, draft: base ? { ...base, id: newId() } : newRequest(), saved: null };
    setTabs((ts) => [...ts, t]);
    setActiveId(t.id);
  };

  const closeTab = (id: string) => {
    const t = tabs.find((x) => x.id === id);
    // Unsaved edits are only in the draft; closing drops them, so ask first — the same guard the
    // editor puts on a dirty file tab.
    if (t && dirty(t)) {
      setConfirm({
        title: `Close ${t.draft.name} without saving?`,
        body: "This request has unsaved changes. Closing the tab discards them.",
        confirmLabel: "Discard changes",
        onConfirm: () => doCloseTab(id),
      });
      return;
    }
    doCloseTab(id);
  };

  const doCloseTab = (id: string) => {
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      if (activeId === id) setActiveId(next[Math.min(i, next.length - 1)]?.id ?? null);
      return next;
    });
    // Drop the response with the tab; keeping it would leak one result per tab ever opened.
    setResults((r) => { const { [id]: _a, ...rest } = r; return rest; });
    setErrors((e) => { const { [id]: _b, ...rest } = e; return rest; });
  };

  const moveTab = (from: string, to: string) => {
    setTabs((ts) => {
      const a = ts.findIndex((t) => t.id === from), b = ts.findIndex((t) => t.id === to);
      if (a < 0 || b < 0 || a === b) return ts;
      const next = [...ts];
      next.splice(b, 0, next.splice(a, 1)[0]);
      return next;
    });
  };

  // ---- save -----------------------------------------------------------------

  const saveTab = useCallback(() => {
    const t = tabs.find((x) => x.id === activeId);
    if (!t || !dirty(t)) return;

    if (t.requestId) {
      update((c) => ({ ...c, requests: { ...c.requests, [t.requestId!]: t.draft } }));
      setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...x, saved: x.draft } : x)));
      return;
    }
    // A scratch tab needs somewhere to live: the first collection, or one made for it.
    update((c) => {
      const wsId = c.activeWorkspaceId;
      if (!wsId) return c;
      const root = c.folders.find((f) => f.parentId === null && f.workspaceId === wsId);
      const target = root ?? newFolder("My Requests", wsId);
      const folders = root
        ? c.folders.map((f) => (f.id === target.id ? { ...f, children: [...f.children, t.draft.id] } : f))
        : [...c.folders, { ...target, children: [t.draft.id] }];
      return { ...c, requests: { ...c.requests, [t.draft.id]: t.draft }, folders };
    });
    setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...x, requestId: x.draft.id, saved: x.draft } : x)));
  }, [tabs, activeId]);

  // ---- send -----------------------------------------------------------------

  const send = useCallback(async () => {
    const t = tabs.find((x) => x.id === activeId);
    if (!t || !t.draft.url.trim() || sending[t.id]) return;
    const sendId = newId();
    setSending((s) => ({ ...s, [t.id]: sendId }));
    setErrors((e) => ({ ...e, [t.id]: "" }));
    setScriptRuns((r) => { const { [t.id]: _gone, ...rest } = r; return rest; });
    setRespCollapsed(false);
    try {
      const out = await runRequest(t.draft, vars, sendId, applyScriptEnv);
      if (out.pre || out.post) setScriptRuns((rs) => ({ ...rs, [t.id]: { pre: out.pre, post: out.post } }));
      if (!out.result) {
        setErrors((es) => ({ ...es, [t.id]: out.error }));
        setResults((rs) => { const { [t.id]: _gone, ...rest } = rs; return rest; });
        return;
      }
      const r = out.result;
      setResults((rs) => ({ ...rs, [t.id]: r }));
      const entry: HistoryEntry = {
        id: sendId,
        url: t.draft.url,
        method: t.draft.method,
        status: r.status,
        elapsed_ms: r.elapsed_ms,
        size: r.size,
        sentAt: Date.now(),
        request: t.draft,
      };
      setHistory((h) => { const next = [entry, ...h]; void saveHistory(next); return next; });
    } catch (e) {
      setErrors((es) => ({ ...es, [t.id]: String(e) }));
      setResults((rs) => { const { [t.id]: _gone, ...rest } = rs; return rest; });
    } finally {
      setSending((s) => { const { [t.id]: _gone, ...rest } = s; return rest; });
    }
  }, [tabs, activeId, vars, sending]);

  const cancel = () => {
    if (!tab) return;
    const id = sending[tab.id];
    if (id) void cancelRequest(id);
  };

  // The plugin's scope, claimed while its pane has focus, and its two actions (declared in
  // plugin.tsx). Both default to chords the editor also uses — Ctrl+Enter and Ctrl+S — which is
  // allowed precisely because the two scopes never hold the keyboard at once.
  useScope("plugin:requests");
  useEffect(() => onKeys({
    "plugin:requests:send": () => void send(),
    "plugin:requests:save": () => saveTab(),
  }), [send, saveTab]);

  // ---- collection edits -----------------------------------------------------

  const addRequest = (folderId: string) => {
    const r = newRequest();
    update((c) => ({
      ...c,
      requests: { ...c.requests, [r.id]: r },
      folders: c.folders.map((f) => (f.id === folderId ? { ...f, children: [...f.children, r.id] } : f)),
    }));
    setCollapsedFolders((s) => { const n = new Set(s); n.delete(folderId); return n; });
    openRequest(r);
  };

  const addFolder = (parentId: string) => {
    const ws = col?.folders.find((x) => x.id === parentId)?.workspaceId;
    if (!ws) return;
    const f = newFolder("New Folder", ws, parentId);
    update((c) => ({
      ...c,
      folders: [...c.folders.map((x) => (x.id === parentId ? { ...x, children: [...x.children, f.id] } : x)), f],
    }));
    setCollapsedFolders((s) => { const n = new Set(s); n.delete(parentId); return n; });
  };

  const addCollection = () => update((c) => (
    c.activeWorkspaceId
      ? { ...c, folders: [...c.folders, newFolder("New Collection", c.activeWorkspaceId)] }
      : c));

  const addWorkspace = () => {
    const w = newWorkspace();
    update((c) => ({
      ...c,
      workspaces: [...c.workspaces, w],
      activeWorkspaceId: w.id,
      // A workspace with nothing in it has no tree at all, so it starts with one collection.
      folders: [...c.folders, newFolder("My Requests", w.id)],
    }));
    // Tabs belong to the workspace that was open; carrying them across would show requests that
    // are no longer in the tree.
    setTabs([]); setActiveId(null);
  };

  const deleteWorkspace = (id: string) => update((c) => {
    const rest = c.workspaces.filter((w) => w.id !== id);
    const gone = new Set(c.folders.filter((f) => f.workspaceId === id).map((f) => f.id));
    const requests = { ...c.requests };
    for (const f of c.folders) {
      if (f.workspaceId !== id) continue;
      for (const child of f.children) if (!gone.has(child)) delete requests[child];
    }
    return {
      ...c,
      workspaces: rest,
      activeWorkspaceId: c.activeWorkspaceId === id ? rest[0]?.id ?? null : c.activeWorkspaceId,
      folders: c.folders.filter((f) => f.workspaceId !== id),
      environments: c.environments.filter((e) => e.workspaceId !== id),
      requests,
    };
  });

  const renameFolder = (id: string, name: string) =>
    update((c) => ({ ...c, folders: c.folders.map((f) => (f.id === id ? { ...f, name } : f)) }));

  // Show the tab's saved request in the tree: expand its ancestors and scroll it into view. The
  // editor does the same when a tab is clicked; here the tree is in memory, so walking parents is
  // all it takes. A scratch tab has no request to reveal.
  const revealInTree = (requestId: string | null) => {
    if (!requestId || !col) return;
    setRail("collections");
    const ancestors: string[] = [];
    let cur: string | null = requestId;
    while (cur) {
      const parent = parentOf(col.folders, cur);
      if (!parent) break;
      ancestors.push(parent.id);
      cur = parent.id;
    }
    if (ancestors.length) {
      setCollapsedFolders((st) => {
        if (!ancestors.some((id) => st.has(id))) return st; // already open — don't re-render
        const n = new Set(st);
        for (const id of ancestors) n.delete(id);
        return n;
      });
    }
    // After the expansion has rendered, otherwise the row does not exist to scroll to yet.
    requestAnimationFrame(() => {
      asideRef.current?.querySelector(`[${ROW_ATTR}="${requestId}"]`)?.scrollIntoView({ block: "nearest" });
    });
  };

  // ---- curl and files ----------------------------------------------------

  const copyCurl = (id: string, resolved: boolean) => {
    const r = col?.requests[id];
    if (!r) return;
    navigator.clipboard.writeText(toCurl(r, resolved ? vars : undefined)).then(
      () => notice(resolved ? "Copied with environment values filled in." : "Copied as cURL."),
      () => failure("Could not copy to the clipboard."),
    );
  };

  /** Paste a curl command as a new scratch tab. Not saved: it is a paste, not a decision. */
  const importCurl = async () => {
    const text = await navigator.clipboard.readText().catch(() => "");
    const req = text && parseCurl(text);
    if (!req) { failure("Clipboard does not hold a curl command."); return; }
    openScratch(req);
  };

  // A dialog rather than a second menu: this is reached FROM a menu item, and that menu closes
  // itself right after the click — setMenu here then setMenu(null) there meant the export menu
  // was opened and immediately thrown away, so the item looked dead.
  const exportCollectionFile = (id: string) => {
    const name = col?.folders.find((f) => f.id === id)?.name ?? "collection";
    setExportAsk({ scope: "collection", id, name });
  };

  const exportWorkspaceFile = () => {
    const ws = col?.workspaces.find((w) => w.id === col.activeWorkspaceId);
    if (ws) setExportAsk({ scope: "workspace", id: ws.id, name: ws.name });
  };

  const writeExport = async (includeSecrets: boolean) => {
    const ask = exportAsk;
    setExportAsk(null);
    if (!col || !ask) return;
    try {
      const path = await pickSavePath(exportFilename(ask.name), "json");
      if (!path) return;
      const file = ask.scope === "workspace"
        ? exportWorkspace(col, ask.id, { includeSecrets })
        : exportCollection(col, ask.id, { includeSecrets });
      await fsWrite(path, JSON.stringify(file, null, 2));
      notice(includeSecrets ? "Exported with secrets." : "Exported without secrets.");
    } catch (e) {
      failure(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * Import a file as a NEW workspace rather than into the current one.
   *
   * The same file works either way — the format is a list of collections — but a workspace export
   * is meant to arrive as a workspace, and dropping its collections into whatever happened to be
   * open loses that.
   */
  const importWorkspaceFile = async () => {
    try {
      const path = await pickFile("json");
      if (!path) return;
      const file = parseExport(await fsRead(path));
      // A new workspace, so nothing can collide.
      const sum = summarizeImport(col, file, null);
      setConfirm({
        title: "Import as a new workspace?",
        body: <ImportSummaryBody sum={sum} target="a new workspace" />,
        confirmLabel: "Import",
        danger: false,
        wide: true,
        onConfirm: () => {
          const ws = newWorkspace(file.name || "Imported");
          update((c) => {
            const withWs = { ...c, workspaces: [...c.workspaces, ws], activeWorkspaceId: ws.id };
            return importCollection(withWs, file, ws.id, { withEnvironments: file.environments.length > 0 });
          });
          // Tabs belong to the workspace that was open, and this switches away from it.
          setTabs([]); setActiveId(null);
          notice(`Imported "${file.name}" as a new workspace${file.secrets ? "" : " (no secrets in the file)"}.`);
        },
      });
    } catch (e) {
      failure(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const importCollectionFile = async () => {
    try {
      const path = await pickFile("json");
      if (!path) return;
      const file = parseExport(await fsRead(path));
      const wsId = col?.activeWorkspaceId;
      if (!wsId) { failure("No workspace to import into."); return; }
      const wsName = col.workspaces.find((w) => w.id === wsId)?.name;
      const sum = summarizeImport(col, file, wsId);
      setConfirm({
        title: "Import this collection?",
        body: <ImportSummaryBody sum={sum} target={wsName ? `"${wsName}"` : "this workspace"} />,
        confirmLabel: "Import",
        danger: false,
        wide: true,
        onConfirm: () => {
          update((c) => importCollection(c, file, wsId, { withEnvironments: file.environments.length > 0 }));
          notice(`Imported "${file.name}"${file.secrets ? "" : " (no secrets in the file)"}.`);
        },
      });
    } catch (e) {
      failure(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const renameRequest = (id: string, name: string) => {
    update((c) => (c.requests[id] ? { ...c, requests: { ...c.requests, [id]: { ...c.requests[id], name } } } : c));
    // An open tab holds its own draft, so without this the tab keeps the old title and saving
    // it would write the old name straight back over the rename.
    setTabs((ts) => ts.map((t) => (t.requestId === id
      ? { ...t, draft: { ...t.draft, name }, saved: t.saved ? { ...t.saved, name } : t.saved }
      : t)));
  };

  const deleteRequest = (id: string) => {
    update((c) => {
      const { [id]: _gone, ...rest } = c.requests;
      return { ...c, requests: rest, folders: c.folders.map((f) => ({ ...f, children: f.children.filter((x) => x !== id) })) };
    });
    const t = tabs.find((x) => x.requestId === id);
    // The tab becomes a scratch tab rather than vanishing — closing someone's open work
    // because they deleted the saved copy loses whatever they had typed.
    if (t) setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...x, requestId: null, saved: null } : x)));
  };

  const duplicateRequest = (id: string) => {
    update((c) => {
      const src = c.requests[id];
      const parent = parentOf(c.folders, id);
      if (!src || !parent) return c;
      const copy = { ...src, id: newId(), name: `${src.name} copy` };
      const at = parent.children.indexOf(id) + 1;
      return {
        ...c,
        requests: { ...c.requests, [copy.id]: copy },
        folders: c.folders.map((f) =>
          f.id === parent.id
            ? { ...f, children: [...f.children.slice(0, at), copy.id, ...f.children.slice(at)] }
            : f),
      };
    });
  };

  const deleteFolder = (id: string) => update((c) => {
    // Recursive: everything nested under the folder goes with it, or the requests would
    // survive as orphans reachable from nowhere.
    const { folderIds, requestIds } = subtree(c.folders, id);
    const requests = { ...c.requests };
    for (const rid of requestIds) delete requests[rid];
    return {
      ...c,
      requests,
      folders: c.folders
        .filter((f) => !folderIds.includes(f.id))
        .map((f) => ({ ...f, children: f.children.filter((x) => !folderIds.includes(x) && !requestIds.includes(x)) })),
    };
  });

  // ---- confirmations ------------------------------------------------------
  // None of these can be undone, so each asks first, saying what goes and what stays.

  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

  const askDeleteRequest = (id: string) => {
    const r = col?.requests[id];
    if (!r) return;
    setConfirm({
      title: `Delete the request ${r.name}?`,
      body: tabs.some((t) => t.requestId === id)
        ? "It is removed from its collection; its open tab stays, as an unsaved request."
        : "It is removed from its collection; the rest of the collection stays.",
      confirmLabel: "Delete",
      onConfirm: () => deleteRequest(id),
    });
  };

  const askDeleteFolder = (id: string) => {
    const f = col?.folders.find((x) => x.id === id);
    if (!col || !f) return;
    const { folderIds, requestIds } = subtree(col.folders, id);
    const what = f.parentId === null ? "collection" : "folder";
    const inside = [
      ...(requestIds.length ? [n(requestIds.length, "request")] : []),
      ...(folderIds.length > 1 ? [n(folderIds.length - 1, "folder")] : []),
    ];
    setConfirm({
      title: `Delete the ${what} ${f.name}?`,
      body: inside.length
        ? `This also deletes its ${inside.join(" and ")}; everything outside the ${what} stays.`
        : `It is empty, so nothing else goes with it.`,
      confirmLabel: "Delete",
      onConfirm: () => deleteFolder(id),
    });
  };

  const askDeleteWorkspace = (id: string) => {
    const w = col?.workspaces.find((x) => x.id === id);
    if (!col || !w) return;
    const cols = col.folders.filter((f) => f.workspaceId === id && f.parentId === null).length;
    const envs = col.environments.filter((e) => e.workspaceId === id).length;
    setConfirm({
      title: `Delete the workspace ${w.name}?`,
      body: `This also deletes its ${n(cols, "collection")} and ${n(envs, "environment")}; your other workspaces stay.`,
      confirmLabel: "Delete",
      onConfirm: () => deleteWorkspace(id),
    });
  };

  const askClearHistory = () => setConfirm({
    title: "Clear the history?",
    body: `This removes ${history.length === 1 ? "the one sent request" : `all ${history.length} sent requests`} from the list; saved requests in your collections stay.`,
    confirmLabel: "Clear history",
    onConfirm: () => { setHistory([]); void saveHistory([]); },
  });

  if (!col) return <div className="flex h-full items-center justify-center text-sm text-text-muted">Loading…</div>;

  const busy = tab ? !!sending[tab.id] : false;
  const activeWs = col.workspaces.find((w) => w.id === col.activeWorkspaceId) ?? null;

  // Environment selection, shared by the URL bar's selector and the sidebar's env panel.
  const envs = col.environments.filter((e) => e.workspaceId === col.activeWorkspaceId);
  const activeEnvId = activeWs?.activeEnvId ?? null;
  const setActiveEnv = (id: string | null) =>
    update((c) => ({ ...c, workspaces: c.workspaces.map((w) => (w.id === c.activeWorkspaceId ? { ...w, activeEnvId: id } : w)) }));

  const addEnv = () => {
    const wsId = col.activeWorkspaceId;
    if (!wsId) return;
    const e: Environment = { id: newId(), name: "New Environment", vars: [], workspaceId: wsId };
    update((c) => ({ ...c, environments: [...c.environments, e] }));
    setEditEnv(e.id);
  };

  // The environment picker, shared by the sidebar's globe and the URL bar's selector so both
  // offer the same actions from wherever the user happens to be looking.
  const openEnvMenu = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({
      x: r.left, y: r.bottom, items: [
        { label: "No environment", dot: activeEnvId === null ? "ok" : undefined, onClick: () => setActiveEnv(null) },
        ...envs.map((e) => ({
          label: e.name,
          subLabel: `${e.vars.length} variable${e.vars.length === 1 ? "" : "s"}`,
          dot: e.id === activeEnvId ? ("ok" as const) : undefined,
          onClick: () => setActiveEnv(e.id),
          // Edit without making it active: a staging environment often needs filling in while
          // production stays the one that resolves {{vars}}.
          action: { icon: Pencil, title: "Edit variables", onClick: () => setEditEnv(e.id) },
        })),
        "sep" as const,
        { label: "New environment", icon: Plus, onClick: addEnv },
      ],
    });
  };

  const switchWorkspace = (id: string) => {
    if (id === col.activeWorkspaceId) return;
    update((c) => ({ ...c, activeWorkspaceId: id }));
    // Open tabs belong to the workspace they came from; keeping them would leave requests on
    // screen that the tree no longer contains.
    setTabs([]); setActiveId(null);
  };
  // Saved requests whose open tab has unsaved edits, for the tree's dot.
  const dirtyIds = new Set(tabs.filter((t) => t.requestId && dirty(t)).map((t) => t.requestId!));

  // The tree, the environment panel and every edit below work against the active workspace
  // only. Narrowing here rather than in each of them keeps one place that knows about scoping.
  const wsCol: Collections = {
    ...col,
    folders: col.folders.filter((f) => f.workspaceId === col.activeWorkspaceId),
    environments: col.environments.filter((e) => e.workspaceId === col.activeWorkspaceId),
  };

  return (
    // Edge to edge in its pane, like the Editor: a plugin's pane view gets no padding to cancel.
    <div ref={rootRef} className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="relative flex min-h-0 w-full flex-1 overflow-hidden">
        {/* The drawer's backdrop: a click beside it closes it. */}
        {drawer && <div className="absolute inset-0 z-20 bg-black/40" onClick={() => setSideOpen(false)} />}
        {/* ---- sidebar ---- */}
        {/* Same surface as the Editor's sidebar and the workspace rail — a request tree is dense
            text, and the wallpaper behind it makes it hard to read. */}
        <div ref={asideRef}
          className={"flex shrink-0 flex-col overflow-hidden border-r border-subtle bg-panel/80 backdrop-blur-xl blur-surface "
            + (narrow ? (drawer ? "absolute inset-y-0 left-0 z-30 shadow-2xl" : "hidden") : "")}
          style={{ width: narrow ? `min(${sidebarW}px, 85%)` : sidebarW, ...(drawer ? { background: "var(--bg-panel)" } : {}) }}>
          {/* Icons only. Anything that varies per view lives in the sub-header below — a label
              or an action that appears for one view and not another changes this row's content
              width, which slides the icons sideways as you switch. */}
          <ActivityBar
            views={[
              { id: "collections", icon: FolderTree, title: "Collections" },
              { id: "history", icon: HistoryIcon, title: "History" },
              // A button, not a view: environments are a short list you pick from, so a popup
              // beats a whole panel — and it keeps working while the tree is on screen.
              { id: "env", icon: Globe, title: "Environments", onClick: (el) => openEnvMenu(el) },
            ] as const}
            active={rail}
            onSelect={(id) => { if (id !== "env") setRail(id); }}
            // Safe in the trailing slot: it renders the same for every view, so it cannot change
            // the row's width as you switch.
            trailing={
              <WorkspaceBar
                col={col}
                active={activeWs}
                onSwitch={switchWorkspace}
                onAdd={addWorkspace}
                onRename={(id, name) => update((c) => ({ ...c, workspaces: c.workspaces.map((w) => (w.id === id ? { ...w, name } : w)) }))}
                onDelete={askDeleteWorkspace}
                onExport={exportWorkspaceFile}
                onImport={() => void importWorkspaceFile()}
                onMenu={(x, y, items) => setMenu({ x, y, items, alignRight: true })}
              />
            }
          />

          {rail === "history" ? (
            <>
              <div className="flex h-9 shrink-0 items-center gap-1.5 px-2.5 text-[11.5px] text-text-muted">
                <span className="min-w-0 flex-1 truncate">
                  {history.length === 0
                    ? "No requests sent yet"
                    : `${history.length} request${history.length === 1 ? "" : "s"}`}
                </span>
                {history.length > 0 && (
                  <button
                    onClick={askClearHistory}
                    title="Clear history"
                    className={toolDangerBtn}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              <HistoryPanel history={history} onOpen={(r) => openScratch(r)} onNew={() => openScratch()} />
            </>
          ) : (
            <>
              {/* h-9 on every view's sub-header row, so the list below always starts at the
                  same y and switching views does not shift the panel. */}
              <div className="flex h-9 shrink-0 items-center gap-0.5 px-2">
                <label className="mr-1 flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-subtle bg-elev px-2 transition-colors focus-within:border-[var(--accent)]">
                  <Search size={13} className="shrink-0 text-text-muted" />
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter requests…"
                    className="min-w-0 flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted"
                  />
                </label>
                <button
                  onClick={() => void importCurl()}
                  title="Paste a curl command from the clipboard as a new request"
                  className={toolBtn}
                >
                  <TerminalSquare size={14} />
                </button>
                <button
                  onClick={() => void importCollectionFile()}
                  title="Import a collection file"
                  className={toolBtn}
                >
                  <Upload size={14} />
                </button>
                <button
                  onClick={addCollection}
                  title="New collection"
                  className={toolBtn}
                >
                  <FolderPlus size={14} />
                </button>
              </div>

              <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
                <CollectionTree
                  col={wsCol}
                  filter={filter}
                  collapsed={collapsedFolders}
                  setCollapsed={setCollapsedFolders}
                  cb={{
                    onOpen: openRequest,
                    onAddRequest: addRequest,
                    onAddFolder: addFolder,
                    onAddCollection: addCollection,
                    onRename: renameFolder,
                    onRenameRequest: renameRequest,
                    onDeleteFolder: askDeleteFolder,
                    onDeleteRequest: askDeleteRequest,
                    onDuplicateRequest: duplicateRequest,
                    onCopyCurl: copyCurl,
                    onExportCollection: exportCollectionFile,
                    onMove: (id, to, before) => update((c) => moveNode(c, id, to, before)),
                    onMoveToRoot: (id) => update((c) => moveToRoot(c, id)),
                    onMenu: (x, y, items) => setMenu({ x, y, items }),
                    activeRequestId: tab?.requestId ?? null,
                    dirtyRequestIds: dirtyIds,
                  }}
                />
              </div>
            </>
          )}
        </div>

        {/* Drag handle to resize the sidebar; none for the drawer, which is not a column. */}
        {!narrow && <div onPointerDown={dragSidebar} style={{ touchAction: "none" }}
          className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-[var(--accent)]" />}

        {/* ---- main ---- */}
        {/* Nearly opaque, unlike the sidebar. This side draws its params table and response
            body straight onto the panel, so a wallpaper would otherwise sit directly behind the
            data — unreadable in a way the card-based modules never are. The strength is the
            "Panel opacity" setting; with no wallpaper the variable resolves to the plain colour.
            The sidebar keeps the wallpaper fully — a short list with plenty of gaps. */}
        <div className="flex min-w-0 flex-1 flex-col" style={{ background: "var(--bg-panel-glass)" }}>
          {/* Open request tabs. Same strip as the editor's — see components/TabStrip. In a narrow
              pane the sidebar's toggle sits at its start. */}
          <TabStrip
            chip
            leading={narrow && (
              <button onClick={() => setSideOpen((o) => !o)} title={sideOpen ? "Hide requests" : "Show requests"}
                className={"grid size-7 place-items-center rounded-lg transition-colors " + (sideOpen ? "text-text-primary" : "text-text-muted hover:bg-white/5 hover:text-text-primary")}
                style={sideOpen ? { background: "var(--accent-soft)" } : undefined}>
                <PanelLeft size={15} />
              </button>
            )}
            tabs={tabs.map((t) => ({
              id: t.id,
              title: t.draft.name,
              icon: <span className={`shrink-0 font-mono text-[10px] font-bold ${METHOD_TONE[t.draft.method]}`}>{t.draft.method}</span>,
              dirty: dirty(t),
              preview: t.preview,
            }))}
            activeId={activeId}
            onSelect={(id) => {
              setActiveId(id);
              revealInTree(tabs.find((t) => t.id === id)?.requestId ?? null);
            }}
            onClose={closeTab}
            onReorder={moveTab}
            onDoubleClick={promoteTab}
            onAdd={() => openScratch()}
            addTitle="New request (unsaved)"
          />

          {!active || !tab ? (
            <div className="scroll-thin flex flex-1 overflow-y-auto px-6">
              <div className="m-auto flex w-full max-w-[420px] flex-col gap-3 py-8">
                <div className="flex items-start gap-2.5 rounded-lg border border-subtle bg-elev px-3 py-3 text-[12px] leading-relaxed text-text-muted">
                  <Send size={16} className="mt-0.5 shrink-0" />
                  <span>No request open. Pick one from a collection, start a new one, or paste a curl command to turn it into a request.</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => openScratch()} className={primaryBtn}><Plus size={14} />New request</button>
                  <button onClick={() => void importCurl()} className={secondaryBtn}><TerminalSquare size={14} />Paste a curl command</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              {/* URL bar */}
              <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5 pt-2.5">
                <MethodPicker value={active.method} onChange={(method) => patchActive({ method })} />

                <div className="flex h-8 min-w-0 flex-1 items-center rounded-lg border border-subtle bg-elev px-3 transition-colors focus-within:border-[var(--accent)]">
                  <VarInput
                    value={active.url}
                    onChange={(url) => patchActive({
                      url,
                      // The grid mirrors the URL, both ways.
                      params: paramsFromUrl(url, active.params),
                      pathParams: pathParamsFromUrl(url, active.pathParams),
                    })}
                    onEnter={send}
                    vars={vars}
                    placeholder="https://api.example.com/endpoint"
                    className="font-mono text-xs text-text-primary"
                  />
                </div>

                <button
                  onClick={send}
                  disabled={busy || !active.url.trim()}
                  title="Send (Ctrl+Enter)"
                  className={primaryBtn}
                >
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                  Send
                </button>
                <button
                  onClick={saveTab}
                  disabled={!dirty(tab)}
                  title="Save (Ctrl+S)"
                  className="grid size-8 shrink-0 place-items-center rounded-lg border border-subtle bg-elev text-text-secondary transition-colors hover:border-strong hover:text-text-primary disabled:opacity-40 disabled:hover:border-subtle"
                >
                  <Save size={14} />
                </button>
              </div>

              {/* request tabs */}
              <div className="flex shrink-0 items-center border-b border-subtle px-2">
                {(["params", "headers", "body", "auth", "scripts"] as const).map((t) => {
                  const n = t === "params" ? active.params.filter((r) => r.on && r.key).length
                    : t === "headers" ? active.headers.filter((r) => r.on && r.key).length : 0;
                  return (
                    <button
                      key={t}
                      onClick={() => setReqTab(t)}
                      className={
                        "flex items-center gap-1.5 px-3 py-2 text-xs capitalize transition " +
                        (reqTab === t
                          ? "border-b-2 border-accent text-text-primary"
                          : "border-b-2 border-transparent text-text-muted hover:text-text-secondary")
                      }
                    >
                      {t}
                      {n > 0 && <Badge>{n}</Badge>}
                      {t === "body" && active.bodyKind !== "none" && <Dot />}
                      {t === "auth" && active.auth.kind !== "none" && <Dot />}
                      {t === "scripts" && (active.preScript?.trim() || active.postScript?.trim()) && <Dot />}
                    </button>
                  );
                })}
                <input
                  value={active.name}
                  onChange={(e) => patchActive({ name: e.target.value })}
                  title="Request name"
                  className="ml-auto h-6 w-44 rounded-md border border-transparent bg-transparent px-2 text-right text-[12px] text-text-muted outline-none transition-colors placeholder:text-text-muted hover:border-subtle focus:border-[var(--accent)] focus:bg-elev focus:text-text-primary"
                  placeholder="Request name"
                />
              </div>

              {/* request editor */}
              <div className="min-h-0 flex-1">
                {reqTab === "params" && (
                  <div className="flex h-full flex-col">
                    {active.pathParams.length > 0 && (
                      <div className="shrink-0">
                        <SectionLabel>Path variables</SectionLabel>
                        <KeyValueGrid
                          rows={active.pathParams}
                          onChange={(pathParams) => patchActive({ pathParams })}
                          vars={vars}
                          keyLabel="Variable"
                          readOnlyKeys
                          noAdd
                        />
                        <SectionLabel>Query params</SectionLabel>
                      </div>
                    )}
                    <div className="min-h-0 flex-1">
                      <KeyValueGrid
                        rows={active.params}
                        onChange={(params) => patchActive({ params, url: applyParamsToUrl(active.url, params) })}
                        vars={vars}
                        keyLabel="Parameter"
                      />
                    </div>
                  </div>
                )}
                {reqTab === "headers" && (
                  <KeyValueGrid
                    rows={active.headers}
                    onChange={(headers) => patchActive({ headers })}
                    vars={vars}
                    keyLabel="Header"
                    keySuggestions={COMMON_HEADERS}
                    headerExtra={
                      <button
                        onClick={(e) => {
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          const taken = new Set(active.headers.map((h) => h.key.toLowerCase()));
                          setMenu({
                            // alignRight: the button sits at the panel's right edge, so a menu
                            // growing rightward from it runs off the window.
                            x: r.right, y: r.bottom, alignRight: true,
                            items: QUICK_HEADERS.map((h) => ({
                              label: h.name,
                              subLabel: h.description,
                              // Already present: shown, but not addable twice.
                              disabled: taken.has(h.name.toLowerCase()),
                              onClick: () => patchActive({
                                headers: [...active.headers, { on: true, key: h.name, value: h.common ?? "" }],
                              }),
                            })),
                          });
                        }}
                        title="Add a common header"
                        className="flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-normal text-text-muted transition-colors hover:bg-white/10 hover:text-text-primary"
                      >
                        <Plus size={11} /> Common
                      </button>
                    }
                  />
                )}
                {reqTab === "body" && <BodyEditor req={active} patch={patchActive} vars={vars} onSave={saveTab} />}
                {reqTab === "auth" && <AuthEditor req={active} patch={patchActive} vars={vars} />}
                {reqTab === "scripts" && <ScriptEditor req={active} patch={patchActive} onSave={saveTab} />}
              </div>

              {/* response — fixed height, dragged by its own header row */}
              <div
                className="shrink-0 border-t border-subtle"
                style={{ height: respCollapsed ? undefined : respHeight }}
              >
                <ResponseView
                  result={results[tab.id] ?? null}
                  error={errors[tab.id] ?? ""}
                  busy={busy}
                  collapsed={respCollapsed}
                  onToggleCollapse={() => setRespCollapsed((c) => !c)}
                  onCancel={cancel}
                  dragHandleProps={respDrag}
                  scripts={scriptRuns[tab.id]}
                  noEnvironment={!activeWs?.activeEnvId}
                  url={tab.draft.url}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} alignRight={menu.alignRight} onClose={() => setMenu(null)} />}

      {editEnv && <EnvDialog col={col} envId={editEnv} update={update} onClose={() => setEditEnv(null)}
        confirm={setConfirm} asking={!!confirm} />}

      {confirm && <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />}

      {exportAsk && createPortal(
        // Portalled, like Deck's own dialogs: a transformed ancestor would otherwise clip `fixed`.
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50 backdrop-blur-[2px]"
             onClick={() => setExportAsk(null)}>
          <div className="w-[400px] max-w-[90vw] overflow-hidden rounded-[12px] border border-subtle shadow-2xl"
               style={{ background: "var(--bg-card)" }} onClick={(e) => e.stopPropagation()}>
            <div className="px-5 pb-4 pt-5">
              <p className="text-[15px] font-semibold text-text-primary">
                Export {exportAsk.scope === "workspace" ? "workspace" : "collection"} “{exportAsk.name}”
              </p>
              <p className="mt-2 text-[12.5px] leading-relaxed text-text-muted">
                Tokens and environment values make the file work as-is on another machine, and unsafe
                to commit or share.
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t border-subtle px-4 py-3">
              <button onClick={() => setExportAsk(null)} className={secondaryBtn}>
                Cancel
              </button>
              <button onClick={() => void writeExport(false)} className={secondaryBtn}>
                Without secrets
              </button>
              <button onClick={() => void writeExport(true)} className={primaryBtn}>
                With secrets
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}


// ---- workspaces -------------------------------------------------------------

/**
 * The workspace switcher, above the activity icons.
 *
 * A workspace owns its collections and its environments, so switching one swaps the whole
 * working set — the tree, the variables, and therefore where every {{base}} points.
 */
/**
 * Workspace switcher, sized to sit in the activity bar's trailing slot rather than taking a row
 * of its own.
 *
 * It is safe there because it renders the same for every view — an element that appears for one
 * view and not another changes the row's content width and slides the icons sideways.
 *
 * Renaming happens in a prompt-style dialog rather than inline: an input cannot share this row
 * without resizing it, which is the same drift the fixed slot exists to prevent.
 */
function WorkspaceBar({
  col, active, onSwitch, onAdd, onRename, onDelete, onExport, onImport, onMenu,
}: {
  col: Collections;
  active: Workspace | null;
  onSwitch: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onExport: () => void;
  onImport: () => void;
  onMenu: (x: number, y: number, items: MenuEntry[]) => void;
}) {
  const [ask, setAsk] = useState<NamePromptState | null>(null);
  const rename = (w: Workspace) => setAsk({
    title: "Rename workspace", initial: w.name, confirmLabel: "Rename",
    onSave: (name) => onRename(w.id, name),
  });

  return (
    <>
      <button
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onMenu(r.right, r.bottom, [
            ...col.workspaces.map((w) => ({
              label: w.name,
              dot: w.id === active?.id ? ("ok" as const) : undefined,
              onClick: () => onSwitch(w.id),
            })),
            "sep" as const,
            { label: "New workspace", icon: Plus, onClick: onAdd },
            ...(active ? [{ label: "Rename workspace", icon: Pencil, onClick: () => rename(active) }] : []),
            ...(active ? [{ label: "Export workspace…", icon: Download, onClick: onExport }] : []),
            { label: "Import workspace…", icon: Upload, onClick: onImport },
            // The last workspace cannot go: with none left there is nowhere to put a request.
            ...(active && col.workspaces.length > 1
              ? [{ label: `Delete "${active.name}"`, icon: Trash2, danger: true, onClick: () => onDelete(active.id) }]
              : []),
          ]);
        }}
        className="flex h-7 min-w-0 items-center gap-1 rounded-lg px-2 text-[12px] text-text-primary transition-colors hover:bg-white/5"
        title="Switch workspace"
      >
        <span className="max-w-[110px] truncate font-medium">{active?.name ?? "No workspace"}</span>
        <ChevronDown size={12} className="shrink-0 text-text-muted" />
      </button>

      <NamePrompt state={ask} onClose={() => setAsk(null)} />
    </>
  );
}

/**
 * What an import will add, shown before it happens.
 *
 * An import is not obviously reversible — it lands in whatever workspace is open, and undoing it
 * means deleting the pieces by hand. The two things worth knowing before saying yes are how much
 * arrives and whether the file carries secrets, so both are stated plainly rather than being
 * discovered afterwards in a notification.
 */
function ImportSummaryBody({ sum, target }: { sum: ImportSummary; target: string }) {
  const n = (count: number, one: string, many = `${one}s`) =>
    `${count} ${count === 1 ? one : many}`;
  const parts = [
    n(sum.collections, "collection"),
    ...(sum.folders > 0 ? [n(sum.folders, "folder")] : []),
    n(sum.requests, "request"),
    ...(sum.environments > 0 ? [n(sum.environments, "environment")] : []),
  ];
  return (
    <>
      <p>
        <span className="text-text-primary">{sum.name}</span> adds {parts.join(", ")} to {target}.
      </p>
      {sum.renamed.length > 0 && (
        <p className="mt-2">
          {sum.renamed.length === 1 ? "A collection called " : "Collections called "}
          <span className="text-text-primary">{sum.renamed.join(", ")}</span>
          {sum.renamed.length === 1 ? " already exists" : " already exist"} here — the imported
          {sum.renamed.length === 1 ? " one arrives" : " ones arrive"} under a numbered name.
          Nothing you already have is changed.
        </p>
      )}
      <p className="mt-2">
        {sum.secrets
          ? "The file includes secrets — auth tokens and environment values come with it."
          : "The file was exported without secrets, so auth tokens and environment values will be blank."}
      </p>
    </>
  );
}

// ---- body -------------------------------------------------------------------

const PLACEHOLDER_JSON = '{\n  "key": "value"\n}';

const BODY_KINDS: BodyKind[] = ["none", "json", "text", "form"];

/** What a kind is called on its button, where capitalising the id is not the word. */
const KIND_LABEL: Record<string, string> = { json: "JSON", pre: "Pre-request", post: "Post-response" };

/**
 * The pill row that picks a body kind or an auth kind.
 *
 * One component because the two had drifted into different paddings and different surrounding
 * chrome — the body's pills sat in a bordered header, auth's floated inside the pane — which read
 * as two unrelated controls doing the same job.
 */
function SegmentedTabs<T extends string>({
  options, value, onChange, trailing,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  /** Right of the pills, on the same row — a Beautify button, a parse error. */
  trailing?: React.ReactNode;
}) {
  // Deck's grouped-buttons look: one box on the elevated surface, the picked one in the accent.
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 px-2">
      <div className="flex items-center gap-0.5 rounded-lg border border-subtle bg-elev p-0.5">
        {options.map((k) => (
          <button
            key={k}
            onClick={() => onChange(k)}
            className={
              "h-6 rounded-md px-2 text-[11.5px] transition-colors " +
              (value === k ? "text-text-primary" : "text-text-muted hover:bg-white/5 hover:text-text-primary")
            }
            style={value === k ? { background: "var(--accent-soft)" } : undefined}
          >
            {KIND_LABEL[k] ?? k.charAt(0).toUpperCase() + k.slice(1)}
          </button>
        ))}
      </div>
      {trailing}
    </div>
  );
}

function BodyEditor({
  req, patch, vars, onSave,
}: { req: Request; patch: (p: Partial<Request>) => void; vars: Record<string, string>; onSave: () => void }) {
  const [err, setErr] = useState("");

  const beautify = () => {
    try {
      patch({ body: JSON.stringify(JSON.parse(req.body), null, 2) });
      setErr("");
    } catch (e) {
      setErr(String(e).replace(/^SyntaxError:\s*/, ""));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <SegmentedTabs
        options={BODY_KINDS}
        value={req.bodyKind}
        onChange={(bodyKind) => patch({ bodyKind })}
        trailing={
          <>
            {err && <span className="ml-2 truncate text-[11px] text-red-400" title={err}>{err}</span>}
            {req.bodyKind === "json" && (
              <button
                onClick={beautify}
                className={"ml-auto " + smallBtn}
              >
                Beautify
              </button>
            )}
          </>
        }
      />
      {req.bodyKind === "none" && <Centered>This request sends no body. Pick JSON, Text or Form above to add one.</Centered>}
      {req.bodyKind === "form" && (
        <KeyValueGrid rows={req.formRows} onChange={(formRows) => patch({ formRows })} vars={vars}
          keyLabel="Field" valueLabel="Value" allowFiles />
      )}
      {(req.bodyKind === "json" || req.bodyKind === "text") && (
        // Monaco, the same engine and theme as the editor, so a JSON body gets syntax colouring,
        // bracket matching and validation instead of being plain text in a textarea.
        <div className="min-h-0 flex-1">
          <CodeBox
            value={req.body}
            onChange={(body) => { patch({ body }); if (err) setErr(""); }}
            language={req.bodyKind === "json" ? "json" : "plaintext"}
            placeholder={req.bodyKind === "json" ? PLACEHOLDER_JSON : "Request body"}
            templateVars
            folding
            onSave={onSave}
          />
        </div>
      )}
    </div>
  );
}

// ---- auth -------------------------------------------------------------------

const AUTH_KINDS = ["none", "bearer", "basic"] as const;

/**
 * Pre-request and post-response scripts for one request.
 *
 * The same segmented row the body and auth tabs use, so the three panels behave alike; the
 * hint on the right is what tells a first-time reader that `pm` is the thing to type.
 */
function ScriptEditor({
  req, patch, onSave,
}: {
  req: Request;
  patch: (p: Partial<Request>) => void;
  onSave: () => void;
}) {
  const [which, setWhich] = useState<"pre" | "post">("pre");
  const [docs, setDocs] = useState(false);
  const value = which === "pre" ? req.preScript ?? "" : req.postScript ?? "";

  // Appended rather than replacing: a snippet is usually added to a script that already exists.
  const insert = (code: string) => {
    const next = value.trim() ? `${value.replace(/\s+$/, "")}\n\n${code}` : code;
    patch(which === "pre" ? { preScript: next } : { postScript: next });
  };

  return (
    <div className="flex h-full flex-col">
      <SegmentedTabs
        options={["pre", "post"] as const}
        value={which}
        onChange={setWhich}
        trailing={
          <>
            {(which === "pre" ? req.postScript : req.preScript)?.trim() && (
              <span className="pl-1" title="The other script has content"><Dot /></span>
            )}
            <span className="ml-auto truncate pl-3 text-[11.5px] text-text-muted">
              {which === "pre"
                ? "Before sending — pm.environment.set(\"token\", …)"
                : "On the response — pm.test(…), pm.response.json()"}
            </span>
            {/* A toggle: lit, with the accent ring, while the reference is showing. */}
            <button
              onClick={() => setDocs((d) => !d)}
              className={"ml-2 " + (docs ? smallBtnOn : smallBtn)}
              style={docs ? { background: "var(--accent-soft)", boxShadow: "inset 0 0 0 1px var(--accent)" } : undefined}
            >
              Docs
            </button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <CodeBox
            value={value}
            language="javascript"
            onChange={(v) => patch(which === "pre" ? { preScript: v } : { postScript: v })}
            folding
            onSave={onSave}
          />
        </div>
        {docs && <ScriptDocs which={which} onInsert={insert} />}
      </div>
    </div>
  );
}

/**
 * The `pm` reference beside the editor.
 *
 * Beside rather than in a dialog: writing a script means reading the signature and typing it in
 * the same breath, and a dialog would have to be dismissed between the two.
 */
function ScriptDocs({ which, onInsert }: { which: "pre" | "post"; onInsert: (code: string) => void }) {
  const snippets = SNIPPETS.filter((x) => x.scope === which);
  const groups = PM_REFERENCE.filter((g) => g.scope === "both" || g.scope === which);
  return (
    <div className="scroll-thin w-80 shrink-0 overflow-auto border-l border-subtle p-3">
      <p className="mb-3 text-[11.5px] leading-relaxed text-text-muted">{SANDBOX_NOTE}</p>

      <div className="mb-1.5 text-[12px] font-medium text-text-secondary">Examples</div>
      <div className="mb-4 flex flex-wrap gap-1">
        {snippets.map((sn) => (
          <button
            key={sn.label}
            onClick={() => onInsert(sn.code)}
            title={sn.code}
            className="h-6 rounded-md border border-subtle bg-elev px-2 text-[11.5px] text-text-secondary transition-colors hover:border-strong hover:text-text-primary"
          >
            {sn.label}
          </button>
        ))}
      </div>

      {groups.map((g) => (
        <div key={g.title} className="mb-4 last:mb-0">
          <div className="mb-1.5 text-[12px] font-medium text-text-secondary">{g.title}</div>
          {g.entries.map((e) => (
            <div key={e.sig} className="mb-2 last:mb-0">
              <code className="block break-all font-mono text-[11px] text-text-primary">{e.sig}</code>
              <div className="text-[11px] leading-snug text-text-muted">{e.what}</div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function AuthEditor({
  req, patch, vars,
}: { req: Request; patch: (p: Partial<Request>) => void; vars: Record<string, string> }) {
  const a = req.auth;
  return (
    <div className="flex h-full flex-col">
      <SegmentedTabs
        options={AUTH_KINDS}
        value={a.kind}
        onChange={(k) => patch({
          auth: k === "none" ? { kind: "none" }
            : k === "bearer" ? { kind: "bearer", token: "" }
            : { kind: "basic", user: "", pass: "" },
        })}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {a.kind === "none" && <p className="text-[12px] text-text-muted">No authorization header is added. Pick Bearer or Basic above to send one.</p>}
        {a.kind === "bearer" && (
          <AuthField label="Token" value={a.token} onChange={(token) => patch({ auth: { ...a, token } })} vars={vars}
            hint="Use {{name}} to pull the token from the environment instead of typing it here." />
        )}
        {a.kind === "basic" && (
          <div className="max-w-md space-y-2">
            <AuthField label="Username" value={a.user} onChange={(user) => patch({ auth: { ...a, user } })} vars={vars} />
            <AuthField label="Password" value={a.pass} onChange={(pass) => patch({ auth: { ...a, pass } })} vars={vars} />
          </div>
        )}
      </div>
    </div>
  );
}

function AuthField({
  label, value, onChange, vars, hint,
}: { label: string; value: string; onChange: (v: string) => void; vars: Record<string, string>; hint?: string }) {
  return (
    <div className="max-w-md">
      <span className="mb-1 block text-[12px] font-medium text-text-secondary">{label}</span>
      <div className="flex h-8 items-center rounded-lg border border-subtle bg-elev px-2.5 transition-colors focus-within:border-[var(--accent)]">
        <VarInput value={value} onChange={onChange} vars={vars} className="font-mono text-xs text-text-primary" />
      </div>
      {hint && <span className="mt-1 block text-[11px] text-text-muted">{hint}</span>}
    </div>
  );
}

// ---- environments -----------------------------------------------------------

/**
 * Environments, as a sidebar view rather than a modal.
 *
 * The active environment is picked here too — it used to sit in a top bar above the whole
 * module, which spent a full row on one dropdown. The variable grid gets the panel's width,
 * which is what it actually needs.
 */
/**
 * Variable editor for one environment, as a modal.
 *
 * Environments used to be a third sidebar view, which cost a whole panel for what is a short list
 * you pick from and edit occasionally. The picker is a popup on the activity bar's globe now, and
 * this dialog is where the variables themselves get edited — reachable from that popup and from
 * the URL bar's selector.
 */
function EnvDialog({
  col, envId, update, onClose, confirm, asking,
}: {
  col: Collections;
  envId: string;
  update: (p: (c: Collections) => Collections) => void;
  onClose: () => void;
  /** Ask before deleting, in the screen's one ConfirmDialog. */
  confirm: (s: ConfirmState) => void;
  /** That dialog is open over this one: its Escape is its own, not a reason to close this. */
  asking: boolean;
}) {
  const env = col.environments.find((e) => e.id === envId) ?? null;
  const activeEnvId = col.workspaces.find((w) => w.id === col.activeWorkspaceId)?.activeEnvId ?? null;

  // Escape heard in the window the dialog is in: Deck's main one, or a floating window.
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const win = boxRef.current?.ownerDocument.defaultView ?? window;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !asking) onClose(); };
    win.addEventListener("keydown", onKey);
    return () => win.removeEventListener("keydown", onKey);
  }, [onClose, asking, !!env]);

  // Deleted from under us (another window, or the workspace switched) — nothing to show.
  if (!env) return null;

  const patch = (p: Partial<Environment>) =>
    update((c) => ({ ...c, environments: c.environments.map((x) => (x.id === env.id ? { ...x, ...p } : x)) }));

  // Portalled, like Deck's own dialogs: a transformed ancestor would otherwise clip `fixed`.
  return createPortal(
    <div ref={boxRef}
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="flex h-[70vh] w-[560px] max-w-[90vw] flex-col overflow-hidden rounded-[12px] border border-subtle shadow-2xl"
        style={{ background: "var(--bg-card)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-subtle px-3">
          <Globe size={14} className="shrink-0 text-text-muted" />
          <input
            value={env.name}
            onChange={(e) => patch({ name: e.target.value })}
            onFocus={(e) => e.target.select()}
            title="Environment name — click to rename"
            className="h-8 min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 text-[13px] font-medium text-text-primary outline-none transition-colors hover:border-subtle focus:border-[var(--accent)] focus:bg-elev"
          />
          {activeEnvId === env.id ? (
            <span className="shrink-0 rounded-full px-1.5 py-px text-[10.5px]"
                  style={{ color: ACTIVE_TONE, background: `color-mix(in srgb, ${ACTIVE_TONE} 14%, transparent)` }}
                  title="Active — {{name}} resolves against this environment">
              Active
            </span>
          ) : (
            <button
              onClick={() => update((c) => ({
                ...c,
                workspaces: c.workspaces.map((w) => (w.id === c.activeWorkspaceId ? { ...w, activeEnvId: env.id } : w)),
              }))}
              title="Make this the environment {{name}} resolves against"
              className="flex h-7 shrink-0 items-center rounded-lg border border-subtle bg-elev px-2.5 text-[11.5px] text-text-secondary transition-colors hover:border-strong hover:text-text-primary"
            >
              Use
            </button>
          )}
          <button
            onClick={() => confirm({
              title: `Delete the environment ${env.name}?`,
              body: `This also deletes its ${env.vars.length} variable${env.vars.length === 1 ? "" : "s"}; requests that use them stay, with those {{names}} left unresolved.`,
              confirmLabel: "Delete",
              onConfirm: () => {
                update((c) => ({
                  ...c,
                  environments: c.environments.filter((x) => x.id !== env.id),
                  // An environment that no longer exists cannot stay active, or {{vars}} resolve to
                  // nothing with no sign of why.
                  workspaces: c.workspaces.map((w) => (w.activeEnvId === env.id ? { ...w, activeEnvId: null } : w)),
                }));
                onClose();
              },
            })}
            title="Delete environment"
            className={toolDangerBtn}
          >
            <Trash2 size={14} />
          </button>
          <button onClick={onClose} title="Close" className={toolBtn}>
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {/* vars={{}} — a {{...}} inside an environment value is not expanded, matching the
              single-pass rule in substitute(). */}
          <KeyValueGrid
            rows={env.vars}
            onChange={(v) => patch({ vars: v })}
            vars={{}}
            keyLabel="Variable"
            valueLabel="Value"
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---- bits -------------------------------------------------------------------

// Deck's button and icon-button shapes (docs/design.md), named once for the screens above.
/** The one accent-filled action on a screen. */
const primaryBtn = "flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium text-white transition hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100 bg-[var(--accent)]";
/** Every other button beside it. */
const secondaryBtn = "flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-subtle bg-elev px-3 text-[12.5px] text-text-secondary transition-colors hover:border-strong hover:text-text-primary";
/** A small text button in a panel's toolbar row (Beautify, Docs). */
const smallBtn = "flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11.5px] text-text-muted transition-colors hover:bg-white/5 hover:text-text-primary";
const smallBtnOn = "flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11.5px] text-text-primary transition-colors";
/** A toolbar icon button. */
const toolBtn = "grid size-7 shrink-0 place-items-center rounded-lg text-text-muted transition-colors hover:bg-white/5 hover:text-text-primary";
/** The same, for something that destroys: red only under the pointer. */
const toolDangerBtn = "grid size-7 shrink-0 place-items-center rounded-lg text-text-muted transition-colors hover:bg-white/5 hover:text-red-400";
/** The "this one is in use" chip colour. */
const ACTIVE_TONE = "rgb(var(--tone-green-400))";

const Centered = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-text-muted">{children}</div>
);
const Dot = () => <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />;

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="px-3 pb-1 pt-2 text-[12px] font-medium text-text-secondary">
    {children}
  </div>
);

/** A count after a tab's name, as Deck's count chips are drawn. */
const Badge = ({ children }: { children: React.ReactNode }) => (
  <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-elev px-1.5 text-[10.5px] text-text-secondary">
    {children}
  </span>
);
