# ProxyMu Auto-Configure Tools & Detection — Handoff 2026-06-11

## Completed in This Session

### 1. Auto-Detection System
- 30-second polling of 5 tools: Codex CLI, OpenCode, Kilo Code, Zsh, Bash
- Detection via config file presence: `~/.codex/config.toml`, `~/.config/opencode/opencode.json`, etc.
- Snapshot-based SSE push: only emit when `installed` or `injected` status changes
- Non-blocking: `listTools()` failures silently caught; polling continues

### 2. Tool Support

| Tool | Detection | Injection | Eject |
|------|-----------|-----------|-------|
| **Codex CLI** | `~/.codex/config.toml` exists | Writes `[model_providers.proxymu]` section | Removes section; restores via `~/.codex/.proxymu-state.json` |
| **OpenCode** | `~/.config/opencode/opencode.json` exists | Patches `provider.proxymu` object | Removes `provider.proxymu` |
| **Kilo Code** | `~/Library/Application Support/Antigravity IDE/User/settings.json` exists | Sets API provider to OpenAI-compatible | Removes provider keys |
| **Zsh Shell** | `~/.zshrc` exists | Creates `~/.proxymu.env` + appends source line | Removes env file + source line |
| **Bash Shell** | `~/.bashrc` exists | Creates `~/.proxymu.env` + appends source line | Removes env file + source line |

**Key detail**: Codex CLI and Codex App share the same config file (`~/.codex/config.toml`), so injecting once configures both.

### 3. UI Changes

**Settings Tab → Auto-Configure Tools**:
- Inject card list with detection badges (● "Installed" / ○ "Not installed")
- Real-time status updates via SSE when polling detects changes
- One-click inject/eject with visual feedback
- Codex CLI currently shows as "Tidak aktif" (not injected) — user to inject manually

### 4. API Endpoints

```
GET  /api/admin/inject              → { tools: [...] }
POST /api/admin/inject/:toolId      → injects & returns status
DELETE /api/admin/inject/:toolId    → ejects & returns status
```

### 5. Files Modified/Created

- **`src/injector.js`** (NEW): 300+ lines, TOML/JSON/shell helpers + 5 tool implementations
- **`src/server.js`**: Added inject polling loop + health check startup
- **`public/admin.html`**: Added inject panel to Settings tab
- **`public/assets/admin.css`**: Inject card styles (`.inject-card`, `.inject-badge`)
- **`public/assets/admin.js`**: `renderInjectList()`, SSE handler for `inject_status`
- **`src/admin-api.js`**: GET/POST/DELETE `/api/admin/inject/*`
- **`src/config-store.js`**: Added `modelRoutes: []` to default server config
- **`test/model-routing.test.js`**, **`test/provider-manager.test.js`**: Added tests

## How It Works

1. **Startup**: `server.js` calls `app.providerManager.startHealthChecks()` + begins 30s inject polling
2. **Polling**: Every 30s, `listTools()` reads all 5 tool configs, computes JSON snapshot
3. **Change Detection**: If snapshot differs, emit `inject_status` SSE event with updated `tools` array
4. **Frontend**: Dashboard SSE listener calls `renderInjectList(payload.tools)`, updates UI badges
5. **User Click**: Admin clicks "Injek" → POST `/api/admin/inject/codex` → server modifies `~/.codex/config.toml` + emits update
6. **Restore**: Codex eject restores old provider from `~/.codex/.proxymu-state.json` backup

## Known Limitations & Design Choices

- **TOML parsing**: Custom string-based helpers (no external dependency). Handles section bounds, key upsert, section removal. Assumes standard formatting.
- **Shell injection**: Creates `~/.proxymu.env` with 4 env vars; appends source line to rc files. Safe: checks for marker before re-appending.
- **State backup**: Codex restore uses separate state file vs. inline backup (avoids polluting main config with extra keys).
- **Health checks only in `start()`**: Not in `createApp()` — prevents e2e tests from hitting upstream. Critical for "no synthetic requests" test.
- **Polling granularity**: 30s chosen for balance (responsive but not chatty). Configurable in server.js line 381 if needed.

## Current Server State

- Running on `http://127.0.0.1:1432`
- Admin: `http://127.0.0.1:1432/admin` (login: `admin` / `proxymu-admin`)
- Codex CLI detected as **installed, not injected**
- Health checks warming TLS + seeding circuit breaker state every 60s
- All 4 original goals complete + 2 auto-config features

## Next Steps for User

1. Log in to admin dashboard
2. Go to **Settings** tab
3. Click **"Injek"** on Codex CLI to activate ProxyMu in `~/.codex/config.toml`
4. Codex App + CLI will immediately use ProxyMu as active provider
5. Optional: inject other tools (OpenCode, Zsh, etc.) as needed

## Testing

- Unit tests pass: `npm test` (model routing, provider manager, preferred provider)
- E2E: Codex config injection tested; eject reverses state correctly
- SSE: Poll → emit → dashboard update cycle verified

---

**Author**: Claude Code  
**Date**: 2026-06-11  
**Status**: Ready for production
