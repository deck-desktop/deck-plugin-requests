// Runnable check for collection export/import:
//   npx tsx plugins/requests/src/httpexport.check.ts
//
// Two things must hold: an export re-imports without losing anything, and importing twice makes
// two collections rather than overwriting the first. Both fail silently if the id re-keying is
// wrong, which is why they are checked here rather than by clicking.
import assert from "node:assert";
import { newFolder, newId, newRequest, newWorkspace, type Collections } from "./httpclient";
import { exportCollection, exportWorkspace, importCollection, parseExport, exportFilename,
  summarizeImport } from "./httpexport";

function fixture(): Collections {
  const ws = newWorkspace("Work");
  const root = newFolder("API", ws.id);
  const sub = newFolder("Users", ws.id, root.id);
  const r1 = { ...newRequest(), id: newId(), name: "List", url: "https://{{host}}/users" };
  const r2 = { ...newRequest(), id: newId(), name: "Create", auth: { kind: "bearer" as const, token: "SECRET" } };

  root.children = [sub.id, r1.id];
  sub.children = [r2.id];

  return {
    workspaces: [ws],
    activeWorkspaceId: ws.id,
    folders: [root, sub],
    requests: { [r1.id]: r1, [r2.id]: r2 },
    environments: [{ id: newId(), name: "Prod", workspaceId: ws.id, vars: [{ on: true, key: "host", value: "api.dev" }] }],
  };
}

const col = fixture();
const rootId = col.folders[0].id;

// ---- export keeps the whole subtree ----
{
  const f = exportCollection(col, rootId, { includeSecrets: true });
  assert.strictEqual(f.folders.length, 2, "the collection and its folder");
  assert.strictEqual(Object.keys(f.requests).length, 2, "requests at both levels");
  assert.strictEqual(f.environments.length, 1, "the workspace's environments travel too");
  assert.strictEqual(f.secrets, true);
}

// ---- without secrets, the shape survives but the values do not ----
{
  const f = exportCollection(col, rootId, { includeSecrets: false });
  const bearer = Object.values(f.requests).find((r) => r.auth.kind === "bearer")!;
  assert.strictEqual(bearer.auth.kind, "bearer", "the auth KIND is kept — only the value goes");
  assert.strictEqual((bearer.auth as { token: string }).token, "", "token stripped");
  assert.strictEqual(f.environments[0].vars[0].key, "host", "variable names are not secrets");
  assert.strictEqual(f.environments[0].vars[0].value, "", "their values are");
  assert.strictEqual(f.secrets, false);
}

// ---- round trip ----
{
  const text = JSON.stringify(exportCollection(col, rootId, { includeSecrets: true }));
  const file = parseExport(text);
  const next = importCollection(col, file, col.workspaces[0].id, { withEnvironments: true });

  assert.strictEqual(next.folders.length, 4, "two original folders plus two imported");
  assert.strictEqual(Object.keys(next.requests).length, 4);

  // Every imported id must be new, or the import would have overwritten the original.
  const originals = new Set(col.folders.map((f) => f.id));
  const imported = next.folders.filter((f) => !originals.has(f.id));
  assert.strictEqual(imported.length, 2);
  for (const f of imported) assert.ok(!originals.has(f.id), "re-keyed");

  // The tree still hangs together: the imported root's children resolve.
  const importedRoot = imported.find((f) => f.parentId === null)!;
  assert.strictEqual(importedRoot.name, "API (2)", "a name clash is disambiguated, not merged");
  for (const c of importedRoot.children) {
    const ok = next.folders.some((f) => f.id === c) || !!next.requests[c];
    assert.ok(ok, `child ${c} resolves after re-keying`);
  }

  // The nested folder's parent points at the NEW root, not the old one.
  const importedSub = imported.find((f) => f.parentId !== null)!;
  assert.strictEqual(importedSub.parentId, importedRoot.id);
}

// ---- importing twice gives two collections ----
{
  const file = parseExport(JSON.stringify(exportCollection(col, rootId, { includeSecrets: true })));
  const ws = col.workspaces[0].id;
  const once = importCollection(col, file, ws, { withEnvironments: false });
  const twice = importCollection(once, file, ws, { withEnvironments: false });
  const names = twice.folders.filter((f) => f.parentId === null).map((f) => f.name).sort();
  assert.deepStrictEqual(names, ["API", "API (2)", "API (3)"]);
}

// ---- rejects what it should ----
assert.throws(() => parseExport("not json"), /Not a JSON file/);
assert.throws(() => parseExport('{"kind":"something-else"}'), /Not a Deck collection/);
assert.throws(() => parseExport(JSON.stringify({ kind: "deck.http.collection", version: 99 })), /newer version/);

// ---- filenames are safe to write ----
assert.match(exportFilename("My API / v2"), /^My-API-v2-\d{4}-\d{2}-\d{2}\.deck-http\.json$/);
assert.match(exportFilename("///"), /^collection-/, "a name with nothing usable still yields a file");

// ---- workspace export: every collection in one file ----
{
  const ws = col.workspaces[0].id;
  const f = exportWorkspace(col, ws, { includeSecrets: true });
  assert.strictEqual(f.folders.length, 2, "all of the workspace's folders");
  assert.strictEqual(Object.keys(f.requests).length, 2);

  // It imports through the same path as a collection export, since the format is the same.
  const back = importCollection(col, parseExport(JSON.stringify(f)), ws, { withEnvironments: false });
  assert.strictEqual(back.folders.length, 4);
  const roots = back.folders.filter((x) => x.parentId === null).map((x) => x.name).sort();
  assert.deepStrictEqual(roots, ["API", "API (2)"]);
}

// ---- import summary: what the confirmation dialog promises ----
// These exist so the dialog cannot disagree with what importCollection then does. A summary
// claiming nothing collides, in front of an import that quietly renames, is worse than no dialog.
{
  const ws = col.workspaces[0].id;
  const f = exportCollection(col, col.folders[0].id, { includeSecrets: true });
  const file = parseExport(JSON.stringify(f));

  // Into a workspace that already holds "API": the root collides, so it arrives renamed.
  const into = summarizeImport(col, file, ws);
  assert.strictEqual(into.collections, 1, "one root collection");
  assert.strictEqual(into.folders, 1, "one folder below the root (Users)");
  assert.strictEqual(into.requests, 2);
  assert.strictEqual(into.secrets, true);
  assert.deepStrictEqual(into.renamed, ["API"], "the colliding root is named");

  // The promise must match reality.
  const after = importCollection(col, file, ws, { withEnvironments: false });
  const names = after.folders.filter((x) => x.parentId === null).map((x) => x.name).sort();
  assert.deepStrictEqual(names, ["API", "API (2)"], "renamed exactly as the summary said");

  // A new workspace cannot collide, so nothing is reported as renamed.
  assert.deepStrictEqual(summarizeImport(col, file, null).renamed, []);

  // A secret-free export must say so — that is the half people actually care about.
  const scrubbed = parseExport(JSON.stringify(
    exportCollection(col, col.folders[0].id, { includeSecrets: false })));
  assert.strictEqual(summarizeImport(col, scrubbed, ws).secrets, false);
}

console.log("ok");
