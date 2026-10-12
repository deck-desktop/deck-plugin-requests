// Runnable check for variable substitution and request building:
//   npx tsx plugins/requests/src/httpclient.check.ts
//
// buildSend is where a mistake is invisible until a request silently goes to the wrong URL or
// leaks a raw {{token}} to someone else's server, so it gets the check rather than the UI.
import assert from "node:assert";
import {
  substitute, buildSend, newRequest, paramsFromUrl, applyParamsToUrl, pathParamsFromUrl,
  downloadName, responseBytes, isImageResponse, responseMedia, type HttpResult,
  parseCookies, migrate, parentOf, isInside, subtree, moveNode, moveToRoot,
  emptyCollections, envVars, type Row, type Collections, type Folder,
} from "./httpclient";

const row = (key: string, value: string, on = true): Row => ({ on, key, value });

// ---- substitute -------------------------------------------------------------

assert.strictEqual(substitute("{{base}}/x", { base: "https://a.com" }), "https://a.com/x");
assert.strictEqual(substitute("{{ base }}/x", { base: "https://a.com" }), "https://a.com/x", "whitespace inside braces");
assert.strictEqual(substitute("a{{x}}b{{x}}c", { x: "-" }), "a-b-c", "every occurrence");

// Unknown names survive verbatim. Blanking them instead would turn a missing variable into a
// request that looks well-formed and fails somewhere far from the cause.
assert.strictEqual(substitute("{{nope}}", {}), "{{nope}}");

// Single pass: a value that itself contains {{...}} is not re-expanded, so a self-reference
// terminates instead of hanging.
assert.strictEqual(substitute("{{a}}", { a: "{{a}}" }), "{{a}}");
assert.strictEqual(substitute("{{a}}", { a: "{{b}}", b: "deep" }), "{{b}}");

// A $ is legal at the start of a name, which is what the built-in generators use. Without it
// {{$guid}} would never match and would go out on the wire literally.
assert.strictEqual(substitute("{{$guid}}", { $guid: "abc" }), "abc");
assert.strictEqual(substitute("id={{$timestamp}}", { $timestamp: "17" }), "id=17");
// A $ name with nothing supplying it still survives verbatim, like any other unknown.
assert.strictEqual(substitute("{{$nope}}", {}), "{{$nope}}");

// ---- buildSend --------------------------------------------------------------

// The URL carries the query string; buildSend does NOT append a param the URL already names,
// because the grid
// rewrites the URL as it is edited. Appending here would send every enabled param twice.
{
  const r = { ...newRequest(), url: "https://a.com/p?q=1", params: [row("q", "1")] };
  assert.strictEqual(buildSend(r, {}).url, "https://a.com/p?q=1", "params not appended a second time");
}

// ...but a param the URL does NOT mention IS appended. The grid and the URL are kept in sync by
// the UI, so this state is unreachable by typing — it arrives when a request is written from
// outside the app (the MCP tools, an imported collection), and the param used to vanish silently.
{
  const r = { ...newRequest(), url: "https://a.com/media", params: [row("uuid", "1f6c065e")] };
  assert.strictEqual(buildSend(r, {}).url, "https://a.com/media?uuid=1f6c065e", "externally-written param");

  // Appended to an existing query string rather than replacing it.
  const r2 = { ...newRequest(), url: "https://a.com/m?a=1", params: [row("a", "1"), row("b", "2")] };
  assert.strictEqual(buildSend(r2, {}).url, "https://a.com/m?a=1&b=2", "mixed known/unknown params");

  // Disabled rows stay out, matching the URL-side behaviour.
  const r3 = { ...newRequest(), url: "https://a.com/m", params: [{ on: false, key: "x", value: "1" }] };
  assert.strictEqual(buildSend(r3, {}).url, "https://a.com/m", "disabled param not appended");

  // Variables resolve, and the value is encoded.
  const r4 = { ...newRequest(), url: "https://a.com/m", params: [row("q", "{{term}}")] };
  assert.strictEqual(buildSend(r4, { term: "a b&c" }).url, "https://a.com/m?q=a%20b%26c", "param var + encoding");

  // A fragment stays at the end; a query appended after it would be part of the fragment.
  const r5 = { ...newRequest(), url: "https://a.com/m#top", params: [row("q", "1")] };
  assert.strictEqual(buildSend(r5, {}).url, "https://a.com/m?q=1#top", "param before the fragment");
}

