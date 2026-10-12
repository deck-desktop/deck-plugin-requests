// Runnable check for the request-script sandbox's pm object:
//   npx tsx plugins/requests/src/httpscript.check.ts
//
// runPm is what actually executes user code, so a bug here either loses a variable a script set
// or turns a failed assertion into a crash that swallows the whole run.
import assert from "node:assert";
import { runPm, type ScriptContext } from "./httpscript.pm";

const ctx = (over: Partial<ScriptContext> = {}): ScriptContext => ({
  request: { name: "r", method: "GET", url: "https://x.dev/posts", headers: [["Accept", "application/json"]], body: null },
  env: { base: "https://x.dev", token: "abc" },
  ...over,
});

const withResponse = ctx({
  response: {
    code: 200,
    status: "OK",
    headers: [["Content-Type", "application/json"]],
    body: '{"id":1,"tags":["a","b"],"nested":{"k":2}}',
    responseTime: 42,
  },
});

// ---- variables ----

let r = runPm(`pm.environment.set("token", "new"); pm.environment.set("n", 5)`, ctx());
assert.strictEqual(r.error, undefined);
assert.deepStrictEqual(r.env, { token: "new", n: "5" }); // values coerce to strings

// A get sees the value a set just wrote, within the same script.
r = runPm(`pm.test("roundtrip", () => { pm.environment.set("a", "1"); pm.expect(pm.environment.get("a")).to.equal("1"); })`, ctx());
assert.deepStrictEqual(r.tests, [{ name: "roundtrip", passed: true }]);

// unset records a null so the caller knows to remove it, not to write "".
r = runPm(`pm.environment.unset("token")`, ctx());
assert.deepStrictEqual(r.env, { token: null });

// Reading an existing var, and `pm.variables` as an alias for the same store.
r = runPm(`pm.test("alias", () => pm.expect(pm.variables.get("base")).to.equal("https://x.dev"))`, ctx());
assert.strictEqual(r.tests[0].passed, true);

// ---- response ----

r = runPm(`pm.test("json", () => pm.expect(pm.response.json().id).to.equal(1))`, withResponse);
assert.strictEqual(r.tests[0].passed, true, r.tests[0].error);

r = runPm(`pm.test("header", () => pm.expect(pm.response.headers.get("content-type")).to.include("json"))`, withResponse);
assert.strictEqual(r.tests[0].passed, true, r.tests[0].error);

r = runPm(`pm.test("time", () => pm.expect(pm.response.responseTime).to.be.below(1000))`, withResponse);
assert.strictEqual(r.tests[0].passed, true, r.tests[0].error);

// The most-pasted Postman line, both spellings.
r = runPm(`pm.test("status", () => pm.response.to.have.status(200))`, withResponse);
assert.strictEqual(r.tests[0].passed, true, r.tests[0].error);
r = runPm(`pm.test("status", () => pm.expect(pm.response).to.have.status(201))`, withResponse);
assert.strictEqual(r.tests[0].passed, false);
assert.match(r.tests[0].error!, /expected status 201 but got 200/);

// ---- assertions ----

const cases: [string, boolean][] = [
  [`pm.expect(1).to.equal(1)`, true],
  [`pm.expect(1).to.equal(2)`, false],
  [`pm.expect({a:1}).to.eql({a:1})`, true],
  [`pm.expect({a:1}).to.eql({a:2})`, false],
  [`pm.expect([1,2]).to.include(2)`, true],
  [`pm.expect([1,2]).to.include(3)`, false],
  [`pm.expect("abc").to.include("b")`, true],
  [`pm.expect({a:1}).to.have.property("a")`, true],
  [`pm.expect({a:1}).to.have.property("b")`, false],
  [`pm.expect({a:1}).to.have.property("a", 1)`, true],
  [`pm.expect({a:1}).to.have.property("a", 2)`, false],
  [`pm.expect(5).to.be.above(3)`, true],
  [`pm.expect(5).to.be.above(9)`, false],
  [`pm.expect([1,2]).to.have.length(2)`, true],
  [`pm.expect("x").to.be.ok()`, true],
  [`pm.expect("x").to.be.a("string")`, true],
];
for (const [src, want] of cases) {
  const got = runPm(`pm.test("t", () => { ${src} })`, ctx()).tests[0];
  assert.strictEqual(got.passed, want, `${src} — expected ${want}, got ${got.passed} (${got.error ?? ""})`);
}

