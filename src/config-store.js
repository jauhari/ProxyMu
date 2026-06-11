const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_CONFIG = {
  version: 1,
  server: {
    port: 1432,
    host: '0.0.0.0',
    publicBaseUrl: '',
    requireProxyTokenForLan: true,
    proxyAccessTokenHash: '',
    selectedProviderId: '',
    selectedModel: '',
    overrideRequestModel: false
  },
  admin: null,
  providers: [],
  createdAt: '',
  updatedAt: ''
};

function freshDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function maskKey(key = '') {
  if (!key) return '';
  if (key.length < 8) return '***';
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

function deriveKey(secret) {
  return crypto.createHash('sha256').update(String(secret || 'codex-proxy-local-secret')).digest();
}

function encryptText(plainText, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url')
  ].join(':');
}

function decryptText(payload, secret) {
  if (!payload) return '';
  const [version, ivRaw, tagRaw, encryptedRaw] = String(payload).split(':');
  if (version !== 'v1') throw new Error('Unsupported encrypted payload');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveKey(secret),
    Buffer.from(ivRaw, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

function normalizeBasePath(basePath) {
  if (!basePath) return '/v1/responses';
  return basePath.startsWith('/') ? basePath : `/${basePath}`;
}

function publicProvider(provider, secret) {
  let apiKeyMasked = '';
  try {
    apiKeyMasked = maskKey(decryptText(provider.apiKeyEncrypted, secret));
  } catch {
    apiKeyMasked = 'invalid';
  }
  return {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol || 'https:',
    host: provider.host,
    port: provider.port || '',
    basePath: provider.basePath,
    priority: provider.priority,
    enabled: provider.enabled,
    timeoutMs: provider.timeoutMs,
    healthStatus: provider.healthStatus || 'unknown',
    lastError: provider.lastError || '',
    lastCheckedAt: provider.lastCheckedAt || '',
    models: Array.isArray(provider.models) ? provider.models : [],
    modelsUpdatedAt: provider.modelsUpdatedAt || '',
    apiKeyMasked,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt
  };
}

class ConfigStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(process.cwd(), 'data');
    this.configPath = path.join(this.dataDir, 'config.json');
    this.secret = options.secret || process.env.CODEX_PROXY_SECRET || `${process.env.USERNAME || 'local'}:${this.dataDir}`;
    this.config = null;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.configPath, 'utf8');
      this.config = { ...freshDefaultConfig(), ...JSON.parse(raw) };
      this.config.server = { ...DEFAULT_CONFIG.server, ...(this.config.server || {}) };
      this.config.providers = Array.isArray(this.config.providers) ? this.config.providers : [];
      return this.config;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const now = new Date().toISOString();
      this.config = {
        ...freshDefaultConfig(),
        createdAt: now,
        updatedAt: now
      };
      await this.save();
      return this.config;
    }
  }

  async ensureLoaded() {
    if (!this.config) await this.load();
  }

  async save() {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.config.updatedAt = new Date().toISOString();
    const payload = JSON.stringify(this.config, null, 2);
    this.writeQueue = this.writeQueue.then(() => fs.writeFile(this.configPath, payload));
    await this.writeQueue;
  }

  async getServerConfig() {
    await this.ensureLoaded();
    return { ...this.config.server };
  }

  async updateServerConfig(patch) {
    await this.ensureLoaded();
    this.config.server = { ...this.config.server, ...patch };
    await this.save();
    return this.getServerConfig();
  }

  async hasAdmin() {
    await this.ensureLoaded();
    return Boolean(this.config.admin?.username && this.config.admin?.passwordHash);
  }

  async getAdmin() {
    await this.ensureLoaded();
    return this.config.admin ? { ...this.config.admin } : null;
  }

  async setAdmin(admin) {
    await this.ensureLoaded();
    this.config.admin = { ...admin, updatedAt: new Date().toISOString() };
    await this.save();
    return this.getAdmin();
  }

  async listProviders() {
    await this.ensureLoaded();
    return this.config.providers
      .slice()
      .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
      .map((provider) => publicProvider(provider, this.secret));
  }

  async listProviderSecrets() {
    await this.ensureLoaded();
    return this.config.providers
      .slice()
      .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
      .map((provider) => ({
        ...provider,
        apiKey: decryptText(provider.apiKeyEncrypted, this.secret)
      }));
  }

  async getProviderSecret(id) {
    const providers = await this.listProviderSecrets();
    const provider = providers.find((item) => item.id === id);
    if (!provider) return null;
    return provider;
  }

  async createProvider(input) {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const provider = {
      id: input.id || crypto.randomUUID(),
      name: String(input.name || 'Provider').trim(),
      protocol: input.protocol === 'http:' ? 'http:' : 'https:',
      host: String(input.host || '').trim(),
      port: input.port ? Number(input.port) : '',
      basePath: normalizeBasePath(input.basePath),
      apiKeyEncrypted: encryptText(input.apiKey || '', this.secret),
      priority: Number(input.priority || this.config.providers.length + 1),
      enabled: input.enabled !== false,
      timeoutMs: Number(input.timeoutMs || 180000),
      healthStatus: 'unknown',
      lastError: '',
      lastCheckedAt: '',
      models: Array.isArray(input.models) ? input.models : [],
      modelsUpdatedAt: '',
      createdAt: now,
      updatedAt: now
    };
    if (!provider.host) throw new Error('Provider host is required');
    this.config.providers.push(provider);
    await this.save();
    return publicProvider(provider, this.secret);
  }

  async updateProvider(id, patch) {
    await this.ensureLoaded();
    const provider = this.config.providers.find((item) => item.id === id);
    if (!provider) return null;
    const allowed = ['name', 'protocol', 'host', 'port', 'basePath', 'priority', 'enabled', 'timeoutMs', 'healthStatus', 'lastError', 'lastCheckedAt', 'models', 'modelsUpdatedAt'];
    allowed.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(patch, key)) provider[key] = patch[key];
    });
    if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
      provider.apiKeyEncrypted = encryptText(patch.apiKey || '', this.secret);
    }
    provider.basePath = normalizeBasePath(provider.basePath);
    provider.protocol = provider.protocol === 'http:' ? 'http:' : 'https:';
    provider.port = provider.port ? Number(provider.port) : '';
    provider.priority = Number(provider.priority || 1);
    provider.enabled = provider.enabled !== false;
    provider.timeoutMs = Number(provider.timeoutMs || 180000);
    provider.updatedAt = new Date().toISOString();
    await this.save();
    return publicProvider(provider, this.secret);
  }

  async deleteProvider(id) {
    await this.ensureLoaded();
    const before = this.config.providers.length;
    this.config.providers = this.config.providers.filter((item) => item.id !== id);
    if (this.config.providers.length === before) return false;
    await this.save();
    return true;
  }
}

module.exports = {
  ConfigStore,
  decryptText,
  encryptText,
  maskKey
};
