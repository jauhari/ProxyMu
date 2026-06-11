# Changelog

## 2026-06-11 (continued)

### Auto-Configure Tools & Detection
- Added 30-second polling for newly installed tools (Codex CLI, OpenCode, Kilo Code, Zsh, Bash).
- Added auto-detect via config file presence checks (no system APIs required).
- Added one-click inject/eject functionality for each tool:
  - Codex CLI: injects `[model_providers.proxymu]` into `~/.codex/config.toml`; restores via state backup.
  - OpenCode: patches `provider.proxymu` into `~/.config/opencode/opencode.json`.
  - Kilo Code: sets API provider to OpenAI-compatible in Antigravity IDE settings.
  - Zsh/Bash: creates `~/.proxymu.env` with proxy env vars; sources via rc file.
- Added `src/injector.js` with TOML/JSON/shell config helpers and tool registry.
- Added SSE event `inject_status` that fires only when tool status changes (snapshot-based).
- Added Settings tab "Auto-Configure Tools" panel with live inject/eject UI.
- Added admin API endpoints: `GET /api/admin/inject`, `POST/DELETE /api/admin/inject/:toolId`.

## 2026-06-11

- Added Claude Code compatibility through local proxy root URL.
- Added Anthropic-style `/v1/messages` forwarding.
- Added local `/v1/messages/count_tokens` compatibility endpoint.
- Added model alias normalization:
  - `provider/model` aliases are normalized to `model`.
  - Claude `[1m]` suffixes are stripped before upstream routing.
- Fixed Claude Code setup: `ANTHROPIC_BASE_URL` must be `http://127.0.0.1:1432`, not `http://127.0.0.1:1432/v1`.
- Added OpenAI-compatible endpoint forwarding for `/v1/chat/completions` and `/v1/completions`.
- Added dashboard model routing with selectable model pills.
- Added current/last active model display.
- Added provider model loading from `/v1/models`.
- Added tests for model routing, count tokens, provider failover, provider validation, config encryption, and UI model behavior.

## 2026-06-10

- Rebuilt the simple proxy into Codex Proxy Hybrid Control Center.
- Added modular server, provider manager, config store, admin auth, telemetry, terminal dashboard, and web dashboard.
- Added encrypted local provider configuration.
- Added provider CRUD, validation, failover priority, enable/disable, and health state.
- Added telemetry JSONL event storage and live active stream tracking.
- Added LAN proxy token settings.
- Preserved the legacy proxy as local backup files, excluded from git.