// Path variables substitute into /:name segments.
{
  const r = { ...newRequest(), url: "https://a.com/users/:id/posts", pathParams: [row("id", "42")] };
  assert.strictEqual(buildSend(r, {}).url, "https://a.com/users/42/posts");
}

// A path value is encoded, so it cannot open a query string or a new path segment.
{
  const r = { ...newRequest(), url: "https://a.com/u/:id", pathParams: [row("id", "a?b/c")] };
  assert.strictEqual(buildSend(r, {}).url, "https://a.com/u/a%3Fb%2Fc");
}

// :id must not also match :idx — the name boundary matters.
{
  const r = {
    ...newRequest(),
    url: "https://a.com/:id/:idx",
    pathParams: [row("id", "1"), row("idx", "2")],
  };
  assert.strictEqual(buildSend(r, {}).url, "https://a.com/1/2");
}

// Disabled and blank-key header rows are dropped.
{
  const r = {
    ...newRequest(),
    url: "https://a.com",
    headers: [row("X-A", "1"), row("X-B", "2", false)],
  };
  assert.deepStrictEqual(buildSend(r, {}).headers, [["X-A", "1"]]);
}

// Variables expand in url, params, headers, and body alike.
{
  const r = {
    ...newRequest(),
    url: "{{base}}/v1?k={{tok}}",
    headers: [row("X-Tok", "{{tok}}")],
    bodyKind: "json" as const,
    body: '{"t":"{{tok}}"}',
  };
  const s = buildSend(r, { base: "https://a.com", tok: "abc" });
  assert.strictEqual(s.url, "https://a.com/v1?k=abc");
  assert.deepStrictEqual(s.headers[0], ["X-Tok", "abc"]);
  assert.strictEqual(s.body, '{"t":"abc"}');
}

// Auth becomes a header, with the token substituted (tokens live in an env var, not inline).
{
  const r = { ...newRequest(), auth: { kind: "bearer" as const, token: "{{tok}}" } };
  assert.deepStrictEqual(buildSend(r, { tok: "s3cret" }).headers, [["Authorization", "Bearer s3cret"]]);
}
{
  const r = { ...newRequest(), auth: { kind: "basic" as const, user: "u", pass: "p" } };
  assert.deepStrictEqual(buildSend(r, {}).headers, [["Authorization", `Basic ${btoa("u:p")}`]]);
}

// Content-Type is defaulted per body kind, but an explicit header wins — otherwise a user
// sending JSON as text/plain (or a vendor type) would be silently overridden.
{
  const j = { ...newRequest(), bodyKind: "json" as const, body: "{}" };
  assert.deepStrictEqual(buildSend(j, {}).headers, [["Content-Type", "application/json"]]);

  const explicit = { ...j, headers: [row("content-type", "application/vnd.x+json")] };
  assert.deepStrictEqual(buildSend(explicit, {}).headers, [["content-type", "application/vnd.x+json"]],
    "explicit Content-Type not duplicated or overridden (case-insensitive match)");
}

// A "none" body sends nothing even if body text is left over from switching kinds.
{
  const r = { ...newRequest(), bodyKind: "none" as const, body: "leftover" };
  assert.strictEqual(buildSend(r, {}).body, null);
}

// Form bodies are urlencoded and typed.
{
  const r = { ...newRequest(), bodyKind: "form" as const, formRows: [row("a", "1"), row("b", "x y")] };
  const s = buildSend(r, {});
  assert.strictEqual(s.body, "a=1&b=x%20y");
  assert.deepStrictEqual(s.headers, [["Content-Type", "application/x-www-form-urlencoded"]]);
  assert.ok(!("multipart" in s), "a plain form must not switch Rust onto the multipart path");
}

