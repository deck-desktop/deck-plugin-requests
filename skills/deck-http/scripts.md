# Request scripts — the `pm` API

A saved request can carry two pieces of JavaScript:

- **`preScript`** runs just before the request is sent. Its job is to compute something the
  request needs — a timestamp, a nonce, a signature.
- **`postScript`** runs when the response arrives. Its job is to assert things about the response
  and to save values out of it for later requests.

Both are plain fields on a request, so they are written with `requests_add_request` or
`requests_update_request`, and read back by `requests_get_request`.

## The sandbox

Scripts run in a Web Worker with `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
`caches`, `WebTransport` and `importScripts` removed, and a five-second time limit. There is no
`require`, and no access to Deck itself — no Tauri commands, no filesystem, no backend token.

**Write scripts as if there is no network**, because for every ordinary purpose there isn't. The
restriction is deliberate: collections are imported from files and from pasted curl, and they hold
API tokens. A script that tries to fetch will throw, and the fix is never to ask for network
access to be restored.

Be precise about what that guarantees, though: `import()` is syntax rather than a global, so it
cannot be stripped the way the others were, and closing it would need a Content-Security-Policy
that Deck does not run. So the sandbox stops casual exfiltration, not a deliberate attempt. **A
script inside a collection someone else wrote is code you are choosing to run — read it first.**

To refresh a token, do what Postman does: give the *login request* a `postScript` that calls
`pm.environment.set("token", …)`, then use `{{token}}` in the other requests.

Everything a script deliberately outputs — variable writes, test results, `console.log` lines —
appears in Deck's own UI under the response's **Tests** tab.

## What a script can do

### Variables

```js
pm.environment.get("base")            // read from the active environment
pm.environment.set("token", value)    // write; saved back after the script runs
pm.environment.unset("token")         // remove
pm.environment.has("token")           // boolean
pm.environment.toObject()             // every variable as an object
pm.variables                          // an alias — Deck has one variable scope
```

Values are coerced to strings on the way in, matching how environment variables are stored.

Writes land in the **active environment of the active workspace**. If no environment is active
there is nowhere to put them: the writes are dropped and the Tests tab says so. A script that sets
variables therefore needs an active environment — check with `requests_list` before writing one.

### The request (both scripts)

```js
pm.request.method     // "GET", "POST", …
pm.request.url        // the URL being sent, {{variables}} already substituted
pm.request.headers    // [name, value] pairs, including the one auth adds
pm.request.body       // string, or null
```

Read-only. A pre-request script changes the request by setting the variables the request's URL,
headers and body already reference — it does not mutate `pm.request` itself.

### The response (post-response only)

```js
pm.response.code                              // number
pm.response.status                            // "OK", "Not Found"
pm.response.json()                            // parsed body; throws if not JSON
pm.response.text()                            // raw body
pm.response.headers.get("content-type")       // case-insensitive
pm.response.responseTime                      // ms
```

### Tests

```js
pm.test("name", () => { … })          // a throw inside marks it failed; later tests still run
pm.response.to.have.status(200)
pm.expect(x).to.equal(y)              // strict; .eql(y) compares deeply
pm.expect(x).to.include(y)            // substring, or array membership
pm.expect(x).to.have.property("id")   // a second argument checks the value
pm.expect(x).to.be.above(n)           // also .below(n), .ok(), .a("string"), .length(n)
```

`to`, `be`, `have` and `that` are chain words that mean nothing — write whichever reads best.

### Output

```js
console.log(…)                        // shown under the response's Tests tab
```

## Failure behaviour

- A throw **inside** `pm.test` fails that test. The rest of the script keeps running.
- A throw **outside** any test fails the script. In a *pre-request* script that **aborts the
  send** — usually the right thing, since it means a token could not be built. In a
  *post-response* script the response is still shown; only the tests are marked failed.
- A script that never returns is killed at five seconds and reported as a timeout.

## Recipes

**Log in once, then use the token everywhere**

```
requests_add_request  folder: "Auth", name: "Login", method: "POST",
                       url: "https://{{host}}/login", bodyKind: "json",
                       body: "{\"user\":\"{{user}}\",\"pass\":\"{{pass}}\"}",
                       postScript: "const d = pm.response.json();\npm.environment.set(\"token\", d.access_token);"
```

Then every other request uses `{{token}}` — as a bearer token, or in a header.

**Assert a response**

```
requests_update_request  id: <id>, postScript: |
  pm.test("status is 200", () => pm.response.to.have.status(200));
  pm.test("returns a list", () => {
    const body = pm.response.json();
    pm.expect(body).to.be.a("object");
    pm.expect(body).to.have.property("id");
  });
```

**Stamp each request with a fresh value**

```
requests_update_request  id: <id>, preScript: 'pm.environment.set("now", new Date().toISOString());'
```

Then put `{{now}}` in the header or body that needs it.

**Remove a script**

Send an empty string — `preScript: ""`. A blank script is skipped entirely.

## Notes

- `{{$guid}}` and `{{$timestamp}}` are generated per send and are not environment variables. If a
  script needs the same value the request sees, compute it in the script and set a variable.
- Scripts travel with an exported collection, and an import keeps them. Read the scripts in a
  collection someone else sent before sending its requests — see the sandbox note above for why
  that is a real step and not a formality.
- Only requests have scripts. There is no folder- or collection-level script, and no collection
  runner.
