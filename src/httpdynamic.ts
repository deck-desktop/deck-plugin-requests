// Built-in {{$variables}} — generated fresh on every send, alongside the environment's own.
//
// These are what you reach for when a request needs a value that must differ each time: a new
// idempotency key, a unique signup email, a timestamp. Typing one by hand every send is the
// thing this removes.

const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
const int = (lo: number, hi: number) => Math.floor(Math.random() * (hi - lo + 1)) + lo;
const hex = (n: number) =>
  Array.from({ length: n }, () => "0123456789abcdef"[int(0, 15)]).join("");

// crypto.randomUUID needs a secure context. The webview is one, but a plain-http dev server is
// not, so there is a fallback rather than a crash in the one place it would be noticed late.
const guid = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[int(0, 3)]}${hex(3)}-${hex(12)}`;

const FIRST = ["ada", "grace", "alan", "linus", "rob", "ken", "barbara", "margaret"] as const;
const LAST = ["lovelace", "hopper", "turing", "torvalds", "pike", "thompson", "liskov", "hamilton"] as const;
const TLDS = ["com", "dev", "io", "org", "net"] as const;

export interface DynamicVar {
  generate: () => string;
  description: string;
}

export const DYNAMIC_VARS: Record<string, DynamicVar> = {
  $guid: { generate: guid, description: "UUID v4" },
  $uuid: { generate: guid, description: "UUID v4 (alias)" },
  $timestamp: { generate: () => String(Math.floor(Date.now() / 1000)), description: "Unix timestamp (seconds)" },
  $timestampMs: { generate: () => String(Date.now()), description: "Unix timestamp (milliseconds)" },
  $isoTimestamp: { generate: () => new Date().toISOString(), description: "ISO 8601 date-time" },
  $randomInt: { generate: () => String(int(0, 1000)), description: "Random integer 0–1000" },
  $randomFloat: { generate: () => (Math.random() * 1000).toFixed(2), description: "Random float 0–1000" },
  $randomBoolean: { generate: () => String(Math.random() < 0.5), description: "true or false" },
  $randomFirstName: { generate: () => pick(FIRST), description: "Random first name" },
  $randomLastName: { generate: () => pick(LAST), description: "Random last name" },
  $randomFullName: { generate: () => `${pick(FIRST)} ${pick(LAST)}`, description: "Random full name" },
  $randomEmail: { generate: () => `${pick(FIRST)}.${pick(LAST)}${int(1, 99)}@example.${pick(TLDS)}`, description: "Random email address" },
  $randomUsername: { generate: () => `${pick(FIRST)}${int(10, 999)}`, description: "Random username" },
  $randomPassword: { generate: () => hex(16), description: "Random 16-char hex string" },
  $randomHexColor: { generate: () => `#${hex(6)}`, description: "Random hex colour" },
  $randomIPv4: { generate: () => `${int(1, 254)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`, description: "Random IPv4 address" },
  $randomUrl: { generate: () => `https://${pick(FIRST)}${pick(LAST)}.${pick(TLDS)}`, description: "Random URL" },
  $randomAlphaNumeric: { generate: () => Math.random().toString(36).slice(2, 10), description: "Random alphanumeric string" },
  $randomLocale: { generate: () => pick(["en-US", "fr-FR", "de-DE", "es-ES", "ja-JP", "zh-CN", "pt-BR", "ar-SA"]), description: "Random locale" },
  $randomCurrency: { generate: () => pick(["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF"]), description: "Random currency code" },
  $randomPhoneNumber: { generate: () => `+1-${int(200, 999)}-${int(100, 999)}-${int(1000, 9999)}`, description: "Random phone number" },
  $randomWord: { generate: () => pick([...FIRST, ...LAST]), description: "Random word" },
};

/**
 * Freshly generated values for every dynamic variable.
 *
 * Called once per send so the same {{$guid}} used in a header and in the body resolves to the
 * same value within one request — two different ids there would be a surprising kind of wrong.
 */
export function dynamicValues(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(DYNAMIC_VARS)) out[name] = v.generate();
  return out;
}
