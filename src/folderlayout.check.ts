// A workspace kept in a folder: the files it makes, what it keeps back, and that reading them gives
// the same workspace, including after the edits a person or a merge makes to them by hand.
//
//   npx tsx src/folderlayout.check.ts
import assert from "node:assert/strict";
import { newRequest } from "./httpclient";
import { fileName, fromFiles, isWorkspace, toFiles, type WsParts } from "./folderlayout";

const parts: WsParts = {
  id: "ws1", name: "Team API",
  folders: [
    { id: "c1", name: "Users", workspaceId: "ws1", parentId: null, children: ["r1", "f2", "r2"] },
    { id: "f2", name: "Admin", workspaceId: "ws1", parentId: "c1", children: ["r3"] },
    { id: "c2", name: "Orders: v2?", workspaceId: "ws1", parentId: null, children: ["r4", "r5"] },
  ],
  requests: {
    r1: { ...newRequest("Get user"), id: "r1", url: "{{base}}/users/1", auth: { kind: "bearer", token: "sk-SECRET" },
      headers: [{ on: true, key: "Authorization", value: "Bearer sk-SECRET" }, { on: true, key: "X-Api-Key", value: "{{key}}" }, { on: true, key: "Accept", value: "application/json" }] },
    r2: { ...newRequest("Create user"), id: "r2", method: "POST", url: "{{base}}/users", bodyKind: "json", body: '{ "name": "x" }', preScript: "pm.environment.set('a', 1)" },
    r3: { ...newRequest("Ban user"), id: "r3", method: "DELETE", url: "{{base}}/users/:id", auth: { kind: "basic", user: "admin", pass: "hunter2-SECRET" } },
    r4: { ...newRequest("List"), id: "r4", url: "{{base}}/orders" },
    r5: { ...newRequest("List"), id: "r5", url: "{{base}}/orders?all=1" },
  },
  environments: [{ id: "e1", name: "Dev", workspaceId: "ws1", vars: [{ on: true, key: "base", value: "https://dev.example-SECRET" }, { on: false, key: "key", value: "" }] }],
};

const { files, secrets } = toFiles(parts);
// The tree a person sees, with names they can read.
assert.deepEqual([...files.keys()].sort(), [
  "Orders- v2-/List (r5).json", "Orders- v2-/List.json", "Orders- v2-/folder.json",
  "Users/Admin/Ban user.json", "Users/Admin/folder.json", "Users/Create user.json", "Users/Get user.json", "Users/folder.json",
  "environments/Dev.json", "workspace.json",
]);
assert.ok(isWorkspace(files));
// No secret is in any file; each is kept on this Deck.
const all = [...files.values()].join("\n");
assert.ok(!all.includes("SECRET"), "no secret is written into the folder");
assert.ok(all.includes("{{key}}") && all.includes("application/json"), "references and ordinary headers are");
assert.equal(secrets.req.r1.token, "sk-SECRET");
assert.equal(secrets.req.r1.headers?.authorization, "Bearer sk-SECRET");
assert.equal(secrets.req.r3.pass, "hunter2-SECRET");
assert.equal(secrets.env.e1.base, "https://dev.example-SECRET");
assert.equal(secrets.req.r2, undefined, "a request with no credentials keeps nothing");

// Read back with the secrets: the same workspace.
const back = fromFiles(files, secrets)!;
assert.deepEqual(back.skipped, []);
assert.equal(back.name, "Team API");
assert.deepEqual(back.folders.map((f) => [f.id, f.parentId, f.children]), [["c1", null, ["r1", "f2", "r2"]], ["c2", null, ["r4", "r5"]], ["f2", "c1", ["r3"]]]);
for (const id of Object.keys(parts.requests)) assert.deepEqual(back.requests[id], parts.requests[id], id);
assert.deepEqual(back.environments, parts.environments);
// Read back on a Deck that has none of the secrets: blanks, nothing else lost.
const theirs = fromFiles(files)!;
assert.equal(theirs.requests.r1.auth.kind === "bearer" && theirs.requests.r1.auth.token, "");
assert.equal(theirs.requests.r1.url, "{{base}}/users/1");
assert.deepEqual(theirs.environments[0].vars.map((v) => [v.key, v.value]), [["base", ""], ["key", ""]]);

// Edits by hand, or a merge: a request file added that no folder.json lists, one deleted that is
// still listed, a broken file, and a renamed file.
const edited = new Map(files);
edited.set("Users/Admin/Unban user.json", JSON.stringify({ id: "r9", name: "Unban user", method: "POST", url: "{{base}}/users/:id/unban" }));
edited.delete("Users/Create user.json");
edited.set("Orders- v2-/List.json", "{ not json");
edited.set("Users/Fetch user.json", edited.get("Users/Get user.json")!);
edited.delete("Users/Get user.json");
const merged = fromFiles(edited, secrets)!;
assert.deepEqual(merged.skipped, ["Orders- v2-/List.json"]);
assert.deepEqual(merged.folders.find((f) => f.id === "f2")!.children, ["r3", "r9"], "an unlisted request is added after the listed ones");
assert.deepEqual(merged.folders.find((f) => f.id === "c1")!.children, ["r1", "f2"], "a deleted one is gone, a renamed file is the same request");
assert.equal(merged.requests.r9.method, "POST");
assert.deepEqual(merged.requests.r9.headers, [], "a hand-written request is filled in");
assert.equal(merged.requests.r1.auth.kind === "bearer" && merged.requests.r1.auth.token, "sk-SECRET", "the secrets follow the id, not the file name");

// Not a workspace folder at all.
assert.equal(fromFiles(new Map([["readme.json", "{}"]])), null);
assert.equal(isWorkspace(new Map([["workspace.json", '{"name":"x"}']])), false);

// File names: safe on Windows, readable.
assert.equal(fileName('a/b:c*?"<>|'), "a-b-c------");
assert.equal(fileName("CON"), "_CON");
assert.equal(fileName("trailing. "), "trailing");
assert.equal(fileName(""), "untitled");
console.log("folderlayout: all checks passed");
