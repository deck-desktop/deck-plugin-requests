// Method dropdown. A native <select> can't colour its options, and the colour is the whole
// point — GET green / POST amber / DELETE red is how you read a request list at a glance.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "../shim/react-dom.js";
import { Check, ChevronDown } from "lucide-react";
import { METHODS, type Method } from "./httpclient";
import { METHOD_TONE, METHOD_HEX, METHOD_DESC } from "./methods";

export default function MethodPicker({
  value, onChange,
}: { value: Method; onChange: (m: Method) => void }) {
  // Where the menu opens: under the button, in screen coordinates, since it is portalled.
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const open = at !== null;
  const wrap = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // The menu is portalled out of `wrap`, so a press inside either one is not an outside click.
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrap.current?.contains(t) && !pop.current?.contains(t)) setAt(null);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setAt(null); };
    // The document the picker is in: Deck's main window's, or a floating window's.
    const doc = wrap.current?.ownerDocument ?? document;
    doc.addEventListener("mousedown", onDoc);
    doc.addEventListener("keydown", onEsc);
    return () => { doc.removeEventListener("mousedown", onDoc); doc.removeEventListener("keydown", onEsc); };
  }, [open]);

  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt((a) => (a ? null : { left: r.left, top: r.bottom + 4 }));
        }}
        className={`flex h-8 items-center gap-1.5 rounded-lg border border-subtle bg-elev px-2.5 font-mono text-[12px] font-bold transition-colors hover:border-strong ${METHOD_TONE[value]}`}
      >
        {value}
        <ChevronDown size={12} className="transition-transform" style={{ transform: open ? "rotate(180deg)" : undefined }} />
      </button>

      {at && createPortal(
        // Portalled to <body> and fixed, so a transformed or clipping ancestor cannot cut it off.
        <div
          ref={pop}
          className="fixed z-50 w-56 animate-[menu-in_110ms_ease-out] rounded-[10px] border border-subtle p-1 shadow-2xl"
          style={{ background: "var(--bg-card)", left: at.left, top: at.top }}
        >
          {METHODS.map((m) => {
            const on = m === value;
            return (
              <button
                key={m}
                onClick={() => { onChange(m); setAt(null); }}
                className={"flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-1.5 text-left transition-colors " + (on ? "" : "hover:bg-white/[0.06]")}
                style={on ? { background: "var(--accent-soft)" } : undefined}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: METHOD_HEX[m], boxShadow: on ? `0 0 6px ${METHOD_HEX[m]}` : undefined }}
                />
                <span className={`w-14 shrink-0 font-mono text-[11.5px] font-bold ${METHOD_TONE[m]}`}>{m}</span>
                <span className="truncate text-[11px] text-text-muted">{METHOD_DESC[m]}</span>
                {on && <Check size={12} className="ml-auto shrink-0" style={{ color: METHOD_HEX[m] }} />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