// A file row turns the whole form into multipart. Checked here because the failure is invisible
// from this side: sending the path as a text field looks like a working request and only the
// remote server complains, about a field it saw as a string.
{
  const fileRow = { on: true, key: "file", value: "{{dir}}/clip.mp3", kind: "file" as const };
  const r = { ...newRequest(), bodyKind: "form" as const, formRows: [fileRow, row("lang", "en")] };
  const s = buildSend(r, { dir: "C:/tmp" });

  assert.strictEqual(s.body, null, "no urlencoded body alongside multipart");
  // No Content-Type: reqwest writes its own, carrying the boundary it generated. Sending one
  // here would leave the server parsing against the wrong boundary.
  assert.deepStrictEqual(s.headers, [], "content-type is left to reqwest");
  assert.deepStrictEqual(s.multipart, [
    { key: "file", value: "", path: "C:/tmp/clip.mp3" },
    { key: "lang", value: "en" },
  ], "the path is substituted, and plain rows travel as text parts");
}

// filename and content type are optional overrides, omitted when unset.
{
  const fileRow = {
    on: true, key: "doc", value: "/tmp/a.bin", kind: "file" as const,
    filename: "report.pdf", contentType: "application/pdf",
  };
  const r = { ...newRequest(), bodyKind: "form" as const, formRows: [fileRow] };
  assert.deepStrictEqual(buildSend(r, {}).multipart, [
    { key: "doc", value: "", path: "/tmp/a.bin", filename: "report.pdf", content_type: "application/pdf" },
  ]);
}

// An off row is skipped, and a file row that is off must not drag the form into multipart.
{
  const off = { on: false, key: "file", value: "/tmp/a.bin", kind: "file" as const };
  const r = { ...newRequest(), bodyKind: "form" as const, formRows: [off, row("a", "1")] };
  const s = buildSend(r, {});
  assert.ok(!("multipart" in s), "a disabled file row leaves the form urlencoded");
  assert.strictEqual(s.body, "a=1");
}

// ---- URL <-> params sync ----------------------------------------------------

// Query string parses into rows.
assert.deepStrictEqual(paramsFromUrl("https://a.com/p?x=1&y=2", []), [
  { on: true, key: "x", value: "1" },
  { on: true, key: "y", value: "2" },
]);

// No query means no enabled rows.
assert.deepStrictEqual(paramsFromUrl("https://a.com/p", []), []);

// Disabled rows survive parsing. They are absent from the URL by definition, so dropping them
// would delete a row the instant it was unticked.
{
  const kept = paramsFromUrl("https://a.com?x=1", [{ on: false, key: "off", value: "9" }]);
  assert.deepStrictEqual(kept, [
    { on: true, key: "x", value: "1" },
    { on: false, key: "off", value: "9" },
  ]);
}

// Percent-encoding is decoded for display...
assert.deepStrictEqual(paramsFromUrl("https://a.com?q=a%20b", []), [{ on: true, key: "q", value: "a b" }]);

// ...but a stray "%" (a half-typed URL) must not throw; the raw text is kept.
assert.deepStrictEqual(paramsFromUrl("https://a.com?q=100%", []), [{ on: true, key: "q", value: "100%" }]);

// A key with no "=" is a valid flag param.
assert.deepStrictEqual(paramsFromUrl("https://a.com?flag", []), [{ on: true, key: "flag", value: "" }]);

// Writing back: enabled rows only, disabled ones simply absent.
assert.strictEqual(
  applyParamsToUrl("https://a.com/p?old=1", [row("x", "1"), row("y", "2", false)]),
  "https://a.com/p?x=1",
);

// Emptying the grid strips the "?" rather than leaving a bare one.
assert.strictEqual(applyParamsToUrl("https://a.com/p?x=1", []), "https://a.com/p");

// A {{var}} in a param is NOT encoded — encoding it would produce %7B%7B and never substitute.
assert.strictEqual(applyParamsToUrl("https://a.com", [row("t", "{{tok}}")]), "https://a.com?t={{tok}}");

// The hash is preserved and stays after the query.
assert.strictEqual(applyParamsToUrl("https://a.com/p#frag", [row("x", "1")]), "https://a.com/p?x=1#frag");

// Round trip: parse then apply leaves the URL unchanged.
{
  const url = "https://a.com/p?x=1&y=2";
  assert.strictEqual(applyParamsToUrl(url, paramsFromUrl(url, [])), url);
}

