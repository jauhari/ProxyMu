const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ConfigStore, maskKey } = require('../src/config-store');

test('ConfigStore encrypts provider keys and returns masked providers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-proxy-config-'));
  const store = new ConfigStore({ dataDir: dir, secret: 'test-secret' });

  const provider = await store.createProvider({
    name: 'Primary',
    host: 'api.example.test',
    basePath: '/v1/responses',
    apiKey: 'sk-test-1234567890',
    priority: 1,
    enabled: true,
    timeoutMs: 1200
  });

  const raw = await fs.readFile(path.join(dir, 'config.json'), 'utf8');
  assert.equal(raw.includes('sk-test-1234567890'), false);

  const masked = await store.listProviders();
  assert.equal(masked[0].id, provider.id);
  assert.equal(masked[0].apiKeyMasked, 'sk-...7890');
  assert.equal(masked[0].apiKeyEncrypted, undefined);

  const full = await store.getProviderSecret(provider.id);
  assert.equal(full.apiKey, 'sk-test-1234567890');
});

test('maskKey hides short and empty secrets safely', () => {
  assert.equal(maskKey(''), '');
  assert.equal(maskKey('abc'), '***');
  assert.equal(maskKey('sk-abcdef'), 'sk-...cdef');
});
