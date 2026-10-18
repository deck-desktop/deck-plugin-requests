// Requests: build, send and save HTTP requests, in a pane. Deck's built-in HTTP client until 1.1.
//
// The sending is still Deck's (http.rs: no CORS, a size cap, a timeout, cancellation), reached
// through the bridge; everything else, the collections, environments, scripts and history, is
// the plugin's. Saved data moved with it: Deck renames the http-* config files to requests-* at
// startup, so a collection made in the old tab is here unchanged.
import { useSettings, saveSettings } from "../shim/settings.js";
import { Row } from "../shim/ui.js";
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
  // Deck's own settings row and switch, so this reads as part of the Settings screen around it.
  return (
    <Row
      title="Reveal secrets to MCP"
      desc={"Off: environment values and auth credentials come back masked, so tokens stay out of an "
        + "agent's transcript and its logs. On: they are returned in full. The agent can always "
        + "write them either way."}
      on={s.httpMcpRevealSecrets}
      onChange={(on) => void saveSettings({ ...s, httpMcpRevealSecrets: on })}
    />
  );
}

export function dispose() {
  void stopHttpSend.then((f) => { if (f) f(); });
  releaseWorker();
}
