// A small Monaco host for in-memory text — a request body, a snippet — as opposed to a file.
//
// The editor's MonacoEditor is file-bound: it takes a path, creates file models, starts the LSP
// and saves per-path view states. None of that applies to content with no file behind it, so this
// keeps the same engine, theme and settings while owning its own throwaway model.
//
// The JSON worker is already configured in core/monaco, so a "json" language gets validation,
// bracket matching and format-on-demand for free.
import { useEffect, useRef } from "react";
import { monaco } from "../shim/monaco.js";
import { bindMonacoKey, getEditorSettings, monacoOptionsFrom } from "../shim/ui.js";
import { registerTemplateVars, decorateTemplateVars } from "./monacovars";

export default function CodeBox({
  value, onChange, language, placeholder, readOnly, templateVars, onSave, folding = false,
}: {
  value: string;
  onChange?: (v: string) => void;
  /** Monaco language id — "json", "plaintext", "xml", … */
  language: string;
  /** Shown over an empty box; Monaco has no placeholder of its own. */
  placeholder?: string;
  readOnly?: boolean;
  /** Colour {{name}} tokens and complete them from the active environment. */
  templateVars?: boolean;
  /** Ctrl+S while the box has focus. Monaco consumes the key itself, so a window-level shortcut
   *  never fires while the caret is in here — the caller has to route it through this. */
  onSave?: () => void;
  /** Fold arrows in the gutter. Worth the width on a nested response body, noise on a short one. */
  folding?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const edRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // The listener is installed once with the instance, so calling the prop directly would pin it
  // to whichever handler existed at mount — the same bug MonacoHosts documents.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Same reason as onChangeRef: the command is registered once with the instance, so it must not
  // capture the handler that existed at mount.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!host.current) return;
    const model = monaco.editor.createModel(value, language);
    const ed = monaco.editor.create(host.current, {
      model,
      ...monacoOptionsFrom(getEditorSettings()),
      // A body pane is short and sits inside a form, so the editor chrome that suits a file view
      // is noise here.
      minimap: { enabled: false },
      glyphMargin: false,
      // Folding earns its gutter width wherever the content nests: a JSON response is mostly
      // structure the reader wants to collapse, and a pasted request payload is the same.
      // "mouseover" keeps the arrows out of the way until the pointer is in the gutter.
      folding,
      showFoldingControls: "mouseover",
      // Gap between the line number and the code; 0 leaves them touching.
      lineDecorationsWidth: 8,
      // Narrow gutter: a body or a response is rarely more than three digits of lines.
      lineNumbersMinChars: 3,
      overviewRulerLanes: 0,
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      padding: { top: 8, bottom: 8 },
      wordWrap: "on",
      readOnly,
    });
    edRef.current = ed;

    const sub = ed.onDidChangeModelContent(() => onChangeRef.current?.(ed.getValue()));

    // Save on the chord Settings has for Deck's editor:save, following a rebind.
    const unSave = bindMonacoKey(ed, monaco, "editor:save", () => onSaveRef.current?.());

    // {{variable}} colouring and completion. The providers are global and registered once; the
    // decorations are per-editor and refreshed on every edit.
    let varSub: monaco.IDisposable | null = null;
    let decorations: monaco.editor.IEditorDecorationsCollection | null = null;
    if (templateVars) {
      registerTemplateVars();
      decorations = ed.createDecorationsCollection();
      decorateTemplateVars(ed, decorations);
      varSub = ed.onDidChangeModelContent(() => decorateTemplateVars(ed, decorations!));
    }

    // Monaco does not resize itself; the body pane is resizable, so watch the host.
    const ro = new ResizeObserver(() => ed.layout());
    ro.observe(host.current);

    return () => {
      unSave(); sub.dispose(); varSub?.dispose(); decorations?.clear();
      ro.disconnect(); ed.dispose(); model.dispose(); edRef.current = null;
    };
    // Mount once. `value` and `language` are synced by the effects below; re-creating the editor
    // on every keystroke would lose the cursor, and on every language change the scroll position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, templateVars, folding]);

  // Outside edits (switching request tabs, "format", a restored draft) — but never echo back what
  // the user just typed, which would reset the cursor to the start on every keystroke.
  useEffect(() => {
    const ed = edRef.current;
    if (ed && ed.getValue() !== value) ed.setValue(value);
  }, [value]);

  // A response's content type is only known once it arrives, so the language changes under a
  // live editor. Set it on the model rather than rebuilding.
  useEffect(() => {
    const m = edRef.current?.getModel();
    if (m) monaco.editor.setModelLanguage(m, language);
  }, [language]);

  return (
    <div className="relative h-full w-full">
      <div ref={host} className="h-full w-full" />
      {placeholder && !value && (
        <pre className="pointer-events-none absolute left-[44px] top-2 select-none font-mono text-xs text-text-muted">
          {placeholder}
        </pre>
      )}
    </div>
  );
}
