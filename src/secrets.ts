// What counts as a secret in a request or an environment, for everything that sends or stores one
// somewhere other than this Deck: a team (teamsync.ts) and a workspace kept in a folder
// (folderlayout.ts). Both keep the same things back, so a folder in git and a team see the same.
//
// Kept back: environment values (each Deck keeps its own value for a variable, by name), and
// credentials (an auth token or password, the value of a header like Authorization, Cookie or
// X-Api-Key) unless they are only a {{variable}}, which says where the value comes from, not what
// it is.
import type { Environment, Request, Row } from "./httpclient";

const isRef = (v: string) => /^\s*\{\{[^}]+\}\}\s*$/.test(v);
/** A header whose value is a credential. */
export const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$|token|secret|password|apikey|api_key/i;
const keep = (v: string) => (isRef(v) ? v : "");

/** A request's credentials, kept on this Deck: by header name (lower case) for headers. */
export interface ReqSecrets { token?: string; pass?: string; headers?: Record<string, string> }

/** A request without its credentials, and the credentials (null when it has none). */
export function splitRequest(r: Request): { pub: Request; secret: ReqSecrets | null } {
  const secret: ReqSecrets = {};
  let auth = r.auth;
  if (auth.kind === "bearer") { if (keep(auth.token) !== auth.token) secret.token = auth.token; auth = { kind: "bearer", token: keep(auth.token) }; }
  if (auth.kind === "basic") { if (keep(auth.pass) !== auth.pass) secret.pass = auth.pass; auth = { kind: "basic", user: auth.user, pass: keep(auth.pass) }; }
  const headers = r.headers.map((h) => {
    if (!SECRET_HEADER.test(h.key) || keep(h.value) === h.value) return h;
    (secret.headers ??= {})[h.key.toLowerCase()] = h.value;
    return { ...h, value: "" };
  });
  return { pub: { ...r, auth, headers }, secret: Object.keys(secret).length ? secret : null };
}

/** A request with the credentials this Deck kept put back where the other copy has none. */
export function joinRequest(r: Request, s: ReqSecrets | null | undefined): Request {
  if (!s) return r;
  let auth = r.auth;
  if (auth.kind === "bearer" && !auth.token && s.token) auth = { ...auth, token: s.token };
  if (auth.kind === "basic" && !auth.pass && s.pass) auth = { ...auth, pass: s.pass };
  const headers = r.headers.map((h: Row) => {
    const v = s.headers?.[h.key.toLowerCase()];
    return !h.value && v !== undefined && SECRET_HEADER.test(h.key) ? { ...h, value: v } : h;
  });
  return { ...r, auth, headers };
}

export type EnvShape = { id: string; name: string; vars: { on: boolean; key: string }[] };
/** An environment's variables' names and switches, and their values by name. */
export function splitEnv(e: Environment): { pub: EnvShape; values: Record<string, string> } {
  return {
    pub: { id: e.id, name: e.name, vars: e.vars.map((v) => ({ on: v.on, key: v.key })) },
    values: Object.fromEntries(e.vars.filter((v) => v.value).map((v) => [v.key, v.value])),
  };
}
export const joinEnv = (e: EnvShape, workspaceId: string, values: Record<string, string> | undefined): Environment =>
  ({ id: e.id, name: e.name, workspaceId, vars: e.vars.map((v) => ({ on: v.on, key: v.key, value: values?.[v.key] ?? "" })) });
