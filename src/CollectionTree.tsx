// The collections sidebar: nested folders, drag to move or reorder, right-click menus.
//
// Rows come from components/TreeRow, shared with the editor's file explorer, and dragging goes
// through components/dragrow — pointer events, not HTML5. See that file for why HTML5 DnD
// cannot work in this window at all.
//
// Per-row actions live in the context menu rather than as hover buttons inside a row: a nested
// control would swallow the mousedown that starts a drag.
import { useState } from "react";
import { ChevronRight, Plus, Trash2, Copy, FolderPlus, Pencil, FileUp, Download, TerminalSquare, Folder as FolderIcon } from "lucide-react";
import type { Collections, Folder, Request } from "./httpclient";
import { METHOD_TONE } from "./methods";
import { TreeRow, useRowDrag, type DropTarget, type MenuEntry } from "../shim/ui.js";

// Dragging is pointer-based (components/dragrow.ts), not HTML5. HTML5 DnD is dead in this
// window: dragDropEnabled in tauri.conf makes wry take over the webview's OLE drop target, and
// Chromium routes HTML5 drag through that same channel, so no dragover ever fires.

export interface TreeCallbacks {
  onOpen: (r: Request) => void;
  onAddRequest: (folderId: string) => void;
  onAddFolder: (parentId: string) => void;
  onAddCollection: () => void;
  onRename: (id: string, name: string) => void;
  onRenameRequest: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onDeleteRequest: (id: string) => void;
  onDuplicateRequest: (id: string) => void;
  onCopyCurl: (id: string, resolved: boolean) => void;
  onExportCollection: (id: string) => void;
  onMove: (id: string, toFolderId: string, beforeId?: string) => void;
  onMoveToRoot: (id: string) => void;
  onMenu: (x: number, y: number, items: MenuEntry[]) => void;
  /** Request id of the tab in view, for the selection highlight. */
  activeRequestId: string | null;
  /** Request ids whose open tab has unsaved edits. */
  dirtyRequestIds: Set<string>;
}

export default function CollectionTree({
  col, filter, collapsed, setCollapsed, cb,
}: {
  col: Collections;
  filter: string;
  collapsed: Set<string>;
  setCollapsed: (f: (s: Set<string>) => Set<string>) => void;
  cb: TreeCallbacks;
}) {
  const q = filter.trim().toLowerCase();

  // One drag controller for the whole tree; rows only report where the press started.
  const { dragId, over, startDrag } = useRowDrag((id, target) => {
    // Empty space below the tree = promote a folder to its own collection.
    if (!target) { cb.onMoveToRoot(id); return; }
    if (target.id === id) return;
    // Folders only, as in the editor: a request is not a container, and dropping on one used to
    // reorder in a way that made a misaimed drop look like a move.
    if (target.kind !== "folder") return;
    cb.onMove(id, target.id);
  });

  // While filtering, a folder is shown when something below it matches. The whole visible set is
  // collected up front so a deep match keeps its entire ancestor chain on screen.
  const visible = (() => {
    if (!q) return null;
    const set = new Set<string>();
    for (const r of Object.values(col.requests)) {
      if (!r.name.toLowerCase().includes(q) && !r.url.toLowerCase().includes(q)) continue;
      set.add(r.id);
      let p = col.folders.find((f) => f.children.includes(r.id));
      while (p) {
        set.add(p.id);
        p = p.parentId ? col.folders.find((f) => f.id === p!.parentId) : undefined;
      }
    }
    return set;
  })();

  const roots = col.folders.filter((f) => f.parentId === null && (!visible || visible.has(f.id)));

  return (
    <div
      className="flex min-h-full flex-col px-1.5"
      onContextMenu={(e) => {
        e.preventDefault();
        cb.onMenu(e.clientX, e.clientY, [{ label: "New collection", icon: FolderPlus, onClick: cb.onAddCollection }]);
      }}
    >
      {col.folders.filter((f) => f.parentId === null).length === 0 && (
        <p className="px-2 py-3 text-xs text-text-muted">No collections yet.</p>
      )}
      {roots.map((f) => (
        <FolderNode key={f.id} folder={f} col={col} depth={0} visible={visible}
                    collapsed={collapsed} setCollapsed={setCollapsed} cb={cb}
                    dragId={dragId} over={over} startDrag={startDrag} />
      ))}

      {/*
        Empty space below the tree. Dropping here promotes a folder to its own collection —
        rowAt() finds no row, which the drop handler reads as "the root". It gets a minimum
        height so the target still exists when the tree fills the panel.
      */}
      <div className="min-h-[3rem] flex-1" />
    </div>
  );
}

