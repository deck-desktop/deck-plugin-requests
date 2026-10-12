// The params/headers/form grid: a spreadsheet-style table rather than a list of inputs.
//
// There is no "Add" button. A blank row always sits at the bottom and becomes real as soon as
// you type in it, which is how every API client does this — hitting a button between each pair
// of headers gets old fast.
import { Trash2, List, FolderOpen } from "lucide-react";
import { useState } from "react";
import { pickAnyFile } from "../shim/bridge.js";
import type { Row } from "./httpclient";
import VarInput from "./VarInput";

export default function KeyValueGrid({
  rows, onChange, vars, keyLabel = "Key", valueLabel = "Value",
  keySuggestions, readOnlyKeys, noAdd, headerExtra, allowFiles,
}: {
  rows: Row[];
  onChange: (rows: Row[]) => void;
  vars: Record<string, string>;
  keyLabel?: string;
  valueLabel?: string;
  /** Autocomplete for the key column (header names, with descriptions). */
  keySuggestions?: { name: string; description?: string }[];
  /** Keys come from elsewhere and can't be typed (path variables read out of the URL). */
  readOnlyKeys?: boolean;
  /** No phantom row — the row set is fixed (again, path variables). */
  noAdd?: boolean;
  /** Rendered in the grid's header strip, left of the bulk-edit toggle. */
  headerExtra?: React.ReactNode;
  /** Offer a per-row text/file switch. Form bodies only: a header or query row cannot carry a
   *  file, so the control would be a dead button anywhere else. */
  allowFiles?: boolean;
}) {
  const [bulk, setBulk] = useState(false);

  // Edit against the list including the phantom trailing row, then drop rows that are entirely
  // empty — so typing in the blank row appends, and clearing a row removes it.
  const withBlank = noAdd ? rows : [...rows, { on: true, key: "", value: "" }];
  const commit = (next: Row[]) =>
    onChange(next.filter((r) => r.key.trim() !== "" || r.value.trim() !== ""));
  const set = (i: number, patch: Partial<Row>) =>
    commit(withBlank.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  if (bulk) {
    return (
      <div className="flex h-full flex-col">
        <GridHeader bulk={bulk} onToggleBulk={() => setBulk(false)} keyLabel={keyLabel} valueLabel={valueLabel} noBulk={noAdd || allowFiles} extra={headerExtra} />
        {/* Bulk edit: one "key: value" per line. Faster than the grid for pasting a block of
            headers out of curl or a doc page. */}
        <textarea
          value={rows.map((r) => `${r.on ? "" : "// "}${r.key}: ${r.value}`).join("\n")}
          onChange={(e) => onChange(parseBulk(e.target.value))}
          spellCheck={false}
          placeholder={`${keyLabel}: ${valueLabel}`}
          className="scroll-thin min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-xs text-text-primary outline-none placeholder:text-text-muted"
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <GridHeader bulk={bulk} onToggleBulk={() => setBulk(true)} keyLabel={keyLabel} valueLabel={valueLabel} noBulk={noAdd || allowFiles} extra={headerExtra} />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {withBlank.map((r, i) => {
          const phantom = !noAdd && i === withBlank.length - 1;
          return (
            <div
              key={i}
              className="group flex items-stretch border-b border-subtle text-xs last:border-b-0"
            >
              <div className="flex w-9 shrink-0 items-center justify-center border-r border-subtle">
                {/* The phantom row has nothing to enable yet, so its checkbox would be a lie. */}
                {!phantom && (
                  <input
                    type="checkbox"
                    checked={r.on}
                    onChange={(e) => set(i, { on: e.target.checked })}
                    title="Include in the request"
                    className="accent-[var(--accent)]"
                  />
                )}
              </div>
              <Cell>
                <VarInput
                  value={r.key}
                  onChange={(key) => set(i, { key })}
                  vars={vars}
                  suggestions={keySuggestions}
                  readOnly={readOnlyKeys}
                  placeholder={phantom ? keyLabel : ""}
                  className={"font-mono text-xs " + (r.on ? "text-text-primary" : "text-text-muted line-through")}
                />
              </Cell>
              <Cell wide>
                <div className="flex w-full items-center gap-1">
                  <VarInput
                    value={r.value}
                    onChange={(value) => set(i, { value })}
                    vars={vars}
                    placeholder={phantom ? (r.kind === "file" ? "Path to a file" : valueLabel) : ""}
                    className={"font-mono text-xs " + (r.on ? "text-text-primary" : "text-text-muted")}
                  />
                  {allowFiles && !phantom && r.kind === "file" && (
                    <button
                      onClick={() => void pickAnyFile().then((p) => { if (p) set(i, { value: p }); })}
                      title="Choose a file"
                      className="shrink-0 rounded p-1 text-text-muted transition hover:text-text-primary"
                    >
                      <FolderOpen size={12} />
                    </button>
                  )}
                </div>
              </Cell>
              {allowFiles && (
                <div className="flex w-12 shrink-0 items-center justify-center border-l border-subtle">
                  {/* Text/File per row. A file row sends its value as a path to upload, which
                      makes the whole body multipart — the row is where that starts, so the
                      switch belongs on the row rather than above the grid. */}
                  {!phantom && (
                    <button
                      onClick={() => set(i, {
                        kind: r.kind === "file" ? "text" : "file",
                        // The path and the text value are different things; keeping one as the
                        // other leaves a nonsense value behind after a switch.
                        value: "",
                        ...(r.kind === "file" ? { filename: undefined, contentType: undefined } : {}),
                      })}
                      title={r.kind === "file" ? "Sending a file — click for text" : "Sending text — click for a file"}
                      className={"rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition "
                        + (r.kind === "file" ? "text-[var(--accent)]" : "text-text-muted hover:text-text-primary")}
                    >
                      {r.kind === "file" ? "File" : "Text"}
                    </button>
                  )}
                </div>
              )}
              <div className="flex w-8 shrink-0 items-center justify-center">
                {!phantom && (
                  <button
                    onClick={() => commit(withBlank.filter((_, j) => j !== i))}
                    title="Remove"
                    className="rounded p-1 text-text-muted opacity-0 transition hover:text-red-400 group-hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GridHeader({
  bulk, onToggleBulk, keyLabel, valueLabel, noBulk, extra,
}: { bulk: boolean; onToggleBulk: () => void; keyLabel: string; valueLabel: string; noBulk?: boolean; extra?: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-stretch border-b border-subtle text-[10px] font-semibold uppercase tracking-wider text-text-muted">
      <div className="w-9 shrink-0 border-r border-subtle" />
      <div className="flex-1 border-r border-subtle px-2 py-1.5">{keyLabel}</div>
      <div className="flex flex-[2] items-center px-2 py-1.5">
        {valueLabel}
        {extra && <span className="ml-auto">{extra}</span>}
      </div>
      {noBulk ? <div className="w-8 shrink-0" /> : (
        <button
          onClick={onToggleBulk}
          title={bulk ? "Back to the grid" : "Bulk edit as text"}
          className={"flex w-8 shrink-0 items-center justify-center transition hover:text-text-primary " + (bulk ? "text-accent" : "")}
        >
          <List size={12} />
        </button>
      )}
    </div>
  );
}

const Cell = ({ children, wide }: { children: React.ReactNode; wide?: boolean }) => (
  <div className={(wide ? "flex-[2]" : "flex-1 border-r border-subtle") + " min-w-0 px-2 py-1.5"}>
    {children}
  </div>
);

/** Parse the bulk-edit textarea back into rows. `//` at the start disables a line. */
function parseBulk(text: string): Row[] {
  return text
    .split("\n")
    .map((line) => {
      const on = !line.trimStart().startsWith("//");
      const body = on ? line : line.replace(/^\s*\/\/\s?/, "");
      const at = body.indexOf(":");
      // A line with no colon is still a key being typed, not a parse error.
      return at < 0
        ? { on, key: body.trim(), value: "" }
        : { on, key: body.slice(0, at).trim(), value: body.slice(at + 1).trim() };
    })
    .filter((r) => r.key !== "" || r.value !== "");
}
