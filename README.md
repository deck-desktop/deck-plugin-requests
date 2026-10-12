# Requests for Deck

A Postman-style HTTP client in a pane. Open it from the **+** beside your tabs and choose
**Requests**.

- **Collections and folders** of saved requests, inside switchable **workspaces**.
- **Environments** with `{{variables}}`, plus dynamic values such as `{{$guid}}` and
  `{{$timestamp}}`.
- **Pre-request and post-response scripts** (a `pm`-style API, run in a sandboxed worker) for
  tests and token refreshes.
- **cURL** import (paste one into the URL bar) and export, and collection import/export.
- **History** of what you sent.
- Ctrl+Enter sends, Ctrl+S saves. Both can be rebound in Settings > Keybindings.

Requests are sent by Deck itself, not the browser, so there is no CORS, with a 10 MB response cap,
a 60 second timeout and a Cancel button.

Data lives in Deck's config on this machine: `requests-collections.json` and
`requests-history.json`. A backup includes the collections; the history is left out because it
holds every request sent, credentials included.

## For agents

The plugin brings `requests_*` tools to Deck's MCP server: list, send and edit requests,
collections, workspaces and environments. Secrets come back masked unless **Reveal secrets to
MCP** is on in the plugin's settings.

Requests was Deck's built-in HTTP tab until 1.1. Deck renames the old `http-*` files to the
plugin's the first time it starts, so everything saved there is here.