interface DragProps {
  dragId: string | null;
  over: DropTarget | null;
  startDrag: (id: string) => (e: React.MouseEvent) => void;
}

function FolderNode({
  folder, col, depth, visible, collapsed, setCollapsed, cb, dragId, over, startDrag,
}: {
  folder: Folder;
  col: Collections;
  depth: number;
  visible: Set<string> | null;
  collapsed: Set<string>;
  setCollapsed: (f: (s: Set<string>) => Set<string>) => void;
  cb: TreeCallbacks;
} & DragProps) {
  // Filtering force-expands: a hidden match is the same as no match.
  const open = visible !== null || !collapsed.has(folder.id);
  const [renaming, setRenaming] = useState(false);
  // Highlighted only when it is the row under the cursor and not the row being dragged.
  const hint = over?.id === folder.id && dragId !== null && dragId !== folder.id;

  const isCollection = folder.parentId === null;

  const menu = (x: number, y: number) => cb.onMenu(x, y, [
    { label: "New request", icon: Plus, onClick: () => cb.onAddRequest(folder.id) },
    { label: "New folder", icon: FolderPlus, onClick: () => cb.onAddFolder(folder.id) },
    "sep",
    { label: "Rename", icon: Pencil, hint: "F2", onClick: () => setRenaming(true) },
    ...(isCollection ? [] : [{ label: "Move to top level", icon: FileUp, onClick: () => cb.onMoveToRoot(folder.id) }]),
    ...(isCollection ? [{ label: "Export…", icon: Download, onClick: () => cb.onExportCollection(folder.id) }] : []),
    "sep",
    { label: isCollection ? "Delete collection" : "Delete folder", icon: Trash2, danger: true,
      onClick: () => cb.onDeleteFolder(folder.id) },
  ]);

  const children = folder.children
    .map((id) => col.folders.find((f) => f.id === id) ?? col.requests[id])
    .filter((n): n is Folder | Request => !!n && (!visible || visible.has(n.id)));

  const drag = { dragId, over, startDrag };
  const kids = open
    ? children.map((n) => renderChild(n, folder.id, depth + 1, col, visible, collapsed, setCollapsed, cb, drag))
    : null;

  // Renaming replaces the row rather than nesting an input inside it: an input within a
  // draggable button takes the press, and the row could then never be dragged — the exact bug
  // this file exists to stop repeating.
  if (renaming) {
    return (
      <>
        <div className="flex items-center gap-1.5 py-1 pr-2" style={{ paddingLeft: 6 + depth * 14 }}>
          <span className="w-[13px] shrink-0" />
          <input
            autoFocus
            defaultValue={folder.name}
            onBlur={(e) => { cb.onRename(folder.id, e.target.value.trim() || folder.name); setRenaming(false); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              // Escape reverts; blur would otherwise commit whatever was half-typed.
              else if (e.key === "Escape") { setRenaming(false); e.preventDefault(); }
            }}
            className="min-w-0 flex-1 rounded bg-elev px-1 text-sm text-text-primary outline-none ring-1 ring-[var(--accent)]"
          />
        </div>
        {kids}
      </>
    );
  }

  return (
    <>
      <TreeRow
        depth={depth}
        dropHint={hint}
        dragId={folder.id}
        dragParentId={folder.parentId}
        dragKind="folder"
        onMouseDown={startDrag(folder.id)}
        onClick={() => setCollapsed((st) => {
          const n = new Set(st);
          if (n.has(folder.id)) n.delete(folder.id); else n.add(folder.id);
          return n;
        })}
        // Rename is the context menu (and F2, which that menu advertises). Not double-click: a
        // folder row's double-click is two collapses in a row, and turning that into a rename
        // put the tree into edit mode by accident.
        onKeyDown={(e) => { if (e.key === "F2") { e.preventDefault(); setRenaming(true); } }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); menu(e.clientX, e.clientY); }}
        leading={
          <>
            <ChevronRight size={13} className="shrink-0 text-text-muted transition-transform"
                          style={{ transform: open ? "rotate(90deg)" : "none" }} />
            <FolderIcon size={14} className="shrink-0 text-text-muted" />
          </>
        }
        label={<span className={isCollection ? "font-medium text-text-primary" : undefined}>{folder.name}</span>}
        trailing={<span className="ml-auto shrink-0 pr-1 text-[11px] text-text-muted">{countRequests(col, folder.id)}</span>}
        title="Right-click for actions · F2 to rename"
      />
      {kids}
    </>
  );
}

