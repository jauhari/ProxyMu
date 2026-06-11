# Changelog

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
