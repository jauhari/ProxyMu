const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();

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

// ─── Paths ───────────────────────────────────────────────────────────────────

const PATHS = {
  codexConfig: path.join(HOME, '.codex', 'config.toml'),
  codexState: path.join(HOME, '.codex', '.proxymu-state.json'),
  opencodeConfig: path.join(HOME, '.config', 'opencode', 'opencode.json'),
  kiloSettings: path.join(HOME, 'Library', 'Application Support', 'Antigravity IDE', 'User', 'settings.json'),
  proxymuEnv: path.join(HOME, '.proxymu.env'),
  zshrc: path.join(HOME, '.zshrc'),
  bashrc: path.join(HOME, '.bashrc')
};

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

// ─── Public catalog ───────────────────────────────────────────────────────────

const TOOLS = [
  {
    id: 'codex',
    name: 'Codex CLI',
    description: 'Set ProxyMu sebagai active provider di ~/.codex/config.toml',
    configPath: '~/.codex/config.toml',
    status: codexStatus,
    inject: codexInject,
    eject: codexEject
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'Tambah ProxyMu sebagai provider di ~/.config/opencode/opencode.json',
    configPath: '~/.config/opencode/opencode.json',
    status: opencodeStatus,
    inject: opencodeInject,
    eject: opencodeEject
  },
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
