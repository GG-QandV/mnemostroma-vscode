# Mnemostroma — VS Code Extension

Routes Claude Code API calls through the [Mnemostroma](https://github.com/GG-QandV/mnemostroma) proxy for passive memory capture. Auto-configures MCP server.

## Requirements

- Mnemostroma daemon running: `mnemostroma on`
- Claude Code extension installed

## How it works

On startup the extension checks if the Mnemostroma proxy is running on `localhost:8767`. If yes:

- Sets `ANTHROPIC_BASE_URL=https://localhost:8767` — all Claude Code API calls route through the proxy
- Sets `NODE_EXTRA_CA_CERTS` — trusts the local TLS certificate
- Propagates env vars to all terminals opened inside the IDE
- Registers the Mnemostroma MCP server in `~/.claude.json` (once, if not already present)

## Status bar

| Icon | Meaning |
|------|---------|
| `● Mnemo` (teal) | Proxy active — memory capture ON |
| `⊘ Mnemo` (yellow) | Proxy offline — memory capture OFF |

Click the status bar item to refresh proxy status.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mnemostroma.proxyPort` | `8767` | Proxy port |
| `mnemostroma.certPath` | `~/.mnemostroma/certs/passthrough-ca.pem` | CA certificate path |
| `mnemostroma.pythonPath` | auto-detect | Python executable for MCP adapter |

## Gemini capture (Continue)

Capture via Continue + Gemini models requires proxy routing through `https://localhost:8767`.
Set `apiBase: https://localhost:8767/v1/` and `provider: openai` in Continue config.

> **Note (2026-04-16):** Google API experiencing prolonged outage (503/429). Routing is implemented and working — check again 2026-04-23.

## Commands

- `Mnemostroma: Toggle proxy routing` — refresh proxy status
- `Mnemostroma: Show status` — show current proxy state