// ---- path params ------------------------------------------------------------

assert.deepStrictEqual(pathParamsFromUrl("https://a.com/u/:id/p/:slug", []), [
  { on: true, key: "id", value: "" },
  { on: true, key: "slug", value: "" },
]);

// A value already typed for a name survives re-parsing as the rest of the URL is edited.
assert.deepStrictEqual(
  pathParamsFromUrl("https://a.com/u/:id", [{ on: true, key: "id", value: "42" }]),
  [{ on: true, key: "id", value: "42" }],
);

// Removing the segment from the URL removes the row.
assert.deepStrictEqual(pathParamsFromUrl("https://a.com/u", [{ on: true, key: "id", value: "42" }]), []);

// A ":" in the query or the scheme is not a path variable.
assert.deepStrictEqual(pathParamsFromUrl("https://a.com/u?x=:y", []), []);

// ---- cookies ----------------------------------------------------------------

{
  const [c] = parseCookies([["set-cookie", "sid=abc123; Domain=a.com; Path=/x; HttpOnly; Secure"]]);
  assert.strictEqual(c.name, "sid");
  assert.strictEqual(c.value, "abc123");
  assert.strictEqual(c.domain, "a.com");
  assert.strictEqual(c.path, "/x");
  assert.deepStrictEqual(c.flags, ["HttpOnly", "Secure"]);
}

// Path defaults to "/" when the server does not send one.
assert.strictEqual(parseCookies([["Set-Cookie", "a=1"]])[0].path, "/");

// A value containing "=" (base64, JWTs) keeps everything after the first "=".
assert.strictEqual(parseCookies([["set-cookie", "t=aGk=; Path=/"]])[0].value, "aGk=");

// Non-cookie headers are ignored, and the match is case-insensitive.
assert.strictEqual(parseCookies([["Content-Type", "text/plain"]]).length, 0);

// ---- collection tree --------------------------------------------------------

const folder = (id: string, parentId: string | null, children: string[] = []): Folder =>
  ({ id, name: id, workspaceId: "w1", parentId, children });

// A tree: c1 > [f1 > [r1], r2], c2 > []
const tree = (): Collections => ({
  ...emptyCollections(),
  folders: [
    folder("c1", null, ["f1", "r2"]),
    folder("f1", "c1", ["r1"]),
    folder("c2", null, []),
  ],
  requests: { r1: { ...newRequest(), id: "r1" }, r2: { ...newRequest(), id: "r2" } },
});

// -- migration --

// The first version stored flat folders with requestIds, and no workspaces at all. Each folder
// becomes a root collection, and everything lands in one default workspace.
{
  const old = {
    folders: [{ id: "a", name: "A", requestIds: ["x", "y"] }],
    requests: {},
    environments: [{ id: "e1", name: "prod", vars: [] }],
    activeEnvId: "e1",
  };
  const m = migrate(old as unknown as Collections);

  assert.strictEqual(m.workspaces.length, 1, "one default workspace");
  const ws = m.workspaces[0].id;
  assert.strictEqual(m.activeWorkspaceId, ws);

  assert.deepStrictEqual(m.folders, [{ id: "a", name: "A", workspaceId: ws, parentId: null, children: ["x", "y"] }]);
  assert.strictEqual(m.environments[0].workspaceId, ws, "environments join the workspace too");

  // The previously-global active environment becomes the workspace's, so nothing changes on
  // screen — the data just gains a level above it.
  assert.strictEqual(m.workspaces[0].activeEnvId, "e1");
  assert.deepStrictEqual(envVars(m), {}, "empty vars, but resolved through the workspace");

  // Idempotent: it runs on every load, so a second pass must change nothing.
  assert.deepStrictEqual(migrate(m), m);
}

// A legacy folder with no requestIds at all still migrates to an empty collection.
{
  const m = migrate({ ...emptyCollections(), folders: [{ id: "a", name: "A" } as unknown as Folder] });
  assert.deepStrictEqual(m.folders, [{ id: "a", name: "A", workspaceId: m.workspaces[0].id, parentId: null, children: [] }]);
}

