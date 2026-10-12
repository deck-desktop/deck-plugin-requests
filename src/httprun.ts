/**
 * One full send: pre-request script, the request itself, post-response script.
 *
 * Extracted from HttpClient's send button because it now has a second caller — the MCP's
 * requests_send, which arrives as an event and must work while the user is looking at some
 * other module entirely. Nothing here touches React state; the component applies the result to
 * its tabs, and the event listener puts it on the wire.
 */
import {
  buildSend, sendRequest, envVars, loadCollections, saveCollections,
  type Collections, type Request, type HttpResult,
} from "./httpclient";
import { runScript, type ScriptResult, type ScriptRequestView } from "./httpscript";

export interface RunOutcome {
  result: HttpResult | null;
  pre: ScriptResult | null;
  post: ScriptResult | null;
  /** Set when the send did not happen — a pre-script threw, or the request itself failed. */
  error: string;
  /** The variables the scripts changed, after they were written back. */
  envChanges: Record<string, string | null>;
  /** False when there was nowhere to write them, i.e. no active environment. */
  envSaved: boolean;
}

const stripNulls = (env: Record<string, string | null>) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== null) out[k] = v;
  return out;
};

/**
 * The read-only view of the request a script sees. Variables are already substituted, so a script
 * reads the URL that will actually be sent rather than the {{base}} template.
 */
export const scriptRequest = (req: Request, vars: Record<string, string>): ScriptRequestView => {
  const wire = buildSend(req, vars);
  return { name: req.name, method: wire.method, url: wire.url, headers: wire.headers, body: wire.body };
};

/**
 * Merge variables a script set into the active environment of the active workspace.
 *
 * Pure — the caller decides how to persist the result, which is what lets the component keep
 * using its own `update()` while the event path writes the file directly.
 */
export function withScriptEnv(c: Collections, changes: Record<string, string | null>): Collections | null {
  if (!Object.keys(changes).length) return c;
  const ws = c.workspaces.find((w) => w.id === c.activeWorkspaceId);
  if (!ws?.activeEnvId) return null; // nowhere to put them
  return {
    ...c,
    environments: c.environments.map((e) => {
      if (e.id !== ws.activeEnvId) return e;
      let rows = e.vars;
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) { rows = rows.filter((r) => r.key.trim() !== k); continue; }
        rows = rows.some((r) => r.key.trim() === k)
          ? rows.map((r) => (r.key.trim() === k ? { ...r, value: v, on: true } : r))
          : [...rows, { on: true, key: k, value: v }];
      }
      return { ...e, vars: rows };
    }),
  };
}

/**
 * Run the pipeline.
 *
 * `applyEnv` is how variable writes are persisted. The component passes its own updater so the
 * open UI reflects them immediately; the event path passes one that writes the file. It returns
 * whether there was an active environment to write to.
 */
export async function runRequest(
  req: Request,
  vars: Record<string, string>,
  sendId: string,
  applyEnv: (changes: Record<string, string | null>) => boolean,
): Promise<RunOutcome> {
  const base: RunOutcome = { result: null, pre: null, post: null, error: "", envChanges: {}, envSaved: true };

  // Pre-request script. A script that throws aborts the send, as in Postman: it usually means a
  // token could not be built, and sending anyway would just produce a confusing 401.
  let sendVars = vars;
  let pre: ScriptResult | null = null;
  if (req.preScript?.trim()) {
    pre = await runScript(req.preScript, { request: scriptRequest(req, vars), env: vars });
    const saved = applyEnv(pre.env);
    sendVars = { ...vars, ...stripNulls(pre.env) };
    if (pre.error) {
      return { ...base, pre, error: `Pre-request script failed: ${pre.error}`, envChanges: pre.env, envSaved: saved };
    }
  }

  let result: HttpResult;
  try {
    result = await sendRequest(req, sendVars, sendId);
  } catch (e) {
    return { ...base, pre, error: String(e), envChanges: pre?.env ?? {} };
  }

  // Post-response script. Its failure does NOT discard the response — the response arrived, and
  // hiding it because a test threw makes the failure impossible to diagnose.
  let post: ScriptResult | null = null;
  let envSaved = true;
  if (req.postScript?.trim()) {
    post = await runScript(req.postScript, {
      request: scriptRequest(req, sendVars),
      response: {
        code: result.status, status: result.status_text, headers: result.headers,
        body: result.body, responseTime: result.elapsed_ms,
      },
      env: sendVars,
    });
    envSaved = applyEnv(post.env);
  }

  return { result, pre, post, error: "", envChanges: { ...pre?.env, ...post?.env }, envSaved };
}

/**
 * Run a saved request without any UI: load the store, send, write variables back to the file.
 *
 * Used by the MCP's requests_send. Reads the collections fresh rather than taking them from a
 * caller, because the app may not have the HTTP module mounted at all.
 */
export async function runSavedRequest(idOrName: string): Promise<RunOutcome & { request: Request | null }> {
  const col = await loadCollections();
  const req = col.requests[idOrName]
    ?? Object.values(col.requests).find((r) => r.name === idOrName)
    ?? null;
  if (!req) {
    return {
      request: null, result: null, pre: null, post: null,
      error: `No request with id or name '${idOrName}'.`, envChanges: {}, envSaved: true,
    };
  }

  // Collected and written once at the end: two scripts each triggering a file write would race
  // with the watcher that reads it back.
  let pending: Record<string, string | null> = {};
  let hasEnv = Boolean(col.workspaces.find((w) => w.id === col.activeWorkspaceId)?.activeEnvId);
  const out = await runRequest(req, envVars(col), `mcp-${Date.now()}`, (changes) => {
    pending = { ...pending, ...changes };
    return hasEnv;
  });

  if (Object.keys(pending).length && hasEnv) {
    const next = withScriptEnv(col, pending);
    if (next) await saveCollections(next);
    else hasEnv = false;
  }

  return { ...out, request: req, envSaved: hasEnv || !Object.keys(pending).length };
}
