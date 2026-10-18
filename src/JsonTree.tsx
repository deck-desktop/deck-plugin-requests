// Collapsible JSON tree for the response body's Preview mode.
//
// Monaco already shows the raw JSON with folding; this is for the other reading mode — scanning
// shape rather than text, with array lengths and object sizes visible while collapsed.
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export default function JsonTree({ body }: { body: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-text-muted">
        This body is not valid JSON, so there is no tree to show. Switch to Source to read it.
      </div>
    );
  }
  return (
    <div className="scroll-thin h-full overflow-auto p-3 font-mono text-xs leading-5">
      <Node data={parsed} depth={0} />
    </div>
  );
}

function Node({ data, depth }: { data: unknown; depth: number }) {
  // Two levels open is enough to see the shape of a typical payload without a wall of text.
  const [open, setOpen] = useState(depth < 2);

  if (data === null) return <span className="text-orange-400">null</span>;
  if (typeof data === "boolean") return <span className="text-blue-400">{String(data)}</span>;
  if (typeof data === "number") return <span className="text-emerald-400">{data}</span>;
  if (typeof data === "string") return <span className="text-amber-300">"{data}"</span>;

  const isArray = Array.isArray(data);
  const entries: [string, unknown][] = isArray
    ? (data as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(data as Record<string, unknown>);

  if (entries.length === 0) {
    return <span className="text-text-muted">{isArray ? "[]" : "{}"}</span>;
  }

  return (
    <span>
      <button onClick={() => setOpen((o) => !o)} className="text-text-muted transition hover:text-text-primary">
        {open ? <ChevronDown className="inline h-3 w-3" /> : <ChevronRight className="inline h-3 w-3" />}
        <span className="ml-0.5 text-[10px] text-text-muted">
          {isArray ? `[${entries.length}]` : open ? "{ }" : `{${entries.length}}`}
        </span>
      </button>
      {open && (
        <div className="ml-3 border-l border-subtle pl-2">
          {entries.map(([k, v], i) => (
            <div key={k} className="py-0.5">
              {isArray
                ? <span className="mr-2 text-[10px] text-text-muted opacity-60">{k}</span>
                : <><span className="mr-1 text-blue-400">"{k}"</span><span className="mr-1 text-text-muted">:</span></>}
              <Node data={v} depth={depth + 1} />
              {i < entries.length - 1 && <span className="text-text-muted">,</span>}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
