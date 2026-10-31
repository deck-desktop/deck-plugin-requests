// A shared workspace kept in step between Decks: what is sent, what is kept back, and that two
// copies edited apart end the same.
//
//   npx tsx src/teamsync.check.ts
import assert from "node:assert/strict";
import { emptyCollections, newRequest, type Collections } from "./httpclient";
import { apply, behind, digest, localChanges, newerThan, records, recsFor, type Meta, type Rec } from "./teamsync";

const WS = "ws1", TEAM = "team1";
let clock = 1000;
const tick = () => (clock += 10);

// A: a workspace with a collection, a request carrying credentials, an environment with values.
const req = { ...newRequest("Get user"), id: "r1", url: "{{base}}/users/1",
  auth: { kind: "bearer" as const, token: "sk-live-SECRET" },
  headers: [{ on: true, key: "Authorization", value: "Bearer sk-live-SECRET" }, { on: true, key: "Accept", value: "application/json" }, { on: true, key: "X-Api-Key", value: "{{apiKey}}" }] };
let a: Collections = {
  ...emptyCollections(),
  workspaces: [{ id: WS, name: "Backend", activeEnvId: null, teamId: TEAM }, { id: "mine", name: "Private", activeEnvId: null }],
  activeWorkspaceId: WS,
  folders: [{ id: "f1", name: "Users", workspaceId: WS, parentId: null, children: ["r1"] }, { id: "fp", name: "Mine", workspaceId: "mine", parentId: null, children: ["rp"] }],
  requests: { r1: req, rp: { ...newRequest("Private one"), id: "rp" } },
  environments: [{ id: "e1", name: "Dev", workspaceId: WS, vars: [{ on: true, key: "base", value: "https://dev.example" }, { on: true, key: "token", value: "dev-SECRET" }] }],
};
let ma: Meta = {};
let r = localChanges(a, WS, ma, "A", tick());
ma = r.meta;
const sent = JSON.stringify(r.out);
assert.ok(!sent.includes("SECRET"), "no credential or environment value is sent");
assert.ok(!sent.includes("dev.example"), "an environment's values stay");
assert.ok(sent.includes("{{apiKey}}"), "a credential that is only a {{variable}} is sent");
assert.ok(sent.includes("application/json"), "an ordinary header is sent");
assert.ok(!sent.includes("Private one"), "only the shared workspace");
assert.deepEqual(r.out.map((x) => x.k).sort(), ["e:e1", "f:f1", "r:r1", "w"]);
// Nothing new: nothing to send.
assert.deepEqual(localChanges(a, WS, ma, "A", tick()).out, []);

// B: has nothing yet; takes A's records, and the workspace appears, shared with the team.
let b: Collections = emptyCollections();
let mb: Meta = {};
let ab = apply(b, WS, TEAM, mb, r.out);
b = ab.col; mb = ab.meta;
assert.equal(b.workspaces.find((w) => w.id === WS)?.name, "Backend");
assert.equal(b.workspaces.find((w) => w.id === WS)?.teamId, TEAM);
assert.deepEqual(b.folders.find((f) => f.id === "f1")?.children, ["r1"]);
assert.equal(b.requests.r1.url, "{{base}}/users/1");
assert.equal(b.requests.r1.auth.kind === "bearer" && b.requests.r1.auth.token, "");
assert.deepEqual(b.environments[0].vars.map((v) => [v.key, v.value]), [["base", ""], ["token", ""]]);
// B fills in its own values: not a change to send.
b = { ...b, environments: b.environments.map((e) => ({ ...e, vars: e.vars.map((v) => ({ ...v, value: `b-${v.key}` })) })),
  requests: { ...b.requests, r1: { ...b.requests.r1, auth: { kind: "bearer", token: "b-token" } } } };