// ---- failures stay contained ----

// A throw inside a test is a failed test, not a dead script: the tests after it still run.
r = runPm(`pm.test("a", () => { throw new Error("boom") }); pm.test("b", () => {})`, ctx());
assert.deepStrictEqual(r.tests.map((t) => [t.name, t.passed]), [["a", false], ["b", true]]);
assert.strictEqual(r.tests[0].error, "boom");
assert.strictEqual(r.error, undefined);

// A throw outside a test is the script failing — reported, never rethrown at the caller.
r = runPm(`pm.environment.set("x", "1"); nope()`, ctx());
assert.match(r.error!, /nope/);
assert.deepStrictEqual(r.env, { x: "1" }); // work done before the throw is still returned

// A syntax error is reported the same way.
assert.ok(runPm(`function (`, ctx()).error);

// ---- logs ----

r = runPm(`console.log("hi", 1, {a:2})`, ctx());
assert.deepStrictEqual(r.logs, ['hi 1 {"a":2}']);

// ---- request is readable ----

r = runPm(`pm.test("req", () => pm.expect(pm.request.method).to.equal("GET"))`, ctx());
assert.strictEqual(r.tests[0].passed, true);

console.log("httpscript.pm: all checks pass");

// ---- negation ----
// pm.expect(x).to.not.equal("") is standard in Postman scripts; without it `.not` was undefined
// and the next matcher threw "Cannot read properties of undefined".
const neg: [string, boolean][] = [
  [`pm.expect("abc").to.not.equal("")`, true],
  [`pm.expect("").to.not.equal("")`, false],
  [`pm.expect(1).to.not.equal(2)`, true],
  [`pm.expect({a:1}).to.not.eql({a:2})`, true],
  [`pm.expect({a:1}).to.not.eql({a:1})`, false],
  [`pm.expect([1,2]).to.not.include(3)`, true],
  [`pm.expect([1,2]).to.not.include(2)`, false],
  [`pm.expect({a:1}).to.not.have.property("b")`, true],
  [`pm.expect({a:1}).to.not.have.property("a")`, false],
  [`pm.expect(5).to.not.be.above(9)`, true],
  [`pm.expect(5).to.not.be.above(3)`, false],
  [`pm.expect(0).to.not.be.ok()`, true],
  [`pm.expect(1).to.not.be.ok()`, false],
  [`pm.expect(pm.response).to.not.have.status(404)`, true],
  [`pm.expect(pm.response).to.not.have.status(200)`, false],
  // A doubled negation is still a plain assertion.
  [`pm.expect(1).to.not.not.equal(1)`, true],
];
for (const [src, want] of neg) {
  const got = runPm(`pm.test("t", () => { ${src} })`, withResponse).tests[0];
  assert.strictEqual(got.passed, want, `${src} — expected ${want}, got ${got.passed} (${got.error ?? ""})`);
}

// The failure message says "not to", so a reader can tell which direction failed.
const negMsg = runPm(`pm.test("t", () => pm.expect("a").to.not.equal("a"))`, ctx()).tests[0];
assert.match(negMsg.error!, /not to equal/);

// The real script from Hasan's screenshot: this threw before .not existed.
const real = runPm(
  `pm.environment.set("token", "abc");
   pm.test("200 OK", () => pm.expect(pm.response.code).to.equal(200));
   pm.test("token saved", () => pm.expect(pm.environment.get("token")).to.not.equal(""));`,
  withResponse,
);
assert.deepStrictEqual(real.tests.map((t) => t.passed), [true, true], JSON.stringify(real.tests));

console.log("httpscript.pm: negation checks pass");
