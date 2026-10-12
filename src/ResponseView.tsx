// The response half of the HTTP client: tab strip with the status line on the right, then
// body / headers / cookies.
import { useEffect, useState } from "react";
import { Eye, Code2, ChevronDown, ChevronUp, XCircle, Loader2, Check, X, Download } from "lucide-react";
import type { ScriptResult } from "./httpscript";
import {
  bodyLanguage, formatBody, formatSize, parseCookies, downloadName, responseBytes,
  responseMedia, mediaDataUri, type HttpResult,
} from "./httpclient";
// The editor's image viewer, reused rather than reimplemented: wheel to zoom toward the cursor,
// drag to pan, double-click to reset. A response image deserves the same handling as a file one.
import { ImageViewer } from "../shim/ui.js";
import { pickSavePath, fsWriteBytes } from "../shim/bridge.js";
import JsonTree from "./JsonTree";
import CodeBox from "./CodeBox";

/**
 * Read-only Monaco for a response body.
 *
 * Deliberately not MonacoEditor from the editor module: that one is bound to a file path (it
 * opens an LSP document, tracks dirty state, and caches the model by URI). A response is
 * ephemeral and has no path, so it gets a plain throwaway model instead.
 */
function statusTone(status: number): string {
  if (status >= 500) return "text-red-400";
  if (status >= 400) return "text-amber-400";
  if (status >= 300) return "text-blue-400";
  return "text-green-400";
}

type Tab = "body" | "headers" | "cookies" | "tests";

/** One send's script output. Both halves optional — most requests run neither script. */
export interface ScriptRun { pre?: ScriptResult | null; post?: ScriptResult | null }

const runTests = (r?: ScriptRun) => [...(r?.pre?.tests ?? []), ...(r?.post?.tests ?? [])];
const runFailed = (r?: ScriptRun) =>
  runTests(r).some((t) => !t.passed) || Boolean(r?.pre?.error) || Boolean(r?.post?.error);

