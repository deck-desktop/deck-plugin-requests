// The script sandbox: a Worker needs its own script, and a plugin is a single plugin.js, so the
// worker is bundled first and handed to httpscript.ts as text (virtual:httpscript-worker).
import { join } from "node:path";
import { build } from "esbuild";

export const esbuildPlugins = [{
  name: "httpscript-worker",
  setup(b) {
    b.onResolve({ filter: /^virtual:httpscript-worker$/ }, (a) => ({ path: a.path, namespace: "worker" }));
    b.onLoad({ filter: /.*/, namespace: "worker" }, async () => {
      const out = await build({
        entryPoints: [join(import.meta.dirname, "src", "httpscript.worker.ts")],
        bundle: true, write: false, format: "iife", target: "es2022", minify: true,
      });
      return { contents: out.outputFiles[0].text, loader: "text" };
    });
  },
}];
