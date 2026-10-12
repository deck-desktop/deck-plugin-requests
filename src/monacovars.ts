// {{variable}} support inside Monaco — completion when you type "{{", and a colour on every
// token so an unresolved one is visible at a glance.
//
// The VarInput used by the URL and the key/value grids paints its own tokens with a
// contenteditable; a Monaco body cannot reuse that, so this provides the same two affordances
// through Monaco's own APIs.
//
// Registration is global and one-shot (Monaco keeps providers per language, not per editor), so
// the variable set is read through a getter that the app updates as environments change.
import { monaco } from "../shim/monaco.js";
import { DYNAMIC_VARS } from "./httpdynamic";

let getVars: () => Record<string, string> = () => ({});

/** Point the completions and the highlighter at the active environment's variables. */
export function setTemplateVars(fn: () => Record<string, string>) {
  getVars = fn;
}

const LANGS = ["json", "plaintext", "xml", "html"];

let registered = false;

export function registerTemplateVars() {
  if (registered) return;
  registered = true;

  for (const lang of LANGS) {
    monaco.languages.registerCompletionItemProvider(lang, {
      // Typing the second "{" opens the list; "$" narrows it to the generators.
      triggerCharacters: ["{", "$"],
      provideCompletionItems(model, position) {
        const line = model.getValueInRange({
          startLineNumber: position.lineNumber, startColumn: 1,
          endLineNumber: position.lineNumber, endColumn: position.column,
        });
        // Only inside an unclosed "{{", so ordinary JSON braces do not trigger it.
        const open = line.lastIndexOf("{{");
        if (open < 0 || line.indexOf("}}", open) >= 0) return { suggestions: [] };

        // Replace from the "{{" itself, not just the word: what has been typed after it may
        // include a "$", which getWordUntilPosition does not count as part of the word and would
        // otherwise be left stranded before the inserted text.
        const start = open + 1; // 1-based column of the first "{"
        // Swallow a "}}" already sitting after the cursor (Monaco auto-closes braces), or
        // accepting a completion would leave "{{$guid}}}}".
        const after = model.getValueInRange({
          startLineNumber: position.lineNumber, startColumn: position.column,
          endLineNumber: position.lineNumber, endColumn: position.column + 2,
        });
        const range = {
          startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
          startColumn: start, endColumn: position.column + (after === "}}" ? 2 : 0),
        };

        const item = (
          name: string,
          rest: Pick<monaco.languages.CompletionItem, "kind" | "detail" | "documentation">,
        ): monaco.languages.CompletionItem => ({
          label: name,
          // The whole token, braces included — a bare name would leave "{{guid" unclosed.
          insertText: `{{${name}}}`,
          // Sort by the name rather than the inserted "{{…", so the list is alphabetical.
          sortText: name,
          filterText: `{{${name}`,
          range,
          ...rest,
        });

        const env = Object.entries(getVars()).map(([name, value]) => item(name, {
          kind: monaco.languages.CompletionItemKind.Variable,
          detail: value.length > 60 ? value.slice(0, 60) + "…" : value,
          documentation: "Environment variable",
        }));

        const dynamic = Object.entries(DYNAMIC_VARS).map(([name, v]) => item(name, {
          kind: monaco.languages.CompletionItemKind.Function,
          detail: v.description,
          documentation: `Generated fresh on each send — e.g. ${v.generate()}`,
        }));

        return { suggestions: [...env, ...dynamic] };
      },
    });

    // Hover: what a variable will actually resolve to.
    monaco.languages.registerHoverProvider(lang, {
      provideHover(model, position) {
        const text = model.getLineContent(position.lineNumber);
        for (const m of text.matchAll(/\{\{\s*(\$?[\w.-]+)\s*\}\}/g)) {
          const start = m.index + 1;
          const end = start + m[0].length;
          if (position.column < start || position.column > end) continue;
          const name = m[1];
          const dyn = DYNAMIC_VARS[name];
          const value = dyn ? `_${dyn.description}_ — generated on send` : getVars()[name];
          return {
            range: new monaco.Range(position.lineNumber, start, position.lineNumber, end),
            contents: [{ value: value ? `**${name}**\n\n${value}` : `**${name}**\n\n_Not defined in the active environment._` }],
          };
        }
        return null;
      },
    });
  }
}

/**
 * Colour every {{token}} in a model: accent when it resolves, red when it does not.
 *
 * Monaco has no way to add tokens to another language's tokenizer without replacing it, so this
 * decorates ranges instead — which also lets the colour depend on whether the variable exists.
 */
export function decorateTemplateVars(
  editor: monaco.editor.IStandaloneCodeEditor,
  collection: monaco.editor.IEditorDecorationsCollection,
) {
  const model = editor.getModel();
  if (!model) { collection.clear(); return; }

  const vars = getVars();
  const decorations: monaco.editor.IModelDeltaDecoration[] = [];

  for (let line = 1; line <= model.getLineCount(); line++) {
    const text = model.getLineContent(line);
    for (const m of text.matchAll(/\{\{\s*(\$?[\w.-]+)\s*\}\}/g)) {
      const name = m[1];
      const known = name in vars || name in DYNAMIC_VARS;
      decorations.push({
        range: new monaco.Range(line, m.index + 1, line, m.index + 1 + m[0].length),
        // Same classes VarInput paints with, so a token looks identical in the URL bar and here.
        options: { inlineClassName: known ? "var-tok" : "var-tok bad" },
      });
    }
  }

  collection.set(decorations);
}
