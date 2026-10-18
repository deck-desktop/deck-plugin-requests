// Sent-request log, grouped by day. Clicking an entry reopens it as a tab, so a request you
// fired once from a scratch tab and never saved is still recoverable.
import { Plus } from "lucide-react";
import { formatSize, type HistoryEntry, type Request } from "./httpclient";
import { METHOD_TONE } from "./methods";

const dayLabel = (ts: number): string => {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

const time = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const statusTone = (s: number) =>
  s >= 500 ? "text-red-400" : s >= 400 ? "text-amber-400" : s >= 300 ? "text-blue-400" : "text-emerald-400";

export default function HistoryPanel({
  history, onOpen, onNew,
}: {
  history: HistoryEntry[];
  onOpen: (r: Request) => void;
  /** A new unsaved request: the way in from an empty history. */
  onNew: () => void;
}) {
  // Entries arrive newest-first, so consecutive grouping preserves that order without a sort.
  const groups: { label: string; entries: HistoryEntry[] }[] = [];
  for (const e of history) {
    const label = dayLabel(e.sentAt);
    if (groups[groups.length - 1]?.label === label) groups[groups.length - 1].entries.push(e);
    else groups.push({ label, entries: [e] });
  }

  // No header row of its own: the activity bar above already names the view, and drawing a
  // second one here made the whole panel shift by a row when switching between views.
  return (
    <div className="flex h-full flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {history.length === 0 && (
          <div className="flex flex-col items-start gap-2 px-1 py-1">
            <p className="px-1.5 text-[12px] leading-relaxed text-text-muted">
              Every request you send is kept here, by day. Click one to open it again as a new tab.
            </p>
            <button onClick={onNew}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-subtle bg-elev px-3 text-[12px] text-text-secondary transition-colors hover:border-strong hover:text-text-primary">
              <Plus size={14} />New request
            </button>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.label} className="mb-1">
            <div className="sticky top-0 flex h-7 items-center px-1.5 text-[12px] font-medium text-text-secondary"
                 style={{ background: "var(--bg-panel)" }}>
              {g.label}
            </div>
            {g.entries.map((e) => (
              <button
                key={e.id}
                onClick={() => onOpen(e.request)}
                className="group flex h-6 w-full items-center gap-2 rounded-md px-1.5 text-left text-[12px] transition-colors hover:bg-white/5"
                title={`${e.url}
${e.status} · ${e.elapsed_ms} ms · ${formatSize(e.size)}`}
              >
                <span className={`w-10 shrink-0 font-mono text-[10px] font-bold ${METHOD_TONE[e.method]}`}>{e.method}</span>
                <span className="min-w-0 flex-1 truncate text-text-secondary group-hover:text-text-primary">{shortUrl(e.url)}</span>
                <span className={`shrink-0 font-mono text-[10.5px] ${statusTone(e.status)}`}>{e.status}</span>
                {/* Time only. Swapping this for the size on hover reflowed the row under the
                    cursor — the size lives in the row's tooltip instead. */}
                <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-text-muted">{time(e.sentAt)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Drop the scheme so the path — the part that identifies the call — gets the room. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}
