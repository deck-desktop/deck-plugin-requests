// Method dropdown. A native <select> can't colour its options, and the colour is the whole
// point — GET green / POST amber / DELETE red is how you read a request list at a glance.
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { METHODS, type Method } from "./httpclient";
import { METHOD_TONE, METHOD_HEX, METHOD_DESC } from "./methods";

export default function MethodPicker({
  value, onChange,
}: { value: Method; onChange: (m: Method) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onEsc); };
  }, [open]);

  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex h-8 items-center gap-1.5 rounded-md border border-strong bg-elev px-2.5 font-mono text-xs font-bold transition hover:border-accent ${METHOD_TONE[value]}`}
      >
        {value}
        <ChevronDown size={11} className="transition-transform" style={{ transform: open ? "rotate(180deg)" : undefined }} />
      </button>

      {open && (
        <div
          className="absolute left-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-lg border border-subtle py-1 shadow-card"
          style={{ background: "var(--bg-card)" }}
        >
          {METHODS.map((m) => {
            const on = m === value;
            return (
              <button
                key={m}
                onClick={() => { onChange(m); setOpen(false); }}
                className={"flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition " + (on ? "bg-elev" : "hover:bg-elev")}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: METHOD_HEX[m], boxShadow: on ? `0 0 6px ${METHOD_HEX[m]}` : undefined }}
                />
                <span className={`w-14 shrink-0 font-mono text-[11px] font-bold ${METHOD_TONE[m]}`}>{m}</span>
                <span className="truncate text-[10px] text-text-muted">{METHOD_DESC[m]}</span>
                {on && <Check size={12} className="ml-auto shrink-0" style={{ color: METHOD_HEX[m] }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