export default function ResponseView({
  result, error, busy, collapsed, onToggleCollapse, onCancel, dragHandleProps, scripts, noEnvironment, url,
}: {
  result: HttpResult | null;
  /** The URL that was sent — the fallback for naming a downloaded file. */
  url?: string;
  /** Output of this send's pre/post scripts, if it ran any. */
  scripts?: ScriptRun;
  /** No active environment, so anything a script set could not be saved anywhere. */
  noEnvironment?: boolean;
  error: string;
  busy: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onCancel: () => void;
  /** Makes the header row double as the split's drag handle, as in the reference. */
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement>;
}) {
  const [tab, setTab] = useState<Tab>("body");
  const [saved, setSaved] = useState("");
  const tests = runTests(scripts);
  const hasScripts = Boolean(scripts?.pre || scripts?.post);
  // The Tests tab only exists while a script ran. Sending a request without one would otherwise
  // leave the selection on a tab that is no longer in the strip: a blank pane, nothing highlighted.
  useEffect(() => { if (tab === "tests" && !hasScripts) setTab("body"); }, [tab, hasScripts]);
  const [raw, setRaw] = useState(false);
  const [preview, setPreview] = useState(false);

  if (busy) {
    return (
      <Sending
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        onCancel={onCancel}
        dragHandleProps={dragHandleProps}
      />
    );
  }

  if (error) {
    return (
      <div className="h-full overflow-auto p-4">
        <div className="mb-2 text-sm font-medium text-red-400">Request failed</div>
        <pre className="whitespace-pre-wrap break-all text-xs text-text-secondary">{error}</pre>
      </div>
    );
  }

  if (!result) return <Centered>Send a request to see the response.</Centered>;

  const lang = bodyLanguage(result.headers);
  const shown = raw ? result.body : formatBody(result.body, lang);
  const cookies = parseCookies(result.headers);
  const media = responseMedia(result.headers);
  // Preview means something different per type: a tree for JSON, a rendered page for HTML, the
  // picture itself for an image.
  const canPreview = lang === "html" || lang === "json";

  const download = async () => {
    const name = downloadName(result, url ?? "");
    const dot = name.lastIndexOf(".");
    const path = await pickSavePath(name, dot > 0 ? name.slice(dot + 1) : "bin");
    if (!path) return;
    await fsWriteBytes(path, responseBytes(result));
    setSaved(path);
    setTimeout(() => setSaved(""), 4000);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Tab strip with the status line pinned right, so status/time/size stay visible on every
          tab. The row doubles as the split drag handle while the panel is expanded. */}
      <div
        {...(collapsed ? {} : dragHandleProps)}
        className={"flex shrink-0 select-none items-center border-b border-subtle px-2 " +
          (collapsed || !dragHandleProps ? "" : "cursor-row-resize")}
      >
        {(["body", "headers", "cookies", ...(hasScripts ? ["tests" as const] : [])] as const).map((t) => (
          <button
            key={t}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => { if (collapsed) onToggleCollapse(); setTab(t); }}
            className={
              "px-3 py-2 text-xs capitalize transition " +
              (t === tab && !collapsed
                ? "border-b-2 border-accent text-text-primary"
                : "border-b-2 border-transparent text-text-muted hover:text-text-secondary")
            }
          >
            {t}
            {t === "headers" && <Count n={result.headers.length} />}
            {t === "cookies" && cookies.length > 0 && <Count n={cookies.length} />}
            {t === "tests" && (
              <span className={"ml-1.5 text-[10px] " + (runFailed(scripts) ? "text-red-400" : "text-green-400")}>
                {tests.filter((x) => x.passed).length}/{tests.length || "!"}
              </span>
            )}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-2.5 pl-4 text-xs">
          <span className={`font-semibold ${statusTone(result.status)}`}>
            {result.status} {result.status_text}
          </span>
          <Sep />
          <span className="font-mono text-text-muted">{result.elapsed_ms} ms</span>
          <Sep />
          <span className="font-mono text-text-muted">{formatSize(result.size)}</span>
          {result.truncated && (
            <span className="text-amber-400" title="Only the first 10 MB was downloaded">truncated</span>
          )}
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onToggleCollapse}
            title={collapsed ? "Expand response" : "Collapse response"}
            className="rounded p-1 text-text-muted transition hover:bg-elev hover:text-text-primary"
          >
            {collapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>
      </div>

      {!collapsed && tab === "body" && (result.body || result.body_b64) && (
        <div className="flex shrink-0 items-center gap-1 border-b border-subtle px-2 py-1">
          <span className="rounded bg-elev px-2 py-0.5 font-mono text-[10px] uppercase text-text-secondary">
            {lang === "plaintext" ? "raw" : lang}
          </span>
          {lang === "json" && !preview && !media && (
            <Chip on={raw} onClick={() => setRaw((r) => !r)} icon={<Code2 size={11} />}>
              {raw ? "Raw" : "Pretty"}
            </Chip>
          )}
          {canPreview && (
            <Chip on={preview} onClick={() => setPreview((v) => !v)} icon={preview ? <Code2 size={11} /> : <Eye size={11} />}>
              {preview ? "Source" : "Preview"}
            </Chip>
          )}
          <span className="ml-auto flex items-center gap-1">
            {saved && <span className="truncate text-[10px] text-green-400" title={saved}>Saved</span>}
            <button
              onClick={() => void download()}
              title="Save the response to a file"
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-text-muted transition hover:bg-elev hover:text-text-primary"
            >
              <Download size={11} /> Save
            </button>
            {/* Copying replacement characters would produce a corrupt paste, so text only. */}
            {!result.body_b64 && (
              <button
                onClick={() => void navigator.clipboard.writeText(shown)}
                className="rounded px-2 py-0.5 text-[11px] text-text-muted transition hover:bg-elev hover:text-text-primary"
              >
                Copy
              </button>
            )}
          </span>
        </div>
      )}

      {!collapsed && (
        <div className="min-h-0 flex-1">
          {tab === "body" ? (
            !result.body && !result.body_b64 ? (
              <Centered>Empty body</Centered>
            ) : media ? (
              // The bytes as a data: URI. The code box would show a page of replacement
              // characters — from_utf8_lossy has already destroyed them — so media never gets
              // that view, and there is no Source toggle to go back to.
              <MediaBody result={result} kind={media} />
            ) : preview && lang === "json" ? (
              <JsonTree body={result.body} />
            ) : preview && lang === "html" ? (
              // Sandboxed: a response body is untrusted and this renders it as HTML. No
              // allow-scripts and no allow-same-origin, so it cannot run anything or reach
              // Deck's own origin.
              <iframe title="Response preview" sandbox="" srcDoc={result.body} className="h-full w-full bg-white" />
            ) : (
              <CodeBox value={shown} language={lang} readOnly folding />
            )
          ) : tab === "tests" ? (
            <TestsPanel run={scripts} noEnvironment={noEnvironment} />
          ) : tab === "headers" ? (
            <KeyTable rows={result.headers} />
          ) : cookies.length === 0 ? (
            <Centered>No cookies set</Centered>
          ) : (
            <div className="scroll-thin h-full overflow-auto">
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-text-muted">
                  <tr className="border-b border-subtle">
                    <Th>Name</Th><Th>Value</Th><Th>Domain</Th><Th>Path</Th><Th>Flags</Th>
                  </tr>
                </thead>
                <tbody>
                  {cookies.map((c, i) => (
                    <tr key={i} className="border-b border-subtle last:border-b-0">
                      <Td mono>{c.name}</Td>
                      <Td mono truncate>{c.value}</Td>
                      <Td>{c.domain}</Td>
                      <Td>{c.path}</Td>
                      <Td>{c.flags.join(", ")}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A response the browser can play or draw: an image, a video, an audio track, a PDF. */
function MediaBody({ result, kind }: { result: HttpResult; kind: "image" | "video" | "audio" | "pdf" }) {
  const src = mediaDataUri(result);
  // The editor's checkerboard, so transparency reads the same in both places.
  const checker = "repeating-conic-gradient(#1b1f27 0% 25%, #12151b 0% 50%) 50% / 20px 20px";

  if (kind === "image") return <ImageViewer src={src} alt="Response" bg={checker} />;

  if (kind === "pdf") {
    // Sandboxed for the same reason the HTML preview is: a response body is untrusted.
    return <iframe title="Response PDF" sandbox="" src={src} className="h-full w-full bg-white" />;
  }

  return (
    <div className="flex h-full w-full items-center justify-center p-4" style={{ background: checker }}>
      {kind === "video"
        ? <video src={src} controls className="max-h-full max-w-full" />
        : <audio src={src} controls className="w-80" />}
    </div>
  );
}

/** Test results, console output and any script error, pre and post together in run order. */
function TestsPanel({ run, noEnvironment }: { run?: ScriptRun; noEnvironment?: boolean }) {
  const halves = ([["Pre-request", run?.pre], ["Post-response", run?.post]] as const)
    .filter(([, r]) => r) as [string, ScriptResult][];
  const setAny = halves.some(([, r]) => Object.keys(r.env).length > 0);

  return (
    <div className="scroll-thin h-full overflow-auto p-3 text-xs">
      {noEnvironment && setAny && (
        <div className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-amber-300">
          No active environment — variables the script set were not saved.
        </div>
      )}
      {halves.map(([label, r]) => (
        <div key={label} className="mb-4 last:mb-0">
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-text-muted">{label}</div>

          {r.error && (
            <pre className="mb-2 whitespace-pre-wrap break-all rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-red-300">
              {r.error}
            </pre>
          )}

          {r.tests.map((t, i) => (
            <div key={i} className="flex items-start gap-2 border-b border-subtle py-1 last:border-b-0">
              {t.passed
                ? <Check size={13} className="mt-0.5 shrink-0 text-green-400" />
                : <X size={13} className="mt-0.5 shrink-0 text-red-400" />}
              <div className="min-w-0">
                <div className={t.passed ? "text-text-secondary" : "text-text-primary"}>{t.name}</div>
                {t.error && <div className="mt-0.5 break-all font-mono text-[11px] text-red-400">{t.error}</div>}
              </div>
            </div>
          ))}

          {Object.keys(r.env).length > 0 && (
            <div className="mt-2 text-[11px] text-text-muted">
              Set:{" "}
              {Object.entries(r.env).map(([k, v]) => (
                <span key={k} className="mr-2 font-mono">
                  {k}
                  {v === null && <span className="text-text-muted"> (unset)</span>}
                </span>
              ))}
            </div>
          )}

          {r.logs.length > 0 && (
            <pre className="mt-2 whitespace-pre-wrap break-all rounded bg-elev px-2 py-1.5 font-mono text-[11px] text-text-secondary">
              {r.logs.join("\n")}
            </pre>
          )}

          {!r.error && !r.tests.length && !r.logs.length && (
            <div className="text-text-muted">Ran with no tests or output.</div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The in-flight state. Deliberately mirrors the response header row — same height, same slots —
 * so the panel does not jump when the response lands.
 */
function Sending({
  collapsed, onToggleCollapse, onCancel, dragHandleProps,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onCancel: () => void;
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement>;
}) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setMs(Date.now() - started), 100);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div
        {...(collapsed ? {} : dragHandleProps)}
        className={"relative flex shrink-0 select-none items-center overflow-hidden border-b border-subtle px-2 " +
          (collapsed || !dragHandleProps ? "" : "cursor-row-resize")}
      >
        <span className="px-3 py-2 text-xs text-text-muted">Response</span>
        <div className="ml-auto flex items-center gap-2.5 py-2 pl-4 text-xs">
          <Loader2 size={12} className="animate-spin text-accent" />
          <span className="font-mono text-text-muted">{(ms / 1000).toFixed(1)}s</span>
          <Sep />
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onCancel}
            className="flex items-center gap-1 text-text-muted transition hover:text-red-400"
          >
            <XCircle size={12} />
            Cancel
          </button>
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onToggleCollapse}
            title={collapsed ? "Expand response" : "Collapse response"}
            className="rounded p-1 text-text-muted transition hover:bg-elev hover:text-text-primary"
          >
            {collapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>
        {/* Indeterminate sweep on the bottom edge: there is no content-length to build a real
            progress bar from. */}
        {!collapsed && (
          <div className="absolute bottom-0 left-0 right-0 h-px overflow-hidden">
            <div className="h-full w-1/3 animate-[http-sweep_1.4s_ease-in-out_infinite]" style={{ background: "var(--accent)" }} />
          </div>
        )}
      </div>
      {!collapsed && <div className="flex-1" />}
    </div>
  );
}

function KeyTable({ rows }: { rows: [string, string][] }) {
  return (
    <div className="scroll-thin h-full overflow-auto">
      <table className="w-full text-xs">
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={i} className="border-b border-subtle align-top last:border-b-0">
              <td className="w-56 px-3 py-1.5 font-mono text-text-secondary">{k}</td>
              <td className="break-all px-3 py-1.5 font-mono text-text-muted">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const Centered = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-full items-center justify-center text-sm text-text-muted">{children}</div>
);
const Count = ({ n }: { n: number }) => <span className="ml-1 text-text-muted">{n}</span>;
const Sep = () => <span className="text-text-muted opacity-30">|</span>;
const Th = ({ children }: { children: React.ReactNode }) => <th className="px-3 py-1.5 text-left font-medium">{children}</th>;
const Td = ({ children, mono, truncate }: { children: React.ReactNode; mono?: boolean; truncate?: boolean }) => (
  <td className={"px-3 py-1.5 text-text-muted " + (mono ? "font-mono " : "") + (truncate ? "max-w-[16rem] truncate" : "")}>{children}</td>
);

function Chip({
  on, onClick, icon, children,
}: { on: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        "flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition " +
        (on ? "bg-accent-soft text-accent" : "text-text-muted hover:bg-elev hover:text-text-primary")
      }
    >
      {icon}
      {children}
    </button>
  );
}
