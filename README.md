# ProxyMu

Hybrid local proxy and control center for Codex-compatible, OpenAI-compatible, and Claude Code traffic.

## URLs

- Admin dashboard: `http://127.0.0.1:1432/admin`
- Health: `http://127.0.0.1:1432/`
- OpenAI-compatible base URL: `http://127.0.0.1:1432/v1`
- Claude Code base URL: `http://127.0.0.1:1432`

## Run

```powershell
npm install
npm start
```

## Test

```powershell
npm test
```

## Claude Code

Claude Code should use the proxy root, without `/v1`:

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:1432
CLAUDE_MODEL=gpt-5.5
```

Claude SDK appends `/v1/messages` automatically.

## OpenAI-Compatible Clients

Use:

```text
http://127.0.0.1:1432/v1
```

## Notes

- Provider keys are encrypted in local config and are not committed.
- Telemetry lives under `data/` and is not committed.
- Legacy proxy backups are local only and are not committed.
