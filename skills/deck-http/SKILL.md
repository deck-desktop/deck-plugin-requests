---
name: deck-http
description: >
  Manage Deck's Requests plugin (its Postman-style HTTP client, formerly the HTTP tab) through
  the Deck MCP tools — create and
  edit saved requests, folders, collections, workspaces and environments, and choose which
  environment {{name}} resolves against, and write pre-request / post-response scripts. TRIGGER
  when asked to add/change/list an API request, a collection, or an environment variable in Deck,
  to set up a set of API calls, or to add a test or token-refresh script to a request.
---

# Deck Requests (HTTP client)

CRUD over the Requests plugin's stored data through `requests_*` MCP tools, which exist only
while the plugin is installed. No IPC: the tools edit
`%APPDATA%\Deck\requests-collections.json` and Deck's file watcher applies the change live, so the
app updates while it is open.

## The model

```
Workspace          switchable; each has its own collections AND environments
└── Collection     a top-level folder (parentId: null)
    ├── Folder     nests arbitrarily deep
    └── Request    method, url, params, headers, body, auth, pre/post scripts
Environment        per workspace; supplies {{name}} values; one is "active"
```

Every id is opaque. Get them from `requests_list` — most tools also accept a **name** where an
id is expected, which is what to use when the user says "the Staging environment".

## Tools

| Tool | Use |
|---|---|
| `requests_list` | The whole tree for a workspace, plus environments. Start here. |
| `requests_get_request` | One request in full — headers, params, body, auth, scripts. |
| `requests_send` | **Send** a saved request and get the response back — status, headers, body, timing, and its script tests. `saveTo` writes the body to a file instead. Needs Deck running. |
| `requests_add_request` / `requests_update_request` / `requests_delete_request` / `requests_duplicate_request` | Requests. |
| `requests_add_folder` / `requests_delete_folder` | Collections (no `parent`) and folders (with one). |
| `requests_rename` / `requests_move` | Work on any node — folder, request, workspace, environment. |
| `requests_add_workspace` / `requests_delete_workspace` / `requests_set_active_workspace` | Workspaces. |
| `requests_add_environment` / `requests_delete_environment` / `requests_set_variables` / `requests_set_active_environment` | Environments. |

## Secrets

Environment values and auth credentials come back **masked** (`••••`) unless Hasan has turned on
*Settings → Storage → MCP server → Reveal HTTP secrets to MCP*. Writing them always works.

So: you can set a token you cannot read back. If you need to check whether a variable is set,
`requests_list` still shows the key — just not its value. Don't ask for the setting to be turned
on unless reading a value is genuinely required; prefer writing a new value.

## Working rules

- **List before you edit.** Ids are not guessable and names can be ambiguous across workspaces.
- **Arrays replace wholesale.** `headers`, `params` and `formRows` in `requests_update_request`
  overwrite what is there. To add one header, read the request first and send the full list back.
- **`requests_set_variables` is the exception** — it merges. Named keys are set, keys passed as
  `null` are removed, everything else is untouched.
- **Uploading a file** is a form row with `kind: "file"` whose `value` is a local path, alongside
  `bodyKind: "form"`. One such row turns the whole body into `multipart/form-data`: Deck streams
  the file from disk as a real file part, named after the file with its type guessed from the
  extension. `filename` and `contentType` override those.

  ```json
  "bodyKind": "form",
  "formRows": [
    { "on": true, "key": "file", "kind": "file", "value": "C:\\tmp\\clip.mp3" },
    { "on": true, "key": "language", "value": "en" }
  ]
  ```

  `{{vars}}` are substituted in the path. A missing or unreadable file fails the send naming the
  field and the path, rather than going out as text for the server to reject. Form rows also
  reject unknown fields, so a typo is an error instead of a silently dropped setting.
- **Prefer `{{name}}` over literals** for hosts and tokens. That is what environments are for, and
  it keeps a token out of the request body where it would be visible in the tree.
- **A new workspace starts with one collection** ("My Requests") because a workspace with no tree
  has nowhere to put a request. Don't create a second one unless asked.
- **Deleting a folder deletes everything under it.** Say what will go before doing it if the count
  is more than a couple.

## Scripts

A request can carry `preScript` (runs before the send) and `postScript` (runs on the response) —
ordinary fields on the request, so `requests_update_request` writes them and
`requests_get_request` reads them back.

```
requests_update_request  id: <id>,
  postScript: 'pm.test("ok", () => pm.response.to.have.status(200));'
```

Two things to know before writing one:

- **No network access.** Scripts run in a worker with `fetch` and friends removed, because
  collections are imported from files and hold tokens. To refresh a token, put
  `pm.environment.set("token", …)` in the *login request's* `postScript` and use `{{token}}`
  elsewhere. A five-second limit applies. The sandbox stops casual exfiltration but is not a
  security boundary against a script written to defeat it — `scripts.md` says why.
- **Variables are written to the active environment.** With none active the writes are dropped;
  check with `requests_list` first.

**Read `scripts.md` in this skill directory before writing a script** — it has the full `pm` API,
the failure semantics, and worked recipes.

## Recipes

**Set up a new API from scratch**

```
requests_add_workspace       name: "Acme API", activate: true
requests_add_environment     name: "Staging", activate: true,
                              vars: [{key: "host", value: "staging.acme.dev"}]
requests_add_request         folder: "My Requests", name: "List users",
                              method: "GET", url: "https://{{host}}/users"
```

**Add a header to an existing request**

```
requests_get_request         id: <id>              # read the current headers
requests_update_request      id: <id>, headers: [...existing, {on: true, key: "X-Trace", value: "1"}]
```

**Send a request and read the result**

```
requests_send  request: <id or name>
```

The send happens inside Deck, so the scripts run, history records it, and variables a script sets
are written — exactly as if the button had been pressed. The reply carries `status`, `headers`,
`body` (capped at 64 KB, `bodyTruncated` says so), `elapsedMs`, `tests`, `logs`, `envSet` and
`envSaved`. The body is not masked: asking to send is asking to see the response.

**Downloading a response**

```
requests_send  request: "Download media"  saveTo: "C:/Users/Hasan/Downloads"
```

`saveTo` writes the body to a file and returns `savedTo` — the path actually written — instead of
the body. Use it for anything binary (`bodyBinary: true` in a reply without it), and for a large
text response that would otherwise be cut at 64 KB. It takes a directory or a full file path, must
be absolute, and never overwrites: a name collision becomes `name (1).png`. A truncated response is
refused rather than saved as a corrupt partial file, with the reason in `saveError`.

Pair it with a script to check an API in one pass: `requests_update_request` with a `postScript`
of `pm.test(…)` assertions, then `requests_send`, then read `tests` from the reply.

**Point everything at production**

```
requests_set_active_environment  environment: "Production"
```

Nothing else changes — the requests already say `{{host}}`.

## Gotchas

- Tools address the **installed** Deck (`%APPDATA%\Deck`), not a dev build running from
  `target\debug` (which uses `Deck-Dev`). If Hasan is testing in the dev window, changes made here
  will not appear there.
- The Requests tab must have been opened at least once, or there are no workspaces and every add fails
  with "no workspace". `requests_add_workspace` fixes that.
- A request must live in a folder. There is no loose request at workspace level.
- `{{$guid}}`, `{{$timestamp}}` and friends are generated per send and are not environment
  variables — don't try to define them. A script cannot read them either; compute the value in
  the script and set a variable instead.
- Scripts belong to requests only — there is no folder-level script and no collection runner.
