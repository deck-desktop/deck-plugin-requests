// The `pm` reference and the snippets shown beside the script editor.
//
// Kept as data rather than JSX so the same list can back the docs panel, a future command
// palette entry, and the MCP tool that writes scripts — the API only has to be described once.

export interface DocEntry {
  /** How it is written in a script. */
  sig: string;
  what: string;
}

export interface DocGroup {
  title: string;
  /** Which script this applies to. "post" entries are absent from a pre-request script. */
  scope: "both" | "pre" | "post";
  entries: DocEntry[];
}

export const PM_REFERENCE: DocGroup[] = [
  {
    title: "Variables",
    scope: "both",
    entries: [
      { sig: 'pm.environment.get("base")', what: "Read a variable from the active environment." },
      { sig: 'pm.environment.set("token", value)', what: "Write one. Saved back to the active environment after the script runs." },
      { sig: 'pm.environment.unset("token")', what: "Remove one." },
      { sig: 'pm.environment.has("token")', what: "True if it is defined." },
      { sig: "pm.environment.toObject()", what: "Every variable as a plain object." },
      { sig: "pm.variables", what: "An alias for pm.environment — Deck has one variable scope." },
    ],
  },
  {
    title: "Request",
    scope: "both",
    entries: [
      { sig: "pm.request.method", what: '"GET", "POST", …' },
      { sig: "pm.request.url", what: "The URL being sent, with {{variables}} already substituted." },
      { sig: "pm.request.headers", what: "Array of [name, value] pairs, including the one auth adds." },
      { sig: "pm.request.body", what: "The body as a string, or null. Read-only." },
    ],
  },
  {
    title: "Response",
    scope: "post",
    entries: [
      { sig: "pm.response.code", what: "Status code as a number." },
      { sig: "pm.response.status", what: 'Status text — "OK", "Not Found".' },
      { sig: "pm.response.json()", what: "The body parsed as JSON. Throws if it is not JSON." },
      { sig: "pm.response.text()", what: "The raw body." },
      { sig: 'pm.response.headers.get("content-type")', what: "One header, matched case-insensitively." },
      { sig: "pm.response.responseTime", what: "Round trip in milliseconds." },
    ],
  },
  {
    title: "Tests",
    scope: "post",
    entries: [
      { sig: 'pm.test("name", () => { … })', what: "One test. A throw inside marks it failed; the tests after it still run." },
      { sig: "pm.response.to.have.status(200)", what: "Assert the status code." },
      { sig: "pm.expect(x).to.equal(y)", what: "Strict equality. .eql(y) compares deeply." },
      { sig: "pm.expect(x).to.include(y)", what: "Substring, or array membership." },
      { sig: 'pm.expect(x).to.have.property("id")', what: "Property exists. A second argument checks its value." },
      { sig: "pm.expect(x).to.be.above(n)", what: "Also .below(n), .ok(), .a(\"string\"), .length(n)." },
    ],
  },
  {
    title: "Output",
    scope: "both",
    entries: [{ sig: "console.log(…)", what: "Printed under the Tests tab of the response." }],
  },
];

export interface Snippet { label: string; scope: "pre" | "post"; code: string }

export const SNIPPETS: Snippet[] = [
  {
    label: "Status is 200",
    scope: "post",
    code: `pm.test("status is 200", () => {\n  pm.response.to.have.status(200);\n});`,
  },
  {
    label: "Save a token from the response",
    scope: "post",
    code: `const data = pm.response.json();\npm.environment.set("token", data.access_token);`,
  },
  {
    label: "Check a field",
    scope: "post",
    code: `pm.test("returns a list", () => {\n  const body = pm.response.json();\n  pm.expect(body).to.be.a("object");\n  pm.expect(body).to.have.property("id");\n});`,
  },
  {
    label: "Response was fast",
    scope: "post",
    code: `pm.test("under 500ms", () => {\n  pm.expect(pm.response.responseTime).to.be.below(500);\n});`,
  },
  {
    label: "Timestamp for this request",
    scope: "pre",
    code: `pm.environment.set("now", new Date().toISOString());`,
  },
  {
    label: "Build a signature",
    scope: "pre",
    code: `// Everything a script needs must be computed here — there is no network access.\nconst nonce = Math.random().toString(36).slice(2);\npm.environment.set("nonce", nonce);\npm.environment.set("sig", nonce + pm.environment.get("secret"));`,
  },
  {
    label: "Skip work when a token is still set",
    scope: "pre",
    code: `if (!pm.environment.has("token")) {\n  console.log("No token — run the login request first.");\n}`,
  },
];

/**
 * Why there is no fetch: scripts run in a Worker with the network globals removed, because a
 * collection can be imported from a file and would otherwise be able to post the environment —
 * API tokens included — anywhere. To refresh a token, send a login request whose post-response
 * script does pm.environment.set("token", …), then use {{token}} in the other requests.
 */
export const SANDBOX_NOTE =
  "Scripts run in a sandbox with no fetch and no require, and are stopped after 5 seconds. " +
  "To get a token, send a login request whose post-response script sets it, then use {{token}} " +
  "elsewhere. Scripts in a collection you imported are still someone else's code — read them.";
