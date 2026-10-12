// plugins/requests/src/mcpstore.ts
var deck;
var readJson = (name, fallback) => deck.readJson(name, fallback);
var writeJson = (name, data) => deck.writeJson(name, data);
var FILE = "requests-collections";
var SETTINGS = "settings";
function read() {
  const c = readJson(FILE, {});
  return {
    workspaces: c.workspaces ?? [],
    activeWorkspaceId: c.activeWorkspaceId ?? null,
    folders: c.folders ?? [],
    requests: c.requests ?? {},
    environments: c.environments ?? []
  };
}
function write(c) {
  writeJson(FILE, c);
}
function revealAllowed() {
  return readJson(SETTINGS, {}).httpMcpRevealSecrets === true;
}
var mask = (v) => v ? "\u2022\u2022\u2022\u2022" : "";
var rid = () => `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
var newRequestId = rid;
function newRequest(name = "New Request") {
  return {
    id: rid(),
    name,
    method: "GET",
    url: "",
    params: [],
    pathParams: [],
    headers: [],
    bodyKind: "none",
    body: "",
    formRows: [],
    auth: { kind: "none" }
  };
}
var parentOf = (folders, id) => folders.find((f) => f.children.includes(id)) ?? null;
function isInside(folders, id, ancestorId) {
  let cur = id;
  while (cur) {
    if (cur === ancestorId) return true;
    cur = folders.find((f) => f.id === cur)?.parentId ?? null;
  }
  return false;
}
function subtree(c, id) {
  const out = [id];
  const f = c.folders.find((x) => x.id === id);
  if (f) for (const child of f.children) out.push(...subtree(c, child));
  return out;
}
var makeKeyVal = (z) => z.object({
  on: z.boolean().default(true),
  key: z.string(),
  value: z.string().default("")
});
var makeFormRow = (z) => z.object({
  on: z.boolean().default(true),
  key: z.string(),
  value: z.string().default("").describe('For kind "file", the path to upload. Otherwise the text value.'),
  kind: z.enum(["text", "file"]).optional().describe(
    'Defaults to "text". "file" reads `value` as a local path and uploads it as a real multipart file part; one file row makes the entire body multipart/form-data.'
  ),
  filename: z.string().optional().describe("File rows only. The name sent to the server. Defaults to the file's own name."),
  contentType: z.string().optional().describe("File rows only. Defaults to a type guessed from the file extension.")
}).strict();
var keyVal;
var formRow;
function init(d) {
  deck = d;
  keyVal = makeKeyVal(d.z);
  formRow = makeFormRow(d.z);
}
var METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

// plugins/requests/src/mcp.ts
var ok = (text) => ({ content: [{ type: "text", text }] });
var json = (v) => ok(JSON.stringify(v, null, 2));
function edit(fn) {
  const c = read();
  const out = fn(c);
  if (typeof out !== "string") return ok(`Error: ${out.error}`);
  write(c);
  return ok(out);
}
function pickWorkspace(c, id) {
  if (id) {
    const w = c.workspaces.find((x) => x.id === id || x.name === id);
    return w ?? null;
  }
  return c.workspaces.find((x) => x.id === c.activeWorkspaceId) ?? c.workspaces[0] ?? null;
}
function register(server, deck2) {
  init(deck2);
  const { z, deckApi, apiErr } = deck2;
  server.tool(
    "requests_list",
    "List the HTTP client's workspaces, collections, folders, requests and environments. Environment values are masked unless Deck's 'Reveal HTTP secrets to MCP' setting is on.",
    {
      workspace: z.string().optional().describe("workspace id or name; defaults to the active one"),
      includeRequests: z.boolean().default(true).describe("include each folder's requests")
    },
    async ({ workspace, includeRequests }) => {
      const c = read();
      if (c.workspaces.length === 0) return ok("No workspaces yet \u2014 the HTTP tab has never been opened.");
      const ws = pickWorkspace(c, workspace);
      if (!ws) return ok(`Error: no workspace matching '${workspace}'.`);
      const reveal = revealAllowed();
      const folders = c.folders.filter((f) => f.workspaceId === ws.id);
      const tree = (id) => {
        const f = folders.find((x) => x.id === id);
        if (!f) return null;
        return {
          id: f.id,
          name: f.name,
          children: f.children.map((childId) => {
            const sub = folders.find((x) => x.id === childId);
            if (sub) return tree(childId);
            const r = c.requests[childId];
            if (!r) return null;
            return includeRequests ? { id: r.id, name: r.name, method: r.method, url: r.url } : r.id;
          }).filter(Boolean)
        };
      };
      return json({
        workspaces: c.workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          active: w.id === c.activeWorkspaceId
        })),
        workspace: ws.name,
        collections: folders.filter((f) => f.parentId === null).map((f) => tree(f.id)),
        environments: c.environments.filter((e) => e.workspaceId === ws.id).map((e) => ({
          id: e.id,
          name: e.name,
          active: e.id === ws.activeEnvId,
          vars: e.vars.map((v) => ({ on: v.on, key: v.key, value: reveal ? v.value : mask(v.value) }))
        })),
        secretsRevealed: reveal
      });
    }
  );
  server.tool(
    "requests_send",
    "Send a saved request and return the response \u2014 status, headers, body, timing \u2014 plus the results of its pre/post scripts. Requires the Deck app to be running: the send happens inside it, so the scripts run in their sandbox and history and variables update as if the button had been pressed. The response body is NOT masked: sending is asking to see it. A binary body (an image, a PDF) is flagged with bodyBinary rather than returned \u2014 pass saveTo to write it to a file and get the path back instead.",
    {
      request: z.string().describe("request id or name, from requests_list"),
      saveTo: z.string().optional().describe(
        "absolute path to write the response body to instead of returning it \u2014 a directory (the filename comes from content-disposition, else the URL, else the content type) or a full file path. Works for any content type, so it also gets a large JSON response out of the reply. Never overwrites: a collision deduplicates and the path actually written comes back as savedTo. A truncated response is refused rather than saved partial."
      )
    },
    async ({ request, saveTo }) => {
      try {
        const r = await deckApi("/http/send", { method: "POST", body: JSON.stringify({ request, saveTo }) });
        if (!r.ok) return ok(`Error ${r.status}: ${await r.text()}`);
        return ok(await r.text());
      } catch (e) {
        return apiErr(e);
      }
    }
  );
  server.tool(
    "requests_get_request",
    "Read one saved request in full \u2014 headers, params, body, auth and its pre/post scripts. Auth credentials are masked unless Deck's 'Reveal HTTP secrets to MCP' setting is on.",
    { id: z.string().describe("request id, from requests_list") },
    async ({ id }) => {
      const c = read();
      const r = c.requests[id];
      if (!r) return ok(`Error: no request with id '${id}'.`);
      const reveal = revealAllowed();
      const auth = !reveal && r.auth.kind === "bearer" ? { ...r.auth, token: mask(r.auth.token) } : !reveal && r.auth.kind === "basic" ? { ...r.auth, pass: mask(r.auth.pass) } : r.auth;
      return json({ ...r, auth, folder: parentOf(c.folders, id)?.name ?? null });
    }
  );
  server.tool(
    "requests_add_workspace",
    "Create a workspace. It starts with one collection, since a workspace with no tree has nowhere to put a request.",
    { name: z.string(), activate: z.boolean().default(false) },
    async ({ name, activate }) => edit((c) => {
      const id = newRequestId();
      c.workspaces.push({ id, name, activeEnvId: null });
      c.folders.push({ id: newRequestId(), name: "My Requests", workspaceId: id, parentId: null, children: [] });
      if (activate || c.workspaces.length === 1) c.activeWorkspaceId = id;
      return `Added workspace '${name}' (id ${id}).`;
    })
  );
  server.tool(
    "requests_delete_workspace",
    "Delete a workspace and everything in it \u2014 collections, folders, requests, environments.",
    { workspace: z.string().describe("workspace id or name") },
    async ({ workspace }) => edit((c) => {
      const ws = c.workspaces.find((x) => x.id === workspace || x.name === workspace);
      if (!ws) return { error: `no workspace matching '${workspace}'.` };
      if (c.workspaces.length === 1) return { error: "cannot delete the last workspace." };
      const gone = new Set(c.folders.filter((f) => f.workspaceId === ws.id).map((f) => f.id));
      for (const f of c.folders) {
        if (f.workspaceId !== ws.id) continue;
        for (const child of f.children) if (!gone.has(child)) delete c.requests[child];
      }
      c.folders = c.folders.filter((f) => f.workspaceId !== ws.id);
      c.environments = c.environments.filter((e) => e.workspaceId !== ws.id);
      c.workspaces = c.workspaces.filter((w) => w.id !== ws.id);
      if (c.activeWorkspaceId === ws.id) c.activeWorkspaceId = c.workspaces[0]?.id ?? null;
      return `Deleted workspace '${ws.name}'.`;
    })
  );
  server.tool(
    "requests_set_active_workspace",
    "Switch which workspace the HTTP tab shows.",
    { workspace: z.string().describe("workspace id or name") },
    async ({ workspace }) => edit((c) => {
      const ws = c.workspaces.find((x) => x.id === workspace || x.name === workspace);
      if (!ws) return { error: `no workspace matching '${workspace}'.` };
      c.activeWorkspaceId = ws.id;
      return `Active workspace is now '${ws.name}'.`;
    })
  );
  server.tool(
    "requests_add_folder",
    "Create a collection (no parent) or a folder inside one.",
    {
      name: z.string(),
      parent: z.string().optional().describe("parent folder id; omit to create a top-level collection"),
      workspace: z.string().optional().describe("workspace id or name; defaults to the active one")
    },
    async ({ name, parent, workspace }) => edit((c) => {
      const ws = pickWorkspace(c, workspace);
      if (!ws) return { error: "no workspace to add to \u2014 create one first." };
      let parentId = null;
      if (parent) {
        const p = c.folders.find((f2) => f2.id === parent || f2.name === parent);
        if (!p) return { error: `no folder matching '${parent}'.` };
        parentId = p.id;
      }
      const f = { id: newRequestId(), name, workspaceId: ws.id, parentId, children: [] };
      c.folders.push(f);
      if (parentId) c.folders.find((x) => x.id === parentId).children.push(f.id);
      return `Added ${parentId ? "folder" : "collection"} '${name}' (id ${f.id}).`;
    })
  );
  server.tool(
    "requests_delete_folder",
    "Delete a folder or collection and everything inside it.",
    { id: z.string() },
    async ({ id }) => edit((c) => {
      const f = c.folders.find((x) => x.id === id);
      if (!f) return { error: `no folder with id '${id}'.` };
      const ids = new Set(subtree(c, id));
      for (const i of ids) delete c.requests[i];
      c.folders = c.folders.filter((x) => !ids.has(x.id)).map((x) => ({ ...x, children: x.children.filter((ch) => !ids.has(ch)) }));
      return `Deleted '${f.name}' and ${ids.size - 1} item(s) inside it.`;
    })
  );
  server.tool(
    "requests_rename",
    "Rename a folder, collection, request, workspace or environment.",
    { id: z.string(), name: z.string() },
    async ({ id, name }) => edit((c) => {
      const f = c.folders.find((x) => x.id === id);
      if (f) {
        f.name = name;
        return `Renamed folder to '${name}'.`;
      }
      if (c.requests[id]) {
        c.requests[id].name = name;
        return `Renamed request to '${name}'.`;
      }
      const w = c.workspaces.find((x) => x.id === id);
      if (w) {
        w.name = name;
        return `Renamed workspace to '${name}'.`;
      }
      const e = c.environments.find((x) => x.id === id);
      if (e) {
        e.name = name;
        return `Renamed environment to '${name}'.`;
      }
      return { error: `nothing with id '${id}'.` };
    })
  );
  server.tool(
    "requests_move",
    "Move a folder or request into another folder.",
    { id: z.string(), toFolder: z.string() },
    async ({ id, toFolder }) => edit((c) => {
      const dest = c.folders.find((x) => x.id === toFolder || x.name === toFolder);
      if (!dest) return { error: `no folder matching '${toFolder}'.` };
      if (id === dest.id) return { error: "cannot move something into itself." };
      if (c.folders.some((f) => f.id === id) && isInside(c.folders, dest.id, id)) {
        return { error: "cannot move a folder into its own descendant." };
      }
      for (const f of c.folders) f.children = f.children.filter((ch) => ch !== id);
      dest.children.push(id);
      const moved = c.folders.find((f) => f.id === id);
      if (moved) {
        moved.parentId = dest.id;
        moved.workspaceId = dest.workspaceId;
      }
      return `Moved into '${dest.name}'.`;
    })
  );
  server.tool(
    "requests_add_request",
    "Create a saved request in a folder.",
    {
      folder: z.string().describe("folder or collection id"),
      name: z.string(),
      method: z.enum(METHODS).default("GET"),
      url: z.string().default(""),
      headers: z.array(keyVal).default([]),
      params: z.array(keyVal).default([]),
      bodyKind: z.enum(["none", "json", "text", "form"]).default("none"),
      body: z.string().default(""),
      formRows: z.array(formRow).default([]).describe('Rows for bodyKind "form". A row with kind "file" uploads a local file.'),
      preScript: z.string().optional().describe("JavaScript run before sending. See requests_update_request."),
      postScript: z.string().optional().describe("JavaScript run on the response, where pm.test() lives.")
    },
    async ({ folder, name, method, url, headers, params, bodyKind, body, formRows, preScript, postScript }) => edit((c) => {
      const f = c.folders.find((x) => x.id === folder || x.name === folder);
      if (!f) return { error: `no folder matching '${folder}'.` };
      const r = newRequest(name);
      Object.assign(r, {
        method,
        url,
        bodyKind,
        body,
        headers,
        params,
        formRows,
        ...preScript !== void 0 && { preScript },
        ...postScript !== void 0 && { postScript }
      });
      c.requests[r.id] = r;
      f.children.push(r.id);
      return `Added ${method} '${name}' (id ${r.id}) to '${f.name}'.`;
    })
  );
  server.tool(
    "requests_update_request",
    "Change fields on a saved request. Only the fields given are touched. Arrays replace wholesale \u2014 read the request first if you mean to append.",
    {
      id: z.string(),
      name: z.string().optional(),
      method: z.enum(METHODS).optional(),
      url: z.string().optional(),
      headers: z.array(keyVal).optional(),
      params: z.array(keyVal).optional(),
      pathParams: z.array(keyVal).optional(),
      bodyKind: z.enum(["none", "json", "text", "form"]).optional(),
      body: z.string().optional(),
      formRows: z.array(formRow).optional().describe(
        'Rows for bodyKind "form". A row with kind "file" reads its value as a local path and uploads the file as a real multipart part, which switches the whole body to multipart/form-data. Unknown fields are rejected rather than ignored.'
      ),
      preScript: z.string().optional().describe(
        "JavaScript run before the request is sent. Sandboxed: no fetch, no require, 5s limit. Use pm.environment.get/set and pm.request. A throw aborts the send."
      ),
      postScript: z.string().optional().describe(
        "JavaScript run on the response. Same sandbox. Adds pm.response (code, status, json(), text(), headers.get(), responseTime) and pm.test(name, fn) with pm.expect assertions."
      ),
      auth: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("none") }),
        z.object({ kind: z.literal("bearer"), token: z.string() }),
        z.object({ kind: z.literal("basic"), user: z.string(), pass: z.string() })
      ]).optional()
    },
    async ({ id, ...patch }) => edit((c) => {
      const r = c.requests[id];
      if (!r) return { error: `no request with id '${id}'.` };
      for (const [k, v] of Object.entries(patch)) {
        if (v !== void 0) r[k] = v;
      }
      return `Updated '${r.name}'.`;
    })
  );
  server.tool(
    "requests_delete_request",
    "Delete a saved request.",
    { id: z.string() },
    async ({ id }) => edit((c) => {
      const r = c.requests[id];
      if (!r) return { error: `no request with id '${id}'.` };
      delete c.requests[id];
      for (const f of c.folders) f.children = f.children.filter((ch) => ch !== id);
      return `Deleted request '${r.name}'.`;
    })
  );
  server.tool(
    "requests_duplicate_request",
    "Copy a saved request, next to the original.",
    { id: z.string(), name: z.string().optional() },
    async ({ id, name }) => edit((c) => {
      const src = c.requests[id];
      if (!src) return { error: `no request with id '${id}'.` };
      const parent = parentOf(c.folders, id);
      if (!parent) return { error: "the request is not in a folder." };
      const copy = { ...src, id: newRequestId(), name: name ?? `${src.name} copy` };
      c.requests[copy.id] = copy;
      parent.children.splice(parent.children.indexOf(id) + 1, 0, copy.id);
      return `Copied to '${copy.name}' (id ${copy.id}).`;
    })
  );
  server.tool(
    "requests_add_environment",
    "Create an environment in a workspace. Variables are what {{name}} resolves against.",
    {
      name: z.string(),
      vars: z.array(keyVal).default([]),
      workspace: z.string().optional().describe("workspace id or name; defaults to the active one"),
      activate: z.boolean().default(false)
    },
    async ({ name, vars, workspace, activate }) => edit((c) => {
      const ws = pickWorkspace(c, workspace);
      if (!ws) return { error: "no workspace to add to \u2014 create one first." };
      const id = newRequestId();
      c.environments.push({ id, name, vars, workspaceId: ws.id });
      if (activate) ws.activeEnvId = id;
      return `Added environment '${name}' (id ${id})${activate ? ", now active" : ""}.`;
    })
  );
  server.tool(
    "requests_set_variables",
    "Set or remove variables in an environment. Named keys are updated or added; keys given with a null value are removed. Other variables are left alone.",
    {
      environment: z.string().describe("environment id or name"),
      vars: z.record(z.string(), z.string().nullable()).describe('{ "host": "api.example.com", "oldKey": null }')
    },
    async ({ environment, vars }) => edit((c) => {
      const e = c.environments.find((x) => x.id === environment || x.name === environment);
      if (!e) return { error: `no environment matching '${environment}'.` };
      const changes = [];
      for (const [key, value] of Object.entries(vars)) {
        const i = e.vars.findIndex((v) => v.key === key);
        if (value === null) {
          if (i >= 0) {
            e.vars.splice(i, 1);
            changes.push(`-${key}`);
          }
        } else if (i >= 0) {
          e.vars[i] = { ...e.vars[i], value };
          changes.push(`~${key}`);
        } else {
          e.vars.push({ on: true, key, value });
          changes.push(`+${key}`);
        }
      }
      return `Updated '${e.name}': ${changes.join(" ") || "no change"}.`;
    })
  );
  server.tool(
    "requests_set_active_environment",
    "Choose which environment {{name}} resolves against, or clear it.",
    {
      environment: z.string().nullable().describe("environment id or name, or null for none"),
      workspace: z.string().optional()
    },
    async ({ environment, workspace }) => edit((c) => {
      const ws = pickWorkspace(c, workspace);
      if (!ws) return { error: "no workspace." };
      if (environment === null) {
        ws.activeEnvId = null;
        return "Cleared the active environment.";
      }
      const e = c.environments.find((x) => (x.id === environment || x.name === environment) && x.workspaceId === ws.id);
      if (!e) return { error: `no environment matching '${environment}' in '${ws.name}'.` };
      ws.activeEnvId = e.id;
      return `'${e.name}' is now the active environment.`;
    })
  );
  server.tool(
    "requests_delete_environment",
    "Delete an environment.",
    { environment: z.string().describe("environment id or name") },
    async ({ environment }) => edit((c) => {
      const e = c.environments.find((x) => x.id === environment || x.name === environment);
      if (!e) return { error: `no environment matching '${environment}'.` };
      c.environments = c.environments.filter((x) => x.id !== e.id);
      for (const w of c.workspaces) if (w.activeEnvId === e.id) w.activeEnvId = null;
      return `Deleted environment '${e.name}'.`;
    })
  );
}
export {
  register
};
