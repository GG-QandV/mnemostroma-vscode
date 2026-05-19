# Changelog — Mnemostroma VS Code Extension

## [0.1.4] — 2026-05-19

### Fixed
- **asyncio `PermissionError` on startup**: `mcp_stdio_adapter` crashed with
  `PermissionError: [Errno 1] Operation not permitted` when an IDE (Antigravity,
  Cursor) launched the adapter with stdin redirected to `/dev/null`.
  Root cause: `asyncio.get_event_loop()` (deprecated in Python 3.12) +
  `connect_read_pipe` on a non-pollable fd.  
  Fix: pre-flight `os.stat()` check; executor-based readline fallback when stdin
  is not a pipe/socket.
- **`FileNotFoundError: config.json` in `mcp_server`**: the server hard-coded
  relative paths and `os.chdir(project_root)`, breaking when the IDE launched
  the process from an arbitrary CWD.  
  Fix: `mcp_server` now resolves paths via `MNEMOSTROMA_DIR` env → `~/.mnemostroma`
  → project-root legacy fallback.
- **`env: {}` in MCP registration**: the extension wrote an empty `env` object
  when registering `mcp_stdio_adapter` in `~/.claude.json`.  
  Fix: `MNEMOSTROMA_DIR` is now included so the adapter finds the daemon socket
  regardless of launch CWD.

---

## [0.1.2] — 2026-04-16

### Added
- Initial release: proxy status bar, `ANTHROPIC_BASE_URL` injection,
  brain-watcher for Antigravity right panel, MCP auto-registration in `~/.claude.json`.
