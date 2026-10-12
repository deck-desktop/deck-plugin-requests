// curl ↔ Request. Paste a curl command from a browser's "Copy as cURL" or from a colleague's
// message and get a request; take one back out to share it.
//
// This parses the flags people actually paste, not all of curl: -X, -H, -d/--data*, -F, -u, -b,
// --url, and the long forms of each. Anything unrecognised is ignored rather than rejected —
// a browser adds flags like --compressed that have no place in the model, and refusing the whole
// paste over one of them would be useless.
import { buildSend, newId, newRequest, substitute, type Method, type Request, type Row } from "./httpclient";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const row = (key: string, value: string): Row => ({ on: true, key, value });

/**
 * Split a command line the way a shell would: honour quotes, drop line continuations.
 *
 * Browsers emit multi-line curl with trailing backslashes (or carets on Windows), and a naive
 * split on whitespace turns those into arguments.
 */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false; // distinguishes "" (an empty argument) from no argument at all

  for (let i = 0; i < input.length; i++) {
    const c = input[i];

    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < input.length) {
        // Inside double quotes a backslash escapes the next character; inside single quotes it is
        // literal, which is why this branch is guarded by the quote style.
        cur += input[++i];
      } else if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
      continue;
    }

    if (c === '"' || c === "'") { quote = c; started = true; continue; }

    // Line continuations: "\" then newline (POSIX), "^" then newline (cmd).
    if ((c === "\\" || c === "^") && /[\r\n]/.test(input[i + 1] ?? "")) {
      while (/[\r\n\s]/.test(input[i + 1] ?? "")) i++;
      continue;
    }
    if (c === "\\" && input[i + 1] !== undefined && !/\s/.test(input[i + 1])) { cur += input[++i]; continue; }

    if (/\s/.test(c)) {
      if (cur || started) { out.push(cur); cur = ""; started = false; }
      continue;
    }

    cur += c;
    started = true;
  }

  if (cur || started) out.push(cur);
  return out;
}

/**
 * Build a Request from a curl command, or null when the text is not one.
 *
 * The name is left as the URL's last path segment — a pasted command carries no name, and
 * "New Request" for every import makes a collection unreadable.
 */
