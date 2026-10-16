/**
 * Answers the `http-send` event: the MCP's requests_send, arriving through sessions.rs.
 *
 * Registered at module scope like the dt-command listener in core/terminals, and for the same
 * reason: only the active module is mounted, so a listener living inside HttpClient would be
 * deaf whenever Hasan is looking at the terminals or the editor. Sending has to work regardless
 * of which tab is open.
 */
import { listen } from "@tauri-apps/api/event";
import { runSavedRequest } from "./httprun";
import { downloadName, responseBytes } from "./httpclient";
import { fsSaveUnique, httpSendReply } from "../shim/bridge.js";

/** A response body big enough to bury the rest of the reply is cut; the flag says it happened. */
const BODY_CAP = 64 * 1024;

export const stopHttpSend = listen<{ job: string; request: string; saveTo?: string | null }>("http-send", async (e) => {
  const { job, request, saveTo } = e.payload;
  let body: string;
  try {
    const out = await runSavedRequest(request);
    const r = out.result;

    // saveTo writes the body to disk and returns the path in place of the bytes. Any content
    // type, not just binary: a large JSON response overruns the reply just as badly.
    let savedTo: string | undefined;
    let saveError: string | undefined;
    if (saveTo && r) {
      // A truncated body is a partial file. Writing it would produce a corrupt download that
      // looks successful, which is worse than not writing one.
      if (r.truncated) saveError = `response was truncated at ${r.size} bytes; not saved`;
      else {
        try {
          savedTo = await fsSaveUnique(saveTo, downloadName(r, out.request?.url ?? ""), responseBytes(r));
        } catch (err) {
          saveError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    body = JSON.stringify({
      request: out.request && { id: out.request.id, name: out.request.name, method: out.request.method, url: out.request.url },
      error: out.error || undefined,
      status: r?.status,
      statusText: r?.status_text,
      headers: r?.headers,
      savedTo,
      saveError,
      // A binary body is useless over this channel: the text is lossy and the base64 of a
      // 467 KB image is 620 KB, far past the cap. Flag it, and point at saveTo — which writes
      // any body, of any type, to a file and returns the path instead.
      body: !r || savedTo ? undefined
        : r.body_b64 ? "<binary response — re-send with saveTo to write it to a file, or use the response pane's Save button>"
        : r.body.length > BODY_CAP ? r.body.slice(0, BODY_CAP)
        : r.body,
      bodyBinary: r?.body_b64 ? true : undefined,
      bodyTruncated: r && !savedTo && !r.body_b64 ? r.body.length > BODY_CAP || r.truncated : undefined,
      size: r?.size,
      elapsedMs: r?.elapsed_ms,
      tests: [...(out.pre?.tests ?? []), ...(out.post?.tests ?? [])],
      logs: [...(out.pre?.logs ?? []), ...(out.post?.logs ?? [])],
      scriptError: out.pre?.error ?? out.post?.error,
      envSet: Object.keys(out.envChanges),
      envSaved: out.envSaved,
    });
  } catch (err) {
    // The handler on the other end is parked on a oneshot: it must get an answer even when this
    // fails, or the caller waits out the full 75s timeout for nothing.
    body = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
  await httpSendReply(job, body).catch((e) => console.warn("[requests] reply to MCP send failed", e));
}).catch(() => {});
