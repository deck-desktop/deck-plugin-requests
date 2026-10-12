// Requests: build, send and save HTTP requests, in a pane. Deck's built-in HTTP client until 1.1.
//
// The sending is still Deck's (http.rs: no CORS, a size cap, a timeout, cancellation), reached
// through the bridge; everything else, the collections, environments, scripts and history, is
// the plugin's. Saved data moved with it: Deck renames the http-* config files to requests-* at
// startup, so a collection made in the old tab is here unchanged.
import { Settings as SettingsIcon } from "lucide-react";
import { useSettings, saveSettings } from "../shim/settings.js";
import Requests from "./Requests";
import { stopHttpSend } from "./httpsend";
import { releaseWorker } from "./httpscript";

export const PaneView = () => <Requests />;

// Defaults only: a rebinding in Settings > Keybindings wins. Handled in Requests.tsx.
export const keybindings = () => [
  { id: "send", title: "Send the request", defaultChord: "ctrl+enter" },
  { id: "save", title: "Save the request", defaultChord: "ctrl+s" },
];

/** Whether the MCP tools return secrets in full. A Deck setting, because the MCP server reads it. */
export function Settings() {
  const s = useSettings();
  return (
    <label className="flex items-start gap-3 text-sm">
      <input type="checkbox" className="mt-1" checked={s.httpMcpRevealSecrets}
        onChange={(e) => void saveSettings({ ...s, httpMcpRevealSecrets: e.target.checked })} />
      <span>
        <span className="flex items-center gap-1.5 font-medium text-text-primary"><SettingsIcon size={13} /> Reveal secrets to MCP</span>
        <span className="block text-xs text-text-muted">
          Off: environment values and auth credentials come back masked, so tokens stay out of an
          agent's transcript and its logs. On: they are returned in full. The agent can always
          write them either way.
        </span>
      </span>
    </label>
  );
}

export function dispose() {
  void stopHttpSend.then((f) => { if (f) f(); });
  releaseWorker();
}