export function parseCurl(text: string): Request | null {
  const t = tokenize(text.trim());
  if (t.length === 0 || !/^curl(\.exe)?$/i.test(t[0])) return null;

  const req = newRequest();
  const headers: Row[] = [];
  const form: Row[] = [];
  const data: string[] = [];
  let method: Method | null = null;
  let url = "";
  let isForm = false;

  const val = (i: number) => t[i + 1] ?? "";

  for (let i = 1; i < t.length; i++) {
    const a = t[i];

    if (a === "-X" || a === "--request") {
      const m = val(i).toUpperCase();
      if (METHODS.includes(m)) method = m as Method;
      i++;
    } else if (a === "-H" || a === "--header") {
      const h = val(i); i++;
      const at = h.indexOf(":");
      if (at > 0) headers.push(row(h.slice(0, at).trim(), h.slice(at + 1).trim()));
    } else if (a === "-d" || a === "--data" || a === "--data-raw" || a === "--data-binary" || a === "--data-ascii") {
      data.push(val(i)); i++;
    } else if (a === "--data-urlencode") {
      data.push(val(i)); i++;
    } else if (a === "-F" || a === "--form") {
      const f = val(i); i++;
      isForm = true;
      const at = f.indexOf("=");
      if (at > 0) form.push(row(f.slice(0, at), f.slice(at + 1)));
    } else if (a === "-u" || a === "--user") {
      const u = val(i); i++;
      const at = u.indexOf(":");
      req.auth = at >= 0
        ? { kind: "basic", user: u.slice(0, at), pass: u.slice(at + 1) }
        : { kind: "basic", user: u, pass: "" };
    } else if (a === "-b" || a === "--cookie") {
      headers.push(row("Cookie", val(i))); i++;
    } else if (a === "--url") {
      url = val(i); i++;
    } else if (a === "-A" || a === "--user-agent") {
      headers.push(row("User-Agent", val(i))); i++;
    } else if (a === "-e" || a === "--referer") {
      headers.push(row("Referer", val(i))); i++;
    } else if (a.startsWith("-")) {
      // An unknown flag. Those taking a value would otherwise leave it looking like the URL, so
      // skip the next token for the ones known to take one; bare switches (--compressed, -L, -k)
      // are simply dropped.
      if (["-o", "--output", "-m", "--max-time", "-x", "--proxy", "-w", "--write-out",
           "--connect-timeout", "-E", "--cert", "--key", "-T", "--upload-file"].includes(a)) i++;
    } else if (!url) {
      url = a;
    }
  }

  if (!url) return null;

  // An Authorization header is more precisely modelled as auth, so the Auth tab shows it and the
  // header list does not carry a duplicate.
  const authIdx = headers.findIndex((h) => h.key.toLowerCase() === "authorization");
  if (authIdx >= 0) {
    const v = headers[authIdx].value;
    const bearer = /^Bearer\s+(.+)$/i.exec(v);
    if (bearer) { req.auth = { kind: "bearer", token: bearer[1] }; headers.splice(authIdx, 1); }
    else if (/^Basic\s+/i.test(v) && req.auth.kind === "none") {
      try {
        const [user, ...rest] = atob(v.replace(/^Basic\s+/i, "")).split(":");
        req.auth = { kind: "basic", user, pass: rest.join(":") };
        headers.splice(authIdx, 1);
      } catch { /* not valid base64 — leave it as a header */ }
    }
  }

  const bodyText = data.join("&");
  const ct = headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "";

  req.url = url;
  req.headers = headers;
  // curl defaults to POST when there is a body and no -X, which is what a browser's copied
  // command relies on.
  req.method = method ?? (bodyText || isForm ? "POST" : "GET");
  req.name = nameFromUrl(url);

  if (isForm) {
    req.bodyKind = "form";
    req.formRows = form;
  } else if (bodyText) {
    const looksJson = /json/i.test(ct) || /^\s*[[{]/.test(bodyText);
    req.bodyKind = looksJson ? "json" : "text";
    req.body = bodyText;
    // A urlencoded body is a set of pairs, and the form grid edits those far better than a
    // single line of text does.
    if (!looksJson && /x-www-form-urlencoded/i.test(ct)) {
      req.bodyKind = "form";
      req.body = "";
      req.formRows = bodyText.split("&").filter(Boolean).map((p) => {
        const at = p.indexOf("=");
        const k = at < 0 ? p : p.slice(0, at);
        const v = at < 0 ? "" : p.slice(at + 1);
        try { return row(decodeURIComponent(k), decodeURIComponent(v)); }
        catch { return row(k, v); }
      });
    }
  }

  return req;
}

/** A readable name from a URL — the last path segment, else the host. */
function nameFromUrl(url: string): string {
  try {
    const u = new URL(url.replace(/\{\{[^}]*\}\}/g, "x")); // a {{var}} is not a valid URL
    const seg = u.pathname.split("/").filter(Boolean).pop();
    return seg || u.hostname || "Imported request";
  } catch {
    return url.split("/").filter(Boolean).pop() || "Imported request";
  }
}

/** Shell-quote a value for the generated command. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A curl command for a request, as multi-line POSIX shell.
 *
 * With no `vars`, {{variables}} are left as they are: the command usually goes to someone else,
 * and a resolved token pasted into a chat is exactly what environments exist to avoid. Pass the
 * environment to get a command that runs as-is — the caller decides, because both are wanted at
 * different times (a colleague vs. your own terminal).
 */
export function toCurl(req: Request, vars?: Record<string, string>): string {
  const v = (text: string) => (vars ? substitute(text, vars) : text);
  // buildSend decides the final URL — it merges in params the URL does not already name, which
  // is how a request written by the MCP or an import carries its query string. Copying req.url
  // straight would drop exactly those, and the copied command would hit a different endpoint
  // than the Send button does. It substitutes variables too, so v() is not applied on top: with
  // no vars given, {{name}} survives buildSend untouched, which is the "keep the template" copy.
  const parts = [`curl -X ${req.method} ${q(buildSend(req, vars ?? {}).url)}`];

  for (const h of req.headers) {
    if (!h.on || !h.key) continue;
    parts.push(`  -H ${q(`${h.key}: ${v(h.value)}`)}`);
  }

  // Same precedence buildSend applies: an explicit Authorization header beats the Auth tab.
  // The copied command has to make the same request the Send button does, so this rule cannot
  // live in only one of them.
  const hasAuthHeader = req.headers.some(
    (h) => h.on && h.key.trim().toLowerCase() === "authorization",
  );

  if (!hasAuthHeader && req.auth.kind === "bearer" && req.auth.token) {
    parts.push(`  -H ${q(`Authorization: Bearer ${v(req.auth.token)}`)}`);
  } else if (!hasAuthHeader && req.auth.kind === "basic" && (req.auth.user || req.auth.pass)) {
    // An empty basic auth is the "none" case wearing a different hat — emitting `-u ':'` puts a
    // meaningless flag in every command from a request that has no auth set.
    parts.push(`  -u ${q(`${v(req.auth.user)}:${v(req.auth.pass)}`)}`);
  }

  if (req.bodyKind === "form") {
    for (const f of req.formRows) {
      if (!f.on || !f.key) continue;
      parts.push(`  -F ${q(`${f.key}=${v(f.value)}`)}`);
    }
  } else if (req.bodyKind !== "none" && req.body) {
    parts.push(`  -d ${q(v(req.body))}`);
  }

  return parts.join(" \\\n");
}

/** Re-key an imported request so it cannot collide with one already stored. */
export function withNewId(req: Request): Request {
  return { ...req, id: newId() };
}
