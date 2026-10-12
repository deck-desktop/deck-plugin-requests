// Sent-request log, grouped by day. Clicking an entry reopens it as a tab, so a request you
// fired once from a scratch tab and never saved is still recoverable.
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
  history, onOpen,
}: { history: HistoryEntry[]; onOpen: (r: Request) => void }) {
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
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {history.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] leading-relaxed text-text-muted">
            Nothing sent yet.
          </div>
        )}
        {groups.map((g) => (
          <div key={g.label}>
            <div className="sticky top-0 border-b border-subtle py-1 pl-3 pr-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted"
                 style={{ background: "var(--bg-panel)" }}>
              {g.label}
            </div>
            {g.entries.map((e) => (
              <button
                key={e.id}
                onClick={() => onOpen(e.request)}
                className="group flex w-full items-center gap-2 py-1.5 pl-3 pr-2 text-left text-xs hover:bg-elev"
                title={`${e.url}
${e.status} · ${e.elapsed_ms} ms · ${formatSize(e.size)}`}
              >
                <span className={`w-10 shrink-0 font-mono text-[10px] font-bold ${METHOD_TONE[e.method]}`}>{e.method}</span>
                <span className="min-w-0 flex-1 truncate text-text-secondary">{shortUrl(e.url)}</span>
                <span className={`shrink-0 font-mono text-[10px] ${statusTone(e.status)}`}>{e.status}</span>
                {/* Time only. Swapping this for the size on hover reflowed the row under the
                    cursor — the size lives in the row's tooltip instead. */}
                <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-text-muted">{time(e.sentAt)}</span>
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
