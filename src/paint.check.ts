// Runnable check for VarInput's markup builder:
//   npx tsx plugins/requests/src/paint.check.ts
//
// paint() turns text the user typed into innerHTML, so a missed escape is script injection into
// Deck's own webview — a URL is exactly the kind of field someone pastes into from elsewhere.
import assert from "node:assert";
import { paint } from "./paint";

const vars = { base: "https://a.com", tok: "s3cret" };

// Known variable: accent span, value in the tooltip.
assert.strictEqual(
  paint("{{base}}/x", vars),
  '<span class="var-tok" title="https://a.com">{{base}}</span>/x',
);

// Unknown variable: flagged, and the tooltip says why rather than leaking an empty value.
assert.strictEqual(
  paint("{{nope}}", vars),
  '<span class="var-tok bad" title="Not defined in this environment">{{nope}}</span>',
);

// Plain text with no tokens is escaped and otherwise untouched.
assert.strictEqual(paint("a & b", vars), "a &amp; b");

// Generator names start with $ and must paint as known, not as a red unknown token. VarInput
// feeds their descriptions in as the "values", so that is what the tooltip shows.
assert.strictEqual(
  paint("{{$guid}}", { $guid: "UUID v4" }),
  '<span class="var-tok" title="UUID v4">{{$guid}}</span>',
);

// ---- injection ----

// Script tags in the surrounding text are inert.
assert.strictEqual(
  paint("<script>alert(1)</script>", vars),
  "&lt;script&gt;alert(1)&lt;/script&gt;",
);

// A variable VALUE carrying a quote cannot break out of the title attribute and add its own.
// Without the &quot; escape this would end the attribute and inject an onerror handler.
{
  const evil = { x: '" onmouseover="alert(1)' };
  const html = paint("{{x}}", evil);
  assert.ok(!html.includes('onmouseover="'), `attribute injection: ${html}`);
  assert.strictEqual(html, '<span class="var-tok" title="&quot; onmouseover=&quot;alert(1)">{{x}}</span>');
}

// Text around a token is escaped too — the token match must not reset the escaping.
assert.strictEqual(
  paint("<b>{{base}}</b>", vars),
  '&lt;b&gt;<span class="var-tok" title="https://a.com">{{base}}</span>&lt;/b&gt;',
);

// ---- shape ----

// Several tokens in one string all render, with the text between them intact.
assert.strictEqual(
  paint("{{base}}/u/{{tok}}", vars),
  '<span class="var-tok" title="https://a.com">{{base}}</span>/u/<span class="var-tok" title="s3cret">{{tok}}</span>',
);

// Inner whitespace is allowed and the original spelling is preserved on screen.
assert.strictEqual(
  paint("{{ base }}", vars),
  '<span class="var-tok" title="https://a.com">{{ base }}</span>',
);

// An unclosed brace pair is just text — this is what the field looks like mid-typing.
assert.strictEqual(paint("{{bas", vars), "{{bas");

// The regex is module-level with /g; a stale lastIndex would make every other call skip the
// first token. Calling twice with the same input must give the same answer.
assert.strictEqual(paint("{{base}}", vars), paint("{{base}}", vars));

console.log("ok");