// A fresh install has no data at all; migrate is what gives it a workspace to put things in.
{
  const fresh = migrate(emptyCollections());
  assert.strictEqual(fresh.workspaces.length, 1);
  assert.strictEqual(fresh.activeWorkspaceId, fresh.workspaces[0].id);
}

// A store whose active workspace was deleted still opens, on the first one that remains.
{
  const c = { ...emptyCollections(), workspaces: [{ id: "w2", name: "B", activeEnvId: null }], activeWorkspaceId: "gone" };
  assert.strictEqual(migrate(c).activeWorkspaceId, "w2");
}

// Variables resolve through the ACTIVE workspace, so another workspace's environment of the
// same name cannot leak into a request.
{
  const c: Collections = {
    ...emptyCollections(),
    workspaces: [
      { id: "w1", name: "Work", activeEnvId: "e1" },
      { id: "w2", name: "Side", activeEnvId: "e2" },
    ],
    activeWorkspaceId: "w1",
    environments: [
      { id: "e1", name: "prod", workspaceId: "w1", vars: [{ on: true, key: "base", value: "https://prod" }] },
      { id: "e2", name: "local", workspaceId: "w2", vars: [{ on: true, key: "base", value: "http://localhost" }] },
    ],
  };
  assert.deepStrictEqual(envVars(c), { base: "https://prod" });
  assert.deepStrictEqual(envVars({ ...c, activeWorkspaceId: "w2" }), { base: "http://localhost" });
  // No active workspace at all resolves to nothing rather than to some other workspace's env.
  assert.deepStrictEqual(envVars({ ...c, activeWorkspaceId: null }), {});
}

// -- parentOf / isInside / subtree --

assert.strictEqual(parentOf(tree().folders, "r1")?.id, "f1");
assert.strictEqual(parentOf(tree().folders, "f1")?.id, "c1");
assert.strictEqual(parentOf(tree().folders, "c1"), null, "a collection has no parent");

assert.ok(isInside(tree().folders, "f1", "c1"));
assert.ok(isInside(tree().folders, "c1", "c1"), "a node is inside itself");
assert.ok(!isInside(tree().folders, "c1", "f1"), "a parent is not inside its child");
assert.ok(!isInside(tree().folders, "f1", "c2"));

{
  const s = subtree(tree().folders, "c1");
  assert.deepStrictEqual(s.folderIds.sort(), ["c1", "f1"]);
  assert.deepStrictEqual(s.requestIds.sort(), ["r1", "r2"]);
}

// -- moveNode --

// A request moves between collections and ends up in exactly one parent.
{
  const m = moveNode(tree(), "r1", "c2");
  assert.deepStrictEqual(m.folders.find((f) => f.id === "f1")!.children, []);
  assert.deepStrictEqual(m.folders.find((f) => f.id === "c2")!.children, ["r1"]);
  assert.strictEqual(m.folders.filter((f) => f.children.includes("r1")).length, 1, "never in two parents");
}

// A folder moves, and its parentId follows — otherwise parentOf and isInside disagree.
{
  const m = moveNode(tree(), "f1", "c2");
  assert.strictEqual(m.folders.find((f) => f.id === "f1")!.parentId, "c2");
  assert.deepStrictEqual(m.folders.find((f) => f.id === "c1")!.children, ["r2"]);
  // Its own children came along.
  assert.deepStrictEqual(m.folders.find((f) => f.id === "f1")!.children, ["r1"]);
}

// The cycle guard: dropping a folder into its own descendant would detach the subtree from
// every root, so it is refused outright.
{
  const before = tree();
  assert.deepStrictEqual(moveNode(before, "c1", "f1"), before, "no move into own descendant");
  assert.deepStrictEqual(moveNode(before, "c1", "c1"), before, "no move into self");
}

// beforeId inserts at that position...
{
  const m = moveNode(tree(), "r1", "c1", "f1");
  assert.deepStrictEqual(m.folders.find((f) => f.id === "c1")!.children, ["r1", "f1", "r2"]);
}
// ...and omitting it appends.
{
  const m = moveNode(tree(), "r1", "c1");
  assert.deepStrictEqual(m.folders.find((f) => f.id === "c1")!.children, ["f1", "r2", "r1"]);
}