function renderChild(
  n: Folder | Request, parentId: string, depth: number, col: Collections,
  visible: Set<string> | null, collapsed: Set<string>,
  setCollapsed: (f: (s: Set<string>) => Set<string>) => void, cb: TreeCallbacks,
  drag: DragProps,
) {
  return "children" in n ? (
    <FolderNode key={n.id} folder={n} col={col} depth={depth} visible={visible}
                collapsed={collapsed} setCollapsed={setCollapsed} cb={cb} {...drag} />
  ) : (
    <RequestNode key={n.id} req={n} parentId={parentId} depth={depth} cb={cb} {...drag} />
  );
}

function RequestNode({
  req, parentId, depth, cb, startDrag,
}: { req: Request; parentId: string; depth: number; cb: TreeCallbacks } & DragProps) {
  const active = cb.activeRequestId === req.id;
  const [renaming, setRenaming] = useState(false);

  // Replaces the row while renaming rather than nesting an input inside it: an input within a
  // draggable row takes the press that would start a drag. Same reason as FolderNode.
  if (renaming) {
    return (
      <div className="flex items-center gap-1.5 py-1 pr-2" style={{ paddingLeft: 6 + depth * 14 }}>
        <span className="w-[13px] shrink-0" />
        <span className={`w-10 shrink-0 font-mono text-[10px] font-bold ${METHOD_TONE[req.method]}`}>{req.method}</span>
        <input
          autoFocus
          defaultValue={req.name}
          onBlur={(e) => { cb.onRenameRequest(req.id, e.target.value.trim() || req.name); setRenaming(false); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            // Escape reverts; blur would otherwise commit whatever was half-typed.
            else if (e.key === "Escape") { setRenaming(false); e.preventDefault(); }
          }}
          className="min-w-0 flex-1 rounded bg-elev px-1 text-sm text-text-primary outline-none ring-1 ring-[var(--accent)]"
        />
      </div>
    );
  }

  return (
    <TreeRow
      depth={depth}
      active={active}
      dragId={req.id}
      dragParentId={parentId}
      onMouseDown={startDrag(req.id)}
      onClick={() => cb.onOpen(req)}
      onKeyDown={(e) => { if (e.key === "F2") { e.preventDefault(); setRenaming(true); } }}
      onContextMenu={(e) => {
        e.preventDefault(); e.stopPropagation();
        cb.onMenu(e.clientX, e.clientY, [
          { label: "Rename", icon: Pencil, hint: "F2", onClick: () => setRenaming(true) },
          { label: "Duplicate", icon: Copy, onClick: () => cb.onDuplicateRequest(req.id) },
          { label: "Copy as cURL", subLabel: "{{variables}} left as-is", icon: TerminalSquare,
            onClick: () => cb.onCopyCurl(req.id, false) },
          { label: "Copy as cURL (resolved)", subLabel: "environment values filled in", icon: TerminalSquare,
            onClick: () => cb.onCopyCurl(req.id, true) },
          "sep",
          { label: "Delete", icon: Trash2, danger: true, onClick: () => cb.onDeleteRequest(req.id) },
        ]);
      }}
      leading={
        <>
          <span className="w-[13px] shrink-0" />
          <span className={`w-10 shrink-0 font-mono text-[10px] font-bold ${METHOD_TONE[req.method]}`}>{req.method}</span>
        </>
      }
      label={req.name}
      trailing={cb.dirtyRequestIds.has(req.id)
        ? <span className="ml-auto mr-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "#e2c08d" }} title="Unsaved changes" />
        : undefined}
    />
  );
}

/** Requests anywhere beneath a folder — the count people expect on a collection. */
function countRequests(col: Collections, folderId: string): number {
  const f = col.folders.find((x) => x.id === folderId);
  if (!f) return 0;
  return f.children.reduce(
    (n, c) => n + (col.folders.some((x) => x.id === c) ? countRequests(col, c) : col.requests[c] ? 1 : 0),
    0,
  );
}
