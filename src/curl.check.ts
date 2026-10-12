// Runnable check for the curl parser:
//   npx tsx plugins/requests/src/curl.check.ts
//
// The tokenizer is where the bugs live — quotes, escapes and the line continuations a browser
// emits — and a misparse silently produces a request that hits the wrong URL with the wrong body.
import assert from "node:assert";
import { tokenize, parseCurl, toCurl } from "./curl";
import { buildSend } from "./httpclient";
import { newRequest } from "./httpclient";

// ---- tokenizer ----

assert.deepStrictEqual(tokenize("curl https://x.dev"), ["curl", "https://x.dev"]);

// Quotes hold whitespace together.
assert.deepStrictEqual(
  tokenize(`curl -H 'a: b c' https://x.dev`),
  ["curl", "-H", "a: b c", "https://x.dev"],
);

// A backslash escapes inside double quotes but is literal inside single ones.
assert.deepStrictEqual(tokenize(`curl -d "a\\"b"`), ["curl", "-d", 'a"b']);
assert.deepStrictEqual(tokenize(`curl -d 'a\\b'`), ["curl", "-d", "a\\b"]);

// Line continuations, both shells. Chrome emits the first, cmd the second.
assert.deepStrictEqual(
  tokenize("curl \\\n  -X POST \\\n  https://x.dev"),
  ["curl", "-X", "POST", "https://x.dev"],
);
assert.deepStrictEqual(
  tokenize("curl ^\n  -X POST ^\n  https://x.dev"),
  ["curl", "-X", "POST", "https://x.dev"],
);

// An explicitly empty argument survives — -d '' means an empty body, not no body.
assert.deepStrictEqual(tokenize(`curl -d '' https://x.dev`), ["curl", "-d", "", "https://x.dev"]);

// ---- parser ----

assert.strictEqual(parseCurl("wget https://x.dev"), null, "only curl commands");
assert.strictEqual(parseCurl("curl -X POST"), null, "a command with no URL is not a request");

{
  const r = parseCurl(`curl https://api.dev/users`)!;
  assert.strictEqual(r.method, "GET");
  assert.strictEqual(r.url, "https://api.dev/users");
  assert.strictEqual(r.name, "users", "named from the last path segment");
}

{
  // No -X but a body: curl posts, and a copied browser command relies on that.
  const r = parseCurl(`curl https://api.dev/u -d '{"a":1}' -H 'Content-Type: application/json'`)!;
  assert.strictEqual(r.method, "POST");
  assert.strictEqual(r.bodyKind, "json");
  assert.strictEqual(r.body, '{"a":1}');
}

{
  // JSON detected from the body's shape when the header is absent.
  const r = parseCurl(`curl https://api.dev/u -d '[1,2]'`)!;
  assert.strictEqual(r.bodyKind, "json");
}

{
  // A urlencoded body becomes form rows, which is what the grid can actually edit.
  const r = parseCurl(
    `curl https://api.dev/u -H 'content-type: application/x-www-form-urlencoded' -d 'a=1&b=two%20words'`,
  )!;
  assert.strictEqual(r.bodyKind, "form");
  assert.strictEqual(r.body, "");
  assert.deepStrictEqual(r.formRows.map((f) => [f.key, f.value]), [["a", "1"], ["b", "two words"]]);
}

{
  // Repeated -d joins with & — curl's own behaviour.
  const r = parseCurl(`curl https://api.dev/u -d a=1 -d b=2`)!;
  assert.strictEqual(r.body, "a=1&b=2");
}

{
  const r = parseCurl(`curl https://api.dev/u -H 'Authorization: Bearer abc123'`)!;
  assert.deepStrictEqual(r.auth, { kind: "bearer", token: "abc123" });
  assert.strictEqual(r.headers.length, 0, "the header is consumed, not duplicated");
}

{
  const r = parseCurl(`curl https://api.dev/u -u alice:s3cret`)!;
  assert.deepStrictEqual(r.auth, { kind: "basic", user: "alice", pass: "s3cret" });
}