// Reordering inside one folder: the index is taken after the removal, so the node lands where
// it was aimed rather than one slot off.
{
  const c: Collections = { ...emptyCollections(), folders: [folder("c1", null, ["a", "b", "d"])] };
  assert.deepStrictEqual(moveNode(c, "a", "c1", "d").folders[0].children, ["b", "a", "d"]);
  assert.deepStrictEqual(moveNode(c, "d", "c1", "a").folders[0].children, ["d", "a", "b"]);
}

// An unknown destination is a no-op rather than a lost node.
assert.deepStrictEqual(moveNode(tree(), "r1", "nope"), tree());

// -- moveToRoot --

{
  const m = moveToRoot(tree(), "f1");
  assert.strictEqual(m.folders.find((f) => f.id === "f1")!.parentId, null, "f1 is now a collection");
  assert.deepStrictEqual(m.folders.find((f) => f.id === "c1")!.children, ["r2"]);
}
// A request cannot be a collection, so it stays put.
assert.deepStrictEqual(moveToRoot(tree(), "r1"), tree());

console.log("ok");

// ---- download naming --------------------------------------------------------
// A wrong name here is not a crash, it is a folder of files called "response.bin" that nobody
// can tell apart, so the fallback order is worth pinning down.
{
  const res = (headers: [string, string][], body = "x"): HttpResult =>
    ({ status: 200, status_text: "OK", headers, body, size: body.length, truncated: false, elapsed_ms: 1 });

  const png: [string, string][] = [["Content-Type", "image/png"]];

  // Content-Disposition wins over everything.
  assert.strictEqual(
    downloadName(res([...png, ["Content-Disposition", 'attachment; filename="cat.png"']]), "https://a.com/x"),
    "cat.png");
  // RFC 6266's encoded form, and it beats the plain one.
  assert.strictEqual(
    downloadName(res([["Content-Disposition", "attachment; filename=\"a.png\"; filename*=UTF-8''caf%C3%A9.png"]]), "https://a.com/x"),
    "café.png");

  // Otherwise the URL's last segment, with the extension from the content type.
  assert.strictEqual(downloadName(res(png), "https://a.com/api/downloadmedia?uuid=1"), "downloadmedia.png");
  // An extension already in the URL is kept rather than doubled.
  assert.strictEqual(downloadName(res(png), "https://a.com/img/cat.png"), "cat.png");
  // Nothing to go on at all.
  assert.strictEqual(downloadName(res(png), "https://a.com/"), "response.png");
  // An unknown type falls back to .bin rather than guessing.
  assert.strictEqual(downloadName(res([["Content-Type", "application/x-thing"]]), "https://a.com/f"), "f.bin");
  // A server-supplied name cannot escape the folder it is saved into.
  assert.strictEqual(
    downloadName(res([["Content-Disposition", 'attachment; filename="../../evil.exe"']]), "https://a.com/x"),
    ".._.._evil.exe");

  // Bytes: base64 round-trips exactly, text encodes as UTF-8.
  const withB64 = { ...res(png), body_b64: "iVBORw==" };
  assert.deepStrictEqual(Array.from(responseBytes(withB64)), [0x89, 0x50, 0x4e, 0x47]);
  assert.deepStrictEqual(Array.from(responseBytes(res([], "hé"))), [0x68, 0xc3, 0xa9]);

  assert.ok(isImageResponse(png));
  assert.ok(!isImageResponse([["Content-Type", "application/json"]]));

  // Which viewer a response gets. Parameters after the type must not defeat the match.
  const ct = (v: string) => responseMedia([["Content-Type", v]]);
  assert.strictEqual(ct("image/png"), "image");
  assert.strictEqual(ct("image/svg+xml; charset=utf-8"), "image");
  assert.strictEqual(ct("video/mp4"), "video");
  assert.strictEqual(ct("audio/mpeg"), "audio");
  assert.strictEqual(ct("application/pdf"), "pdf");
  assert.strictEqual(ct("application/json"), null);
  assert.strictEqual(responseMedia([]), null);
}

console.log("httpclient: download naming checks pass");
