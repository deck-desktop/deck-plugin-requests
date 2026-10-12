/**
 * Runs a request's pre/post script in a worker and hands the result back.
 *
 * The timeout is not a nicety: `while(true){}` in a worker can only be stopped by terminate(),
 * so without it the returned promise would never settle and the send would hang forever.
 */
import type { ScriptContext, ScriptResult } from "./httpscript.pm";
import workerCode from "virtual:httpscript-worker";

// One blob for the plugin's life; each run still gets a fresh Worker from it, so nothing a script
// leaves behind reaches the next. Released by dispose() in plugin.tsx.
let workerUrl = "";
export function releaseWorker() { if (workerUrl) URL.revokeObjectURL(workerUrl); workerUrl = ""; }

export type { ScriptContext, ScriptResult, TestResult, ScriptRequestView, ScriptResponseView } from "./httpscript.pm";

export function runScript(script: string, ctx: ScriptContext, timeoutMs = 5000): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const empty: ScriptResult = { env: {}, tests: [], logs: [] };
    let worker: Worker;
    try {
      workerUrl ||= URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
      worker = new Worker(workerUrl);
    } catch (e) {
      resolve({ ...empty, error: `Could not start the script sandbox: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    let done = false;
    const finish = (r: ScriptResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ ...empty, error: `Script timed out after ${timeoutMs}ms.` }),
      timeoutMs,
    );
    worker.onmessage = (e: MessageEvent<ScriptResult>) => finish(e.data);
    worker.onerror = (e) => finish({ ...empty, error: e.message || "Script failed to load." });
    worker.postMessage({ script, ctx });
  });
}