assert.deepEqual(localChanges(b, WS, mb, "B", tick()).out, [], "a Deck's own secrets are not changes");
// And A's later edit to the request keeps B's own token.
a = { ...a, requests: { ...a.requests, r1: { ...a.requests.r1, name: "Get a user" } } };
r = localChanges(a, WS, ma, "A", tick()); ma = r.meta;
ab = apply(b, WS, TEAM, mb, r.out); b = ab.col; mb = ab.meta;
assert.equal(b.requests.r1.name, "Get a user");
assert.equal(b.requests.r1.auth.kind === "bearer" && b.requests.r1.auth.token, "b-token", "B's own token stays");
assert.equal(b.environments[0].vars[0].value, "b-base", "B's own values stay");

// Edits made apart: A renames r1, B adds r2 to the same folder. Both end with both.
a = { ...a, requests: { ...a.requests, r1: { ...a.requests.r1, name: "Fetch user" } } };
const ra = localChanges(a, WS, ma, "A", tick()); ma = ra.meta;
b = { ...b, requests: { ...b.requests, r2: { ...newRequest("Create user"), id: "r2", method: "POST" } },
  folders: b.folders.map((f) => (f.id === "f1" ? { ...f, children: [...f.children, "r2"] } : f)) };
const rb = localChanges(b, WS, mb, "B", tick() - 5); mb = rb.meta;
let x = apply(a, WS, TEAM, ma, rb.out); a = x.col; ma = x.meta;
x = apply(b, WS, TEAM, mb, ra.out); b = x.col; mb = x.meta;
// The folder record went both ways: whichever won, neither request is lost.
for (const c of [a, b]) {
  assert.deepEqual([...c.folders.find((f) => f.id === "f1")!.children].sort(), ["r1", "r2"]);
  assert.equal(c.requests.r1.name, "Fetch user");
  assert.equal(c.requests.r2.method, "POST");
}

/** Swap everything both ways until neither has anything for the other, as two connected Decks do. */
function sync(): void {
  for (let i = 0; i < 4; i++) {
    const la = localChanges(a, WS, ma, "A", tick()); ma = la.meta;
    const lb = localChanges(b, WS, mb, "B", tick()); mb = lb.meta;
    const toB: Rec[] = recsFor(a, WS, ma, newerThan(ma, digest(mb)));
    const toA: Rec[] = recsFor(b, WS, mb, newerThan(mb, digest(ma)));
    if (!toA.length && !toB.length) return;
    let y = apply(a, WS, TEAM, ma, toA); a = y.col; ma = y.meta;
    y = apply(b, WS, TEAM, mb, toB); b = y.col; mb = y.meta;
  }
}
sync();
const same = () => assert.deepEqual(JSON.stringify([...records(a, WS)].sort()), JSON.stringify([...records(b, WS)].sort()));
same();
assert.equal(behind(ma, digest(mb)), false);
assert.equal(behind(mb, digest(ma)), false);

// A delete: A removes r1; B takes it, and B's older copy does not bring it back.
const oldR1 = recsFor(b, WS, mb, ["r:r1"]);
a = { ...a, requests: Object.fromEntries(Object.entries(a.requests).filter(([k]) => k !== "r1")),
  folders: a.folders.map((f) => (f.id === "f1" ? { ...f, children: f.children.filter((c) => c !== "r1") } : f)) };
sync();
assert.equal(b.requests.r1, undefined, "the delete reached B");
assert.ok(!b.folders.find((f) => f.id === "f1")!.children.includes("r1"));
x = apply(a, WS, TEAM, ma, oldR1);
assert.equal(x.changed, false, "an older copy of a deleted request is not taken back");
same();

// A deleted folder takes its requests with it, on the other Deck too.
a = { ...a, folders: a.folders.filter((f) => f.id !== "f1") };
sync();
assert.equal(b.folders.find((f) => f.id === "f1"), undefined);
assert.equal(b.requests.r2, undefined, "its request went with it");
assert.ok(b.workspaces.some((w) => w.id === WS), "the workspace stays");
same();

// The private workspace was never touched or sent.
assert.ok(a.requests.rp && !b.requests.rp);
console.log("teamsync: all checks passed");
