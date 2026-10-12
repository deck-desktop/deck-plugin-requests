// Common HTTP request headers, for the Headers grid's key autocomplete and its add-menu.
//
// Request headers only — a response-only header like Set-Cookie would just be noise while
// typing one. Canonical casing as used by MDN / the IANA registry.
export interface HeaderSuggestion {
  name: string;
  description: string;
  /** Offered in the "common headers" menu, with this as a starting value. */
  common?: string;
}

export const COMMON_HEADERS: HeaderSuggestion[] = [
  { name: "Accept", description: "Media types the client can process", common: "application/json" },
  { name: "Accept-Charset", description: "Acceptable character sets" },
  { name: "Accept-Encoding", description: "Acceptable content encodings", common: "gzip, deflate, br" },
  { name: "Accept-Language", description: "Preferred natural languages", common: "en-US,en;q=0.9" },
  { name: "Authorization", description: "Credentials for HTTP authentication", common: "Bearer {{token}}" },
  { name: "Cache-Control", description: "Caching directives", common: "no-cache" },
  { name: "Connection", description: "Control options for the current connection", common: "keep-alive" },
  { name: "Content-Disposition", description: "Display disposition (inline / attachment)" },
  { name: "Content-Encoding", description: "Encoding applied to the body" },
  { name: "Content-Language", description: "Natural language of the body" },
  { name: "Content-Length", description: "Body size in octets" },
  { name: "Content-Type", description: "MIME type of the body", common: "application/json" },
  { name: "Cookie", description: "Stored cookies sent to the server" },
  { name: "Date", description: "Date and time the message was sent" },
  { name: "DNT", description: "Do Not Track preference" },
  { name: "ETag", description: "Identifier for a specific resource version" },
  { name: "Expect", description: "Expectations the server must meet" },
  { name: "Forwarded", description: "Proxy / load-balancer hop info" },
  { name: "From", description: "Email address of the requesting user" },
  { name: "Host", description: "Target host and port" },
  { name: "If-Match", description: "Only act if the ETag matches" },
  { name: "If-Modified-Since", description: "Only act if changed since this date" },
  { name: "If-None-Match", description: "Only act if the ETag does NOT match" },
  { name: "If-Range", description: "Conditional range request" },
  { name: "If-Unmodified-Since", description: "Only act if unchanged since this date" },
  { name: "Idempotency-Key", description: "De-duplicates retried writes", common: "{{$guid}}" },
  { name: "Max-Forwards", description: "Limit on proxy hops" },
  { name: "Origin", description: "Origin of a cross-site request" },
  { name: "Pragma", description: "Legacy caching directive" },
  { name: "Prefer", description: "Preferred server behaviours" },
  { name: "Proxy-Authorization", description: "Credentials for a proxy" },
  { name: "Range", description: "Request only part of the resource", common: "bytes=0-1023" },
  { name: "Referer", description: "Address of the previous page" },
  { name: "TE", description: "Acceptable transfer encodings" },
  { name: "Upgrade-Insecure-Requests", description: "Prefer an encrypted response", common: "1" },
  { name: "User-Agent", description: "Identifies the client", common: "Deck/1.0" },
  { name: "X-Api-Key", description: "API key credential", common: "{{apiKey}}" },
  { name: "X-Correlation-ID", description: "Ties related requests together", common: "{{$guid}}" },
  { name: "X-Forwarded-For", description: "Originating client address" },
  { name: "X-Forwarded-Host", description: "Original Host requested by the client" },
  { name: "X-Forwarded-Proto", description: "Original protocol (http / https)" },
  { name: "X-Request-ID", description: "Unique id for this request", common: "{{$guid}}" },
  { name: "X-Requested-With", description: "Marks an AJAX request", common: "XMLHttpRequest" },
];

/** Just the names, for the key column's autocomplete. */
export const HEADER_NAMES = COMMON_HEADERS.map((h) => h.name);

/** The subset offered in the add-menu — the ones with a sensible starting value. */
export const QUICK_HEADERS = COMMON_HEADERS.filter((h) => h.common);
