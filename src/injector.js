const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();
const PLATFORM = os.platform(); // 'darwin' = macOS, 'win32' = Windows, 'linux' = Linux
const IS_WINDOWS = PLATFORM === 'win32';
const IS_MAC = PLATFORM === 'darwin';

// ─── TOML helpers (no dependency) ────────────────────────────────────────────

function tomlEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function tomlGetKey(text, key) {
  const match = text.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return match ? match[1] : null;
}

function tomlSetKey(text, key, value) {
  const line = `${key} = "${tomlEscape(value)}"`;
  const re = new RegExp(`^${key}\\s*=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  // Insert before first section header to stay in top-level block
  const firstSection = /^\[/m.exec(text);
  if (firstSection) return text.slice(0, firstSection.index) + line + '\n' + text.slice(firstSection.index);
  return text + (text.endsWith('\n') ? '' : '\n') + line + '\n';
}

function tomlSectionBounds(text, sectionName) {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startRe = new RegExp(`^\\[${escaped}\\]`, 'm');
  const startMatch = startRe.exec(text);
  if (!startMatch) return null;
  const start = startMatch.index;
  const after = text.slice(start + startMatch[0].length + 1);
  const nextMatch = /^\[/m.exec(after);
  const end = nextMatch ? start + startMatch[0].length + 1 + nextMatch.index : text.length;
  return { start, end };
}

function tomlHasSection(text, sectionName) {
  return tomlSectionBounds(text, sectionName) !== null;
}

function tomlUpsertSection(text, sectionName, body) {
  const block = `[${sectionName}]\n${body}\n`;
  const bounds = tomlSectionBounds(text, sectionName);
  if (bounds) return text.slice(0, bounds.start) + block + text.slice(bounds.end);
  return text + (text.endsWith('\n') ? '' : '\n') + '\n' + block;
}

function tomlRemoveSection(text, sectionName) {
  const bounds = tomlSectionBounds(text, sectionName);
  if (!bounds) return text;
  const before = text.slice(0, bounds.start).replace(/\n+$/, '\n');
  return before + text.slice(bounds.end);
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

async function readJson(filePath, fallback = {}) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { return fallback; }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n');
}

// ─── File helpers ─────────────────────────────────────────────────────────────

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

// ─── Paths (platform-aware) ──────────────────────────────────────────────────

const PATHS = (() => {
  const base = {
    codexConfig: path.join(HOME, '.codex', 'config.toml'),
    codexState: path.join(HOME, '.codex', '.proxymu-state.json'),
    opencodeConfig: path.join(HOME, '.config', 'opencode', 'opencode.json'),
    proxymuEnv: IS_WINDOWS ? path.join(HOME, '.proxymu.env') : path.join(HOME, '.proxymu.env'),
  };

  if (IS_MAC) {
    return {
      ...base,
      kiloSettings: path.join(HOME, 'Library', 'Application Support', 'Antigravity IDE', 'User', 'settings.json'),
      zshrc: path.join(HOME, '.zshrc'),
      bashrc: path.join(HOME, '.bashrc'),
    };
  } else if (IS_WINDOWS) {
    const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    const psProfile = path.join(appData, 'PowerShell', 'profile.ps1');
    return {
      ...base,
      vscodeSettings: path.join(appData, 'Code', 'User', 'settings.json'),
      cursorSettings: path.join(appData, 'Cursor', 'User', 'settings.json'),
      psProfile,
      psCore: path.join(appData, 'PowerShell', 'profile.ps1'),
      psDesktop: path.join(appData, 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
    };
  }
  return base;
})();

const ZSH_SOURCE = `[ -f ~/.proxymu.env ] && . ~/.proxymu.env  # ProxyMu auto-config`;
const BASH_SOURCE = `[ -f ~/.proxymu.env ] && . ~/.proxymu.env  # ProxyMu auto-config`;
const PROXYMU_MARKER = '# ProxyMu auto-config';

function envFileContent(host, port) {
  return [
    '# ProxyMu — auto-generated, do not edit manually',
    `export ANTHROPIC_BASE_URL="http://${host}:${port}"`,
    `export ANTHROPIC_AUTH_TOKEN="proxy-local"`,
    `export OPENAI_API_KEY="proxy-local"`,
    `export OPENAI_BASE_URL="http://${host}:${port}/v1"`
  ].join('\n') + '\n';
}

// ─── Codex CLI ────────────────────────────────────────────────────────────────

async function codexStatus() {
  if (!await exists(PATHS.codexConfig)) return { installed: false, injected: false };
  const text = await fs.readFile(PATHS.codexConfig, 'utf8');
  return { installed: true, injected: tomlHasSection(text, 'model_providers.proxymu') };
}

async function codexInject(host, port) {
  const text = await exists(PATHS.codexConfig) ? await fs.readFile(PATHS.codexConfig, 'utf8') : '';
  // Save current provider so we can restore on eject
  const currentProvider = tomlGetKey(text, 'model_provider');
  if (currentProvider && currentProvider !== 'proxymu') {
    await writeJson(PATHS.codexState, { savedModelProvider: currentProvider });
  }
  let updated = tomlSetKey(text, 'model_provider', 'proxymu');
  const block = [
    `name = "ProxyMu"`,
    `base_url = "http://${host}:${port}/v1"`,
    `wire_api = "responses"`,
    `experimental_bearer_token = "proxy-local"`
  ].join('\n');
  updated = tomlUpsertSection(updated, 'model_providers.proxymu', block);
  await fs.mkdir(path.dirname(PATHS.codexConfig), { recursive: true });
  await fs.writeFile(PATHS.codexConfig, updated);
}

async function codexEject() {
  if (!await exists(PATHS.codexConfig)) return;
  let text = await fs.readFile(PATHS.codexConfig, 'utf8');
  text = tomlRemoveSection(text, 'model_providers.proxymu');
  const state = await readJson(PATHS.codexState);
  if (state.savedModelProvider) {
    text = tomlSetKey(text, 'model_provider', state.savedModelProvider);
    try { await fs.unlink(PATHS.codexState); } catch {}
  } else {
    text = text.replace(/^model_provider\s*=\s*"proxymu"\n?/m, '');
  }
  await fs.writeFile(PATHS.codexConfig, text);
}

// ─── OpenCode ────────────────────────────────────────────────────────────────

async function opencodeStatus() {
  if (!await exists(PATHS.opencodeConfig)) return { installed: false, injected: false };
  const cfg = await readJson(PATHS.opencodeConfig);
  return { installed: true, injected: Boolean(cfg?.provider?.proxymu) };
}

async function opencodeInject(host, port) {
  const cfg = await readJson(PATHS.opencodeConfig, { $schema: 'https://opencode.ai/config.json' });
  cfg.provider = cfg.provider || {};
  cfg.provider.proxymu = {
    npm: '@ai-sdk/openai-compatible',
    options: { baseURL: `http://${host}:${port}/v1`, apiKey: 'proxy-local' },
    models: {}
  };
  await writeJson(PATHS.opencodeConfig, cfg);
}

async function opencodeEject() {
  if (!await exists(PATHS.opencodeConfig)) return;
  const cfg = await readJson(PATHS.opencodeConfig);
  if (cfg?.provider) delete cfg.provider.proxymu;
  await writeJson(PATHS.opencodeConfig, cfg);
}

// ─── Kilo Code (Antigravity IDE) ─────────────────────────────────────────────

const KILO_KEYS = [
  'kilo-code.new.apiProvider',
  'kilo-code.new.openAiBaseUrl',
  'kilo-code.new.openAiApiKey'
];

async function kiloStatus() {
  if (!await exists(PATHS.kiloSettings)) return { installed: false, injected: false };
  const settings = await readJson(PATHS.kiloSettings);
  const url = settings['kilo-code.new.openAiBaseUrl'] || '';
  return {
    installed: true,
    injected: settings['kilo-code.new.apiProvider'] === 'openai' && (url.includes('127.0.0.1') || url.includes('localhost'))
  };
}

async function kiloInject(host, port) {
  const settings = await readJson(PATHS.kiloSettings, {});
  settings['kilo-code.new.apiProvider'] = 'openai';
  settings['kilo-code.new.openAiBaseUrl'] = `http://${host}:${port}/v1`;
  settings['kilo-code.new.openAiApiKey'] = 'proxy-local';
  await writeJson(PATHS.kiloSettings, settings);
}

async function kiloEject() {
  if (!await exists(PATHS.kiloSettings)) return;
  const settings = await readJson(PATHS.kiloSettings, {});
  KILO_KEYS.forEach((k) => delete settings[k]);
  await writeJson(PATHS.kiloSettings, settings);
}

// ─── Shell (Zsh / Bash) ───────────────────────────────────────────────────────

async function shellStatus(rcPath) {
  const hasEnv = await exists(PATHS.proxymuEnv);
  if (!await exists(rcPath)) return { installed: true, injected: false };
  const rc = await fs.readFile(rcPath, 'utf8');
  return { installed: true, injected: hasEnv && rc.includes(PROXYMU_MARKER) };
}

async function shellInject(rcPath, sourceLine, host, port) {
  await fs.writeFile(PATHS.proxymuEnv, envFileContent(host, port));
  if (!await exists(rcPath)) return;
  const rc = await fs.readFile(rcPath, 'utf8');
  if (!rc.includes(PROXYMU_MARKER)) {
    await fs.appendFile(rcPath, `\n${sourceLine}\n`);
  }
  // If already sourced, just update the env file (already done above)
}

async function shellEject(rcPath) {
  if (await exists(rcPath)) {
    const rc = await fs.readFile(rcPath, 'utf8');
    const cleaned = rc.replace(/\n?[^\n]*ProxyMu auto-config[^\n]*\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
    await fs.writeFile(rcPath, cleaned);
  }
  try { await fs.unlink(PATHS.proxymuEnv); } catch {}
}

// ─── PowerShell (Windows) ─────────────────────────────────────────────────────

async function powershellStatus() {
  if (!IS_WINDOWS) return { installed: false, injected: false };
  const hasEnv = await exists(PATHS.proxymuEnv);
  const hasProfile = await exists(PATHS.psCore) || await exists(PATHS.psDesktop);
  if (!hasProfile) return { installed: true, injected: false };
  try {
    const profile = await fs.readFile(PATHS.psCore, 'utf8').catch(() =>
      fs.readFile(PATHS.psDesktop, 'utf8')
    );
    return { installed: true, injected: hasEnv && profile.includes('ProxyMu auto-config') };
  } catch {
    return { installed: true, injected: false };
  }
}

function powershellProfileContent(host, port) {
  return [
    '# ProxyMu — auto-generated, do not edit manually',
    `$env:ANTHROPIC_BASE_URL = "http://${host}:${port}"`,
    `$env:ANTHROPIC_AUTH_TOKEN = "proxy-local"`,
    `$env:OPENAI_API_KEY = "proxy-local"`,
    `$env:OPENAI_BASE_URL = "http://${host}:${port}/v1"`,
    '# ProxyMu auto-config'
  ].join('\n') + '\n';
}

async function powershellInject(host, port) {
  await fs.writeFile(PATHS.proxymuEnv, envFileContent(host, port));

  const profilePath = PATHS.psCore;
  const profileDir = path.dirname(profilePath);
  await fs.mkdir(profileDir, { recursive: true });

  const sourceCmd = `. "$HOME\.proxymu.env"  # ProxyMu auto-config`;
  const content = powershellProfileContent(host, port);

  if (await exists(profilePath)) {
    const existing = await fs.readFile(profilePath, 'utf8');
    if (!existing.includes('ProxyMu auto-config')) {
      await fs.appendFile(profilePath, '\n' + sourceCmd + '\n');
    }
  } else {
    await fs.writeFile(profilePath, sourceCmd + '\n');
  }
}

async function powershellEject() {
  if (await exists(PATHS.psCore)) {
    const profile = await fs.readFile(PATHS.psCore, 'utf8');
    const cleaned = profile.replace(/\n?[^\n]*ProxyMu auto-config[^\n]*\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
    await fs.writeFile(PATHS.psCore, cleaned);
  }
  if (await exists(PATHS.psDesktop)) {
    const profile = await fs.readFile(PATHS.psDesktop, 'utf8');
    const cleaned = profile.replace(/\n?[^\n]*ProxyMu auto-config[^\n]*\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
    await fs.writeFile(PATHS.psDesktop, cleaned);
  }
  try { await fs.unlink(PATHS.proxymuEnv); } catch {}
}

// ─── VSCode (Windows & macOS) ──────────────────────────────────────────────────

async function vscodeStatus() {
  if (!IS_WINDOWS) return { installed: false, injected: false };
  if (!await exists(PATHS.vscodeSettings)) return { installed: false, injected: false };
  const cfg = await readJson(PATHS.vscodeSettings);
  return { installed: true, injected: Boolean(cfg?.['anthropic.api-key'] === 'proxy-local' && cfg?.['anthropic.api-endpoint']?.includes('127.0.0.1')) };
}

async function vscodeInject(host, port) {
  if (!IS_WINDOWS) return;
  const cfg = await readJson(PATHS.vscodeSettings, {});
  cfg['anthropic.api-key'] = 'proxy-local';
  cfg['anthropic.api-endpoint'] = `http://${host}:${port}`;
  await writeJson(PATHS.vscodeSettings, cfg);
}

async function vscodeEject() {
  if (!IS_WINDOWS) return;
  if (!await exists(PATHS.vscodeSettings)) return;
  const cfg = await readJson(PATHS.vscodeSettings, {});
  delete cfg['anthropic.api-key'];
  delete cfg['anthropic.api-endpoint'];
  await writeJson(PATHS.vscodeSettings, cfg);
}

// ─── Cursor (Windows) ──────────────────────────────────────────────────────────

async function cursorStatus() {
  if (!IS_WINDOWS) return { installed: false, injected: false };
  if (!await exists(PATHS.cursorSettings)) return { installed: false, injected: false };
  const cfg = await readJson(PATHS.cursorSettings);
  return { installed: true, injected: Boolean(cfg?.['anthropic.api-key'] === 'proxy-local' && cfg?.['anthropic.api-endpoint']?.includes('127.0.0.1')) };
}

async function cursorInject(host, port) {
  if (!IS_WINDOWS) return;
  const cfg = await readJson(PATHS.cursorSettings, {});
  cfg['anthropic.api-key'] = 'proxy-local';
  cfg['anthropic.api-endpoint'] = `http://${host}:${port}`;
  await writeJson(PATHS.cursorSettings, cfg);
}

async function cursorEject() {
  if (!IS_WINDOWS) return;
  if (!await exists(PATHS.cursorSettings)) return;
  const cfg = await readJson(PATHS.cursorSettings, {});
  delete cfg['anthropic.api-key'];
  delete cfg['anthropic.api-endpoint'];
  await writeJson(PATHS.cursorSettings, cfg);
}

// ─── Public catalog (platform-aware) ──────────────────────────────────────────

const TOOLS = (() => {
  const common = [
    {
      id: 'codex',
      name: 'Codex CLI',
      description: IS_WINDOWS ? 'Set ProxyMu sebagai active provider di ~/.codex/config.toml' : 'Set ProxyMu sebagai active provider di ~/.codex/config.toml',
      configPath: '~/.codex/config.toml',
      status: codexStatus,
      inject: codexInject,
      eject: codexEject
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      description: IS_WINDOWS ? 'Tambah ProxyMu sebagai provider di %APPDATA%\\opencode\\opencode.json' : 'Tambah ProxyMu sebagai provider di ~/.config/opencode/opencode.json',
      configPath: IS_WINDOWS ? '%APPDATA%\\opencode\\opencode.json' : '~/.config/opencode/opencode.json',
      status: opencodeStatus,
      inject: opencodeInject,
      eject: opencodeEject
    }
  ];

  const macTools = [
    {
      id: 'kilo-code',
      name: 'Kilo Code (Antigravity IDE)',
      description: 'Set OpenAI-compatible API ke ProxyMu di extension settings',
      configPath: '~/Library/.../Antigravity IDE/User/settings.json',
      status: kiloStatus,
      inject: kiloInject,
      eject: kiloEject
    },
    {
      id: 'zsh',
      name: 'Zsh Shell',
      description: 'Export env vars via ~/.proxymu.env ke ~/.zshrc — covers Claude Code, OpenAI SDK, dll.',
      configPath: '~/.zshrc',
      status: () => shellStatus(PATHS.zshrc),
      inject: (h, p) => shellInject(PATHS.zshrc, ZSH_SOURCE, h, p),
      eject: () => shellEject(PATHS.zshrc)
    },
    {
      id: 'bash',
      name: 'Bash Shell',
      description: 'Export env vars via ~/.proxymu.env ke ~/.bashrc',
      configPath: '~/.bashrc',
      status: () => shellStatus(PATHS.bashrc),
      inject: (h, p) => shellInject(PATHS.bashrc, BASH_SOURCE, h, p),
      eject: () => shellEject(PATHS.bashrc)
    }
  ];

  const windowsTools = [
    {
      id: 'powershell',
      name: 'PowerShell',
      description: 'Export env vars ke PowerShell profile — covers semua CLI tools',
      configPath: '%APPDATA%\\PowerShell\\profile.ps1',
      status: powershellStatus,
      inject: powershellInject,
      eject: powershellEject
    },
    {
      id: 'vscode',
      name: 'VS Code',
      description: 'Set Anthropic API endpoint di VS Code settings',
      configPath: '%APPDATA%\\Code\\User\\settings.json',
      status: vscodeStatus,
      inject: vscodeInject,
      eject: vscodeEject
    },
    {
      id: 'cursor',
      name: 'Cursor',
      description: 'Set Anthropic API endpoint di Cursor settings',
      configPath: '%APPDATA%\\Cursor\\User\\settings.json',
      status: cursorStatus,
      inject: cursorInject,
      eject: cursorEject
    }
  ];

  return [...common, ...(IS_MAC ? macTools : IS_WINDOWS ? windowsTools : [])];
})();

async function listTools() {
  return Promise.all(
    TOOLS.map(async (tool) => {
      const { installed, injected } = await tool.status().catch(() => ({ installed: false, injected: false }));
      return { id: tool.id, name: tool.name, description: tool.description, configPath: tool.configPath, installed, injected };
    })
  );
}

async function injectTool(id, host, port) {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool) throw Object.assign(new Error(`Unknown tool: ${id}`), { statusCode: 400 });
  await tool.inject(host, port);
  return tool.status();
}

async function ejectTool(id) {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool) throw Object.assign(new Error(`Unknown tool: ${id}`), { statusCode: 400 });
  await tool.eject();
  return tool.status();
}

module.exports = { listTools, injectTool, ejectTool };