{
  // Basic in a header decodes to the same thing.
  const b64 = Buffer.from("bob:pw").toString("base64");
  const r = parseCurl(`curl https://api.dev/u -H 'Authorization: Basic ${b64}'`)!;
  assert.deepStrictEqual(r.auth, { kind: "basic", user: "bob", pass: "pw" });
}

{
  const r = parseCurl(`curl https://api.dev/u -F 'file=@a.txt' -F 'name=x'`)!;
  assert.strictEqual(r.bodyKind, "form");
  assert.strictEqual(r.method, "POST");
  assert.deepStrictEqual(r.formRows.map((f) => f.key), ["file", "name"]);
}

{
  // Flags Deck has no model for must not be mistaken for the URL.
  const r = parseCurl(`curl --compressed -L -k -o out.txt https://api.dev/u`)!;
  assert.strictEqual(r.url, "https://api.dev/u", "-o's value is not the URL");
}

{
  const r = parseCurl(`curl -b 'sid=1' -A 'deck/1' https://api.dev/u`)!;
  assert.deepStrictEqual(
    r.headers.map((h) => h.key).sort(),
    ["Cookie", "User-Agent"],
  );
}

{
  // A {{var}} in the URL must not break naming, which parses the URL.
  const r = parseCurl(`curl https://{{host}}/v1/items`)!;
  assert.strictEqual(r.url, "https://{{host}}/v1/items");
  assert.strictEqual(r.name, "items");
}

// ---- round trip ----

{
  const src = `curl -X PUT https://api.dev/u/1 -H 'X-A: b' -d '{"n":1}'`;
  const back = parseCurl(toCurl(parseCurl(src)!))!;
  assert.strictEqual(back.method, "PUT");
  assert.strictEqual(back.url, "https://api.dev/u/1");
  assert.strictEqual(back.body, '{"n":1}');
  assert.deepStrictEqual(back.headers.map((h) => [h.key, h.value]), [["X-A", "b"]]);
}

{
  // A value containing a single quote survives the shell quoting on the way out.
  const r = parseCurl(`curl https://api.dev/u -d "it's"`)!;
  assert.strictEqual(parseCurl(toCurl(r))!.body, "it's");
}

// A {{var}} is exported verbatim: the command usually goes to someone else, and resolving one
// would paste a real token into a chat.
{
  const r = parseCurl(`curl https://api.dev/u -H 'Authorization: Bearer {{token}}'`)!;
  assert.match(toCurl(r), /\{\{token\}\}/);
}

// An empty basic auth is the "none" case in disguise: `-u ':'` in every command from a request
// with no auth set is noise, and re-importing it would create a basic auth that was never there.
{
  const r = parseCurl("curl https://api.dev/u")!;
  r.auth = { kind: "basic", user: "", pass: "" };
  assert.doesNotMatch(toCurl(r), /-u /);
  assert.strictEqual(parseCurl(toCurl(r))!.auth.kind, "none");
}

