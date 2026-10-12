// Markup for VarInput's contenteditable: plain text with {{var}} tokens wrapped in a span.
//
// Split out of the component because it builds HTML from text the user typed, so the escaping
// is the part that has to be right — see paint.check.ts.

const TOKEN = /\{\{\s*(\$?[\w.-]+)\s*\}\}/g;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Wrap every {{name}} in a coloured span, escaping everything else.
 *
 * An unknown name gets the "bad" class — a red token is the fastest way to see why a request
 * went out with a literal {{base}} still in the URL.
 */
export function paint(text: string, vars: Record<string, string>): string {
  let out = "";
  let last = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    out += esc(text.slice(last, m.index));
    const known = Object.prototype.hasOwnProperty.call(vars, m[1]);
    // The resolved value lands in a title attribute, so it is escaped as an attribute (quotes
    // included) rather than as text.
    const title = known ? esc(vars[m[1]]) : "Not defined in this environment";
    out += `<span class="var-tok${known ? "" : " bad"}" title="${title}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}
