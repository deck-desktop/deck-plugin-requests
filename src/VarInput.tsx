// A single-line text field that renders {{variable}} tokens inline, with autocomplete.
//
// It is a contenteditable div rather than an <input>, because an input cannot draw a coloured
// span inside its own text. The usual workaround — a highlighted div positioned behind a
// transparent input — has to keep two boxes in pixel-perfect sync, and the UA's own padding on
// the input makes that fragile. Doing all the rendering in one element sidesteps that.
import { useEffect, useMemo, useRef, useState } from "react";
import { paint } from "./paint";
import { DYNAMIC_VARS } from "./httpdynamic";

export default function VarInput({
  value, onChange, onEnter, vars, placeholder, className = "", readOnly, suggestions,
}: {
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
  /** Known variable names → resolved values. Drives both the colouring and the popup. */
  vars: Record<string, string>;
  placeholder?: string;
  className?: string;
  readOnly?: boolean;
  /** Whole-field completions (e.g. HTTP header names), offered when the caret is not inside a
   *  {{ token. The description shows on the right of each row. */
  suggestions?: { name: string; description?: string }[];
}) {
  // What paint() treats as "known". Generators are included so {{$guid}} colours as valid; the
  // tooltip then shows a description for those and the resolved value for environment vars.
  const known = useMemo(() => ({
    ...Object.fromEntries(Object.entries(DYNAMIC_VARS).map(([k, d]) => [k, d.description])),
    ...vars,
  }), [vars]);

  const ref = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<{ filter: string; at: number } | null>(null);
  const [sel, setSel] = useState(0);

  // Environment variables first (they resolve to a real value the user set), then the built-in
  // generators. Each carries the text shown on the right of its row: a value, or a description.
  const entries = useMemo(() => {
    const env = Object.keys(vars).sort().map((n) => ({ name: n, hint: vars[n], dynamic: false }));
    const dyn = Object.entries(DYNAMIC_VARS).map(([n, d]) => ({ name: n, hint: d.description, dynamic: true }));
    return [...env, ...dyn];
  }, [vars]);

  const matches = useMemo(() => {
    if (!pop) return [];
    const f = pop.filter.toLowerCase();
    // "$" alone lists every generator, which is how you discover them without knowing a name.
    return entries.filter((e) => e.name.toLowerCase().startsWith(f));
  }, [pop, entries]);

  // Whole-field completions (header names). Only offered while the caret is outside a {{ token,
  // so the two popups can never both be open.
  const [plainOpen, setPlainOpen] = useState(false);
  const plain = useMemo(() => {
    if (!suggestions || pop) return [];
    const v = value.trim().toLowerCase();
    if (!v) return suggestions.slice(0, 12);
    return suggestions.filter((sg) => sg.name.toLowerCase().startsWith(v) && sg.name.toLowerCase() !== v).slice(0, 12);
  }, [suggestions, value, pop]);

  // Repaint only when the text differs from what's in the DOM. Rewriting innerHTML on every
  // render would drop the caret to the start of the field on each keystroke.
  useEffect(() => {
    const el = ref.current;
    if (!el || el.textContent === value) return;
    el.innerHTML = paint(value, known);
    // A value from outside (another request opened): its own text, so no undo into the last one.
    hist.current = { past: [], future: [], last: { t: value, c: value.length } };
  }, [value, known]);

  // Undo kept here, because the browser's own cannot survive the field: every repaint rewrites
  // innerHTML, and that empties the native undo stack, so Ctrl+Z did nothing at all.
  type Snap = { t: string; c: number };
  const hist = useRef<{ past: Snap[]; future: Snap[]; last: Snap }>({ past: [], future: [], last: { t: value, c: value.length } });
  const remember = (next: Snap) => {
    const h = hist.current;
    if (next.t === h.last.t) return;
    h.past = [...h.past.slice(-199), h.last];
    h.future = [];
    h.last = next;
  };
  const step = (back: boolean) => {
    const el = ref.current;
    const h = hist.current;
    const to = (back ? h.past : h.future).pop();
    if (!el || !to) return;
    (back ? h.future : h.past).push(h.last);
    h.last = to;
    el.innerHTML = paint(to.t, known);
    setCaret(el, to.c);
    onChange(to.t);
  };

  // Re-paint after typing: the browser inserts plain text, so tokens the user has just finished
  // typing stay unstyled until we rebuild the markup and put the caret back where it was.
  const repaint = (el: HTMLDivElement, caret: number) => {
    el.innerHTML = paint(el.textContent ?? "", known);
    setCaret(el, caret);
  };

  const handleInput = () => {
    const el = ref.current;
    if (!el) return;
    const text = el.textContent ?? "";
    const caret = getCaret(el);
    remember({ t: text, c: caret });
    onChange(text);

    // Opening a popup while the caret sits inside an unclosed {{ … .
    const before = text.slice(0, caret);
    const open = before.lastIndexOf("{{");
    const inToken = open >= 0 && !before.slice(open).includes("}}");
    setPop(inToken ? { filter: before.slice(open + 2).trim(), at: open } : null);
    setPlainOpen(!inToken);
    setSel(0);

    repaint(el, caret);
  };

  const accept = (name: string) => {
    const el = ref.current;
    if (!el || !pop) return;
    const text = el.textContent ?? "";
    const caret = getCaret(el);
    // Swallow a "}}" the user (or the browser's bracket matching) already put after the caret,
    // so accepting a suggestion never leaves "{{name}}}}".
    const tail = text.slice(caret).replace(/^\s*\}\}/, "");
    const next = `${text.slice(0, pop.at)}{{${name}}}${tail}`;
    remember({ t: next, c: pop.at + name.length + 4 });
    onChange(next);
    setPop(null);
    el.innerHTML = paint(next, known);
    setCaret(el, pop.at + name.length + 4);
  };

  const acceptPlain = (text: string) => {
    const el = ref.current;
    remember({ t: text, c: text.length });
    onChange(text);
    setPlainOpen(false);
    if (el) { el.innerHTML = paint(text, known); setCaret(el, text.length); }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === "KeyZ" || e.code === "KeyY")) {
      e.preventDefault();
      step(e.code === "KeyZ" && !e.shiftKey);
      return;
    }
    if (plainOpen && plain.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % plain.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + plain.length) % plain.length); return; }
      if (e.key === "Tab") { e.preventDefault(); acceptPlain(plain[sel].name); return; }
      if (e.key === "Escape") { e.preventDefault(); setPlainOpen(false); return; }
    }
    if (pop && matches.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % matches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + matches.length) % matches.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); accept(matches[sel].name); return; }
      if (e.key === "Escape") { e.preventDefault(); setPop(null); return; }
    }
    // Single-line field: Enter sends rather than inserting a newline. Plain Enter only: Ctrl+Enter
    // is the plugin's send binding, which also runs, so answering it here sent the request twice.
    if (e.key === "Enter") { e.preventDefault(); if (!e.ctrlKey && !e.metaKey) onEnter?.(); }
  };

  return (
    <div className="relative min-w-0 flex-1">
      <div
        ref={ref}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        spellCheck={false}
        onInput={handleInput}
        onKeyDown={onKeyDown}
        onFocus={() => { if (suggestions && !value.trim()) setPlainOpen(true); }}
        // Delay so a click on either popup lands before it is torn down.
        onBlur={() => setTimeout(() => { setPop(null); setPlainOpen(false); }, 120)}
        // Paste as plain text — otherwise copying a URL from a styled page drags its markup in.
        onPaste={(e) => {
          e.preventDefault();
          e.currentTarget.ownerDocument.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
        }}
        data-placeholder={placeholder}
        className={
          "var-input scroll-thin block w-full overflow-x-auto whitespace-pre outline-none " + className
        }
      />
      {plainOpen && plain.length > 0 && (
        <div className={POP}
             style={{ background: "var(--bg-card)" }}>
          {plain.map((sg, i) => (
            <button
              key={sg.name}
              onMouseDown={(e) => { e.preventDefault(); acceptPlain(sg.name); }}
              onMouseEnter={() => setSel(i)}
              className={ITEM + (i === sel ? "bg-white/[0.06] text-text-primary" : "text-text-secondary")}
            >
              <span className="shrink-0 font-mono">{sg.name}</span>
              {sg.description && (
                <span className="ml-auto max-w-[55%] truncate text-[11px] text-text-muted">{sg.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {pop && matches.length > 0 && (
        <div className={POP}
             style={{ background: "var(--bg-card)" }}>
          {matches.map((e, i) => (
            <button
              key={e.name}
              onMouseDown={(ev) => { ev.preventDefault(); accept(e.name); }}
              onMouseEnter={() => setSel(i)}
              className={ITEM + (i === sel ? "bg-white/[0.06] text-text-primary" : "text-text-secondary")}
            >
              {/* Generators are tinted so they read as "computed at send time", not as a value
                  someone configured. */}
              <span className={"font-mono " + (e.dynamic ? "text-cyan-400" : "")}>{e.name}</span>
              <span className="ml-auto max-w-[55%] truncate text-[11px] text-text-muted">{e.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// The two completion popups, in Deck's menu shape. Positioned under the field rather than
// portalled: they follow it as it scrolls with the grid, and close on blur anyway.
const POP = "scroll-thin absolute left-0 top-full z-50 mt-1 max-h-56 w-80 animate-[menu-in_110ms_ease-out] overflow-y-auto rounded-[10px] border border-subtle p-1 shadow-2xl";
const ITEM = "flex w-full items-baseline gap-2 rounded-[6px] px-2.5 py-1 text-left text-[12px] ";

// ---- caret helpers ----------------------------------------------------------
// Read and set through the field's own document: in a floating window the main page's selection
// is not the one the field is in, and the caret went back to the start after every key.
// Offsets are counted in plain-text characters across all child nodes, so they survive the
// innerHTML rebuild that turns typed text into token spans.

function getCaret(el: HTMLElement): number {
  const s = el.ownerDocument.getSelection();
  if (!s || s.rangeCount === 0) return 0;
  const r = s.getRangeAt(0).cloneRange();
  r.selectNodeContents(el);
  r.setEnd(s.getRangeAt(0).endContainer, s.getRangeAt(0).endOffset);
  return r.toString().length;
}

function setCaret(el: HTMLElement, offset: number) {
  const s = el.ownerDocument.getSelection();
  if (!s) return;
  const r = el.ownerDocument.createRange();
  let remaining = offset;
  let placed = false;

  const walk = (node: Node) => {
    if (placed) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) { r.setStart(node, remaining); placed = true; }
      else remaining -= len;
      return;
    }
    node.childNodes.forEach(walk);
  };
  walk(el);

  if (!placed) r.selectNodeContents(el), r.collapse(false);
  r.collapse(true);
  s.removeAllRanges();
  s.addRange(r);
}