// Resolved export fills in the environment; the default does not.
{
  const r = parseCurl(`curl https://{{base}}/posts -H 'X-K: {{key}}'`)!;
  const vars = { base: "api.dev", key: "abc" };
  assert.match(toCurl(r), /\{\{base\}\}/, "unresolved by default");
  const out = toCurl(r, vars);
  assert.match(out, /api\.dev\/posts/);
  assert.match(out, /X-K: abc/);
  assert.doesNotMatch(out, /\{\{/, "nothing left unresolved");
}

// A variable with no value in the environment stays as itself rather than becoming empty —
// substitute()'s rule, and the visible signal that something is missing.
{
  const r = parseCurl("curl https://{{missing}}/x")!;
  assert.match(toCurl(r, { other: "1" }), /\{\{missing\}\}/);
}

console.log("ok");

// ---- params reach the copied command ----
// toCurl goes through buildSend rather than reading req.url, so a param the URL does not name —
// which is how an MCP-written or imported request carries its query string — is in the copy too.
// Without this the copied curl hits a different endpoint than the Send button does.
{
  const r = {
    ...newRequest(),
    method: "GET" as const,
    url: "https://api.dev/downloadmedia",
    params: [{ on: true, key: "uuid", value: "1f6c065e" }],
  };
  assert.ok(toCurl(r).includes("https://api.dev/downloadmedia?uuid=1f6c065e"), toCurl(r));

  // A param the URL already names is not doubled.
  const r2 = { ...newRequest(), url: "https://api.dev/x?a=1", params: [{ on: true, key: "a", value: "1" }] };
  assert.strictEqual((toCurl(r2).match(/a=1/g) ?? []).length, 1, toCurl(r2));

  // The template copy keeps {{var}}; the resolved copy expands it.
  const r3 = { ...newRequest(), url: "https://{{host}}/m", params: [{ on: true, key: "id", value: "{{mediaId}}" }] };
  assert.ok(toCurl(r3).includes("{{host}}"), toCurl(r3));
  assert.ok(toCurl(r3).includes("id={{mediaId}}"), toCurl(r3));
  assert.ok(toCurl(r3, { host: "api.dev", mediaId: "7" }).includes("https://api.dev/m?id=7"),
    toCurl(r3, { host: "api.dev", mediaId: "7" }));
}

console.log("curl: params-in-copy checks pass");

// ---- Authorization is emitted once, not twice ------------------------------------------------
// A request can carry an explicit Authorization header AND have the Auth tab set. Both
// buildSend and toCurl used to add the auth one unconditionally, so the header went out twice:
// reqwest's .header() APPENDS rather than replaces (see src-tauri/src/http.rs), which servers
// may reject or resolve either way. The explicit header wins in both paths.
{
  const withBoth = {
    ...newRequest(),
    method: "PUT" as const,
    url: "https://api.dev/app-versions",
    headers: [{ on: true, key: "Authorization", value: "Bearer {{token}}" }],
    auth: { kind: "bearer" as const, token: "{{token}}" },
  };

  const cmd = toCurl(withBoth);
  assert.strictEqual((cmd.match(/Authorization:/g) ?? []).length, 1, cmd);

  const sent = buildSend(withBoth, {}).headers.filter(([k]) => k.toLowerCase() === "authorization");
  assert.strictEqual(sent.length, 1, JSON.stringify(sent));
  // The typed header is the one kept — it is this request's override of the tab default.
  assert.strictEqual(sent[0][1], "Bearer {{token}}", sent[0][1]);

  // Case and padding must not open a second copy: "authorization " is the same header.
  const odd = { ...withBoth, headers: [{ on: true, key: " authorization ", value: "Bearer x" }] };
  // The key is emitted verbatim (" authorization "), so match the name without the colon.
  assert.strictEqual((toCurl(odd).match(/authorization/gi) ?? []).length, 1, toCurl(odd));
  assert.strictEqual(
    buildSend(odd, {}).headers.filter(([k]) => k.trim().toLowerCase() === "authorization").length, 1);

  // A DISABLED Authorization row is not a header at all, so the Auth tab still applies —
  // otherwise switching a header off would silently drop auth from the request entirely.
  const off = { ...withBoth, headers: [{ on: false, key: "Authorization", value: "Bearer old" }] };
  assert.strictEqual((toCurl(off).match(/Authorization:/g) ?? []).length, 1, toCurl(off));
  assert.strictEqual(buildSend(off, {}).headers.filter(([k]) => k.toLowerCase() === "authorization").length, 1);

  // Basic auth takes the same rule, and emits -u only when the tab is the source.
  const basicBoth = {
    ...newRequest(),
    headers: [{ on: true, key: "Authorization", value: "Basic abc" }],
    auth: { kind: "basic" as const, user: "u", pass: "p" },
  };
  assert.ok(!toCurl(basicBoth).includes("-u "), toCurl(basicBoth));
  assert.strictEqual(
    buildSend(basicBoth, {}).headers.filter(([k]) => k.toLowerCase() === "authorization").length, 1);

  // With no explicit header, the tab is still what supplies auth — the fix must not remove it.
  const tabOnly = { ...newRequest(), auth: { kind: "bearer" as const, token: "t" } };
  assert.ok(toCurl(tabOnly).includes("Authorization: Bearer t"), toCurl(tabOnly));
  assert.strictEqual(buildSend(tabOnly, {}).headers.filter(([k]) => k.toLowerCase() === "authorization").length, 1);
}

console.log("curl: auth is emitted once");
