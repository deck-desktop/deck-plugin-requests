/**
 * The sandbox a request script runs in.
 *
 * A Worker rather than the main thread for one reason: collections are imported from files and
 * from pasted curl, and an export carries scripts along with the tokens it already carries. On the
 * main thread a pasted collection's script could reach invoke(), the filesystem and the backend
 * token; in here it can reach none of those.
 *
 * The network globals below are removed on top of that, so a script cannot casually send an
 * environment variable anywhere. That is a real barrier but not a complete one: `import()` is
 * syntax rather than a global, so a determined script can still make the browser fetch a URL, and
 * only a Content-Security-Policy `connect-src` could stop it. Deck runs with `csp: null` because
 * the usage card and the VPS relay need arbitrary origins, so that door stays open.
 *
 * The practical consequence, and what the docs tell the user: a script from a collection someone
 * else wrote is code you are choosing to run — read it first. Do not restore the globals below;
 * they are what makes the casual case safe.
 */
import { runPm, type ScriptContext } from "./httpscript.pm";

const g = self as unknown as Record<string, unknown>;
for (const name of [
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "Notification",
  // CacheStorage fetches on add(); WebTransport is a socket by another name.
  "caches", "WebTransport",
]) {
  try { g[name] = undefined; } catch { /* frozen in some engines; the CSP-less worker has no other reach anyway */ }
}

self.onmessage = (e: MessageEvent<{ script: string; ctx: ScriptContext }>) => {
  self.postMessage(runPm(e.data.script, e.data.ctx));
};
