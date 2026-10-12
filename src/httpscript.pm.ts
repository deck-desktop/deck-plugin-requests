/**
 * The `pm` object handed to a user's pre-request / post-response script, and the tiny assertion
 * library behind `pm.expect`.
 *
 * Pure and free of any worker or DOM dependency, so it can be exercised by httpscript.check.ts
 * directly. The worker is only the sandbox around this; nothing here reaches outside itself.
 *
 * Note on secrets: a script CAN read an environment variable holding an API token — that is the
 * whole point of pm.environment.get. What keeps that reasonable is the worker, which strips the
 * network globals so a script has no easy way to send the value anywhere; see its header for the
 * one path that cannot be closed without a CSP. Do not restore those globals here or there.
 */

export interface ScriptRequestView {
  name: string;
  method: string;
  url: string;
  headers: [string, string][];
  body: string | null;
}

export interface ScriptResponseView {
  code: number;
  status: string;
  headers: [string, string][];
  body: string;
  responseTime: number;
}

export interface ScriptContext {
  request: ScriptRequestView;
  response?: ScriptResponseView;
  env: Record<string, string>;
}

export interface TestResult { name: string; passed: boolean; error?: string }

export interface ScriptResult {
  /** Variables the script set or cleared. null means unset. Applied by the caller. */
  env: Record<string, string | null>;
  tests: TestResult[];
  logs: string[];
  /** A throw outside of a pm.test() — the script itself failed. */
  error?: string;
}

const show = (v: unknown) => {
  if (typeof v === "string") return JSON.stringify(v);
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
};

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};

/**
 * The subset of chai that Postman scripts actually use. Written out rather than pulling chai in:
 * seven matchers is less code than the dependency, and the failure messages can name Deck's own
 * concepts.
 */
export interface Expectation {
  /** chai's chain words. No-ops that return the same object, so `to.have.property` reads
   *  naturally without any of them meaning anything. */
  to: Expectation;
  be: Expectation;
  have: Expectation;
  that: Expectation;
  /** Inverts every matcher after it: `pm.expect(x).to.not.equal("")`. */
  not: Expectation;
  equal(v: unknown): void;
  eql(v: unknown): void;
  above(n: number): void;
  below(n: number): void;
  ok(): void;
  a(t: string): void;
  include(v: unknown): void;
  property(name: string, value?: unknown): Expectation;
  length(n: number): void;
  /** pm.expect(res).to.have.status(200) — the single most-pasted Postman assertion. */
  status(n: number): void;
}

export function expect(actual: unknown, negated = false): Expectation {
  // Negation inverts the outcome and the message together, so `.to.not.equal("")` reports
  // "expected … NOT to equal …" rather than a passing assertion's wording.
  const fail = (msg: string): never => { throw new Error(negated ? msg.replace(" to ", " not to ") : msg); };
  const check = (okWhenPlain: boolean, msg: string) => { if (okWhenPlain === negated) fail(msg); };
  const api: Expectation = {
    to: null as unknown as Expectation,
    be: null as unknown as Expectation,
    have: null as unknown as Expectation,
    that: null as unknown as Expectation,
    not: null as unknown as Expectation,
    equal: (v: unknown) => check(actual === v, `expected ${show(actual)} to equal ${show(v)}`),
    eql: (v: unknown) => check(deepEqual(actual, v), `expected ${show(actual)} to deeply equal ${show(v)}`),
    above: (n: number) => check(Number(actual) > n, `expected ${show(actual)} to be above ${n}`),
    below: (n: number) => check(Number(actual) < n, `expected ${show(actual)} to be below ${n}`),
    ok: () => check(Boolean(actual), `expected ${show(actual)} to be truthy`),
    a: (t: string) => check(typeof actual === t, `expected ${show(actual)} to be a ${t}`),
    include: (v: unknown) => check(
      Array.isArray(actual) ? actual.some((x) => deepEqual(x, v))
        : typeof actual === "string" ? actual.includes(String(v))
        : false,
      `expected ${show(actual)} to include ${show(v)}`,
    ),
    property: (name: string, value?: unknown) => {
      const obj = actual as Record<string, unknown> | null;
      check(Boolean(obj) && name in obj!, `expected ${show(actual)} to have property ${show(name)}`);
      if (value !== undefined) {
        check(deepEqual(obj?.[name], value), `expected property ${show(name)} to equal ${show(value)}`);
      }
      // Returning a new chain lets `.to.have.property("a").that.equals(1)` keep reading. The
      // negation does not carry over: `.not.have.property("a").equal(1)` would read as nonsense.
      return expect(obj?.[name]);
    },
    length: (n: number) => check(
      (actual as { length?: number } | null)?.length === n,
      `expected length ${show((actual as { length?: number } | null)?.length)} to equal ${n}`,
    ),
    status: (n: number) => check(
      (actual as { code?: number } | null)?.code === n,
      `expected status ${n} but got ${show((actual as { code?: number } | null)?.code)}`,
    ),
  };
  api.to = api.be = api.have = api.that = api;
  // .not builds the inverted chain once, lazily — building it eagerly would recurse forever.
  Object.defineProperty(api, "not", { get: () => expect(actual, !negated) });
  return api;
}

/** Build the `pm` object for one script run. Mutations are recorded, never applied here. */
export function buildPm(ctx: ScriptContext) {
  const env = { ...ctx.env };
  const mutations: Record<string, string | null> = {};
  const tests: TestResult[] = [];

  const environment = {
    get: (k: string) => (Object.prototype.hasOwnProperty.call(env, k) ? env[k] : undefined),
    set: (k: string, v: unknown) => { const s = String(v); env[k] = s; mutations[k] = s; },
    unset: (k: string) => { delete env[k]; mutations[k] = null; },
    has: (k: string) => Object.prototype.hasOwnProperty.call(env, k),
    toObject: () => ({ ...env }),
  };

  const response = ctx.response && {
    code: ctx.response.code,
    status: ctx.response.status,
    responseTime: ctx.response.responseTime,
    headers: {
      get: (name: string) =>
        ctx.response!.headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1],
      all: () => ctx.response!.headers.map(([key, value]) => ({ key, value })),
    },
    text: () => ctx.response!.body,
    json: () => JSON.parse(ctx.response!.body),
    // So `pm.response.to.have.status(200)` works as well as `pm.expect(pm.response)...`.
    get to() { return expect({ code: ctx.response!.code }).to; },
  };

  const pm = {
    environment,
    // Postman aliases; both point at the same store since Deck has one variable scope.
    variables: environment,
    request: ctx.request,
    response,
    expect,
    test: (name: string, fn: () => void) => {
      try { fn(); tests.push({ name, passed: true }); }
      catch (e) { tests.push({ name, passed: false, error: e instanceof Error ? e.message : String(e) }); }
    },
  };

  return { pm, mutations, tests };
}

/** Run a script against a context, capturing everything it did. Never throws. */
export function runPm(script: string, ctx: ScriptContext): ScriptResult {
  const { pm, mutations, tests } = buildPm(ctx);
  const logs: string[] = [];
  const log = (...args: unknown[]) => logs.push(args.map((a) => (typeof a === "string" ? a : show(a))).join(" "));
  const console = { log, info: log, warn: log, error: log, debug: log };
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("pm", "console", `"use strict";\n${script}`)(pm, console);
  } catch (e) {
    return { env: mutations, tests, logs, error: e instanceof Error ? `${e.message}` : String(e) };
  }
  return { env: mutations, tests, logs };
}
