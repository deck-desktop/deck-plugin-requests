// HTTP client session persistence — remembers open request tabs, which one is active, the sidebar
// view and width, and which folders are collapsed.
//
// localStorage, not a config file, for the same reasons as the editor's session store: this is
// per-machine UI state, and it holds unsaved drafts (which carry tokens and secrets in headers and
// bodies) that should not end up in a backup. Dev and prod are separate WebView origins, so they
// never collide.
//
// The active workspace is NOT here — that lives in requests-collections.json, because it is part of
// the collection model rather than this device's view of it.
import type { Request } from "./httpclient";

export interface SessionTab {
  id: string;
  requestId: string | null;
  draft: Request;
  saved: Request | null;
}

export interface HttpSession {
  tabs: SessionTab[];
  activeId: string | null;
  // "env" was a third view before environments became a popup; a session saved back then still
  // has it, and HttpClient coerces anything that is not "history" to "collections".
  rail: "collections" | "history";
  sidebarW: number;
  collapsed: string[];
}

const KEY = "deck.http.session";

export function loadHttpSession(): Partial<HttpSession> {
  try { const t = localStorage.getItem(KEY); return t ? JSON.parse(t) : {}; } catch { return {}; }
}

export function saveHttpSession(s: HttpSession) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* quota / private mode */ }
}
