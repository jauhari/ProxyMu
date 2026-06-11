const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createApp } = require('../src/server');

function listen(server, port = 0) {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 500);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

function requestJson({ port, path, method = 'GET', body, cookie }) {
  return new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : '';
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(raw ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : {}),
          ...(cookie ? { Cookie: cookie } : {})
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = {};
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            parsed = {};
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            text,
            json: parsed
          });
        });
      }
    );
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

test('admin-created HTTP provider can proxy a streaming Responses request and records telemetry', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-proxy-e2e-'));
  const upstream = http.createServer((req, res) => {
    if (req.url !== '/v1/responses') {
      res.writeHead(404);
      res.end();
      return;
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"delta":"ok"}\n\n');
      res.end();
    });
  });
  const upstreamPort = await listen(upstream);
  const app = await createApp({ dataDir, dashboard: false, secret: 'e2e-secret' });
  const appPort = await listen(app.server);

  try {
    const setup = await requestJson({
      port: appPort,
      path: '/api/admin/setup',
      method: 'POST',
      body: { username: 'admin', password: 'password123' }
    });
    const cookie = setup.headers['set-cookie'][0].split(';')[0];
    const provider = await requestJson({
      port: appPort,
      path: '/api/admin/providers',
      method: 'POST',
      cookie,
      body: {
        name: 'Local HTTP',
        protocol: 'http:',
        host: '127.0.0.1',
        port: upstreamPort,
        basePath: '/v1/responses',
        apiKey: 'sk-test-local',
        priority: 1,
        enabled: true,
        timeoutMs: 1000
      }
    });

    assert.equal(provider.statusCode, 201);
    assert.equal(provider.json.provider.apiKeyMasked, 'sk-...ocal');

    const proxied = await requestJson({
      port: appPort,
      path: '/v1/responses',
      method: 'POST',
      body: { model: 'demo-model', input: 'hi', stream: true }
    });
    assert.equal(proxied.statusCode, 200);
    assert.equal(proxied.text.includes('"delta":"ok"'), true);

    const requests = await requestJson({
      port: appPort,
      path: '/api/admin/requests?range=1h',
      cookie
    });
    assert.equal(requests.statusCode, 200);
    assert.equal(requests.json.requests[0].model, 'demo-model');
    assert.equal(requests.json.requests[0].provider, 'Local HTTP');
  } finally {
    app.server.closeAllConnections?.();
    upstream.closeAllConnections?.();
    app.providerManager.close();
    await close(app.server);
    await close(upstream);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('provider validation does not send a synthetic model request upstream', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-proxy-no-synthetic-test-'));
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits++;
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"delta":"unexpected"}\n\n');
  });
  const upstreamPort = await listen(upstream);
  const app = await createApp({ dataDir, dashboard: false, secret: 'no-synthetic-secret' });
  const appPort = await listen(app.server);

  try {
    const setup = await requestJson({
      port: appPort,
      path: '/api/admin/setup',
      method: 'POST',
      body: { username: 'admin', password: 'password123' }
    });
    const cookie = setup.headers['set-cookie'][0].split(';')[0];
    const provider = await requestJson({
      port: appPort,
      path: '/api/admin/providers',
      method: 'POST',
      cookie,
      body: {
        name: 'Local HTTP',
        protocol: 'http:',
        host: '127.0.0.1',
        port: upstreamPort,
        basePath: '/v1/responses',
        apiKey: 'sk-test-local',
        priority: 1,
        enabled: true,
        timeoutMs: 1000
      }
    });

    const validation = await requestJson({
      port: appPort,
      path: `/api/admin/providers/${provider.json.provider.id}/test`,
      method: 'POST',
      cookie,
      body: {}
    });

    assert.equal(validation.statusCode, 200, validation.text);
    assert.equal(validation.json.ok, true);
    assert.equal(validation.json.syntheticRequestSent, false);
    assert.equal(upstreamHits, 0);
  } finally {
    app.server.closeAllConnections?.();
    upstream.closeAllConnections?.();
    app.providerManager.close();
    await close(app.server);
    await close(upstream);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('admin can load available models and save selected model routing', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-proxy-models-'));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-5.4' }, { id: 'gpt-4.1-mini' }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const app = await createApp({ dataDir, dashboard: false, secret: 'models-secret' });
  const appPort = await listen(app.server);

  try {
    const setup = await requestJson({
      port: appPort,
      path: '/api/admin/setup',
      method: 'POST',
      body: { username: 'admin', password: 'password123' }
    });
    const cookie = setup.headers['set-cookie'][0].split(';')[0];
    const provider = await requestJson({
      port: appPort,
      path: '/api/admin/providers',
      method: 'POST',
      cookie,
      body: {
        name: 'Local HTTP',
        protocol: 'http:',
        host: '127.0.0.1',
        port: upstreamPort,
        basePath: '/v1/responses',
        apiKey: 'sk-test-local',
        priority: 1,
        enabled: true,
        timeoutMs: 1000
      }
    });

    const models = await requestJson({
      port: appPort,
      path: `/api/admin/providers/${provider.json.provider.id}/models`,
      cookie
    });
    assert.deepEqual(models.json.models, ['gpt-4.1-mini', 'gpt-5.4']);

    const saved = await requestJson({
      port: appPort,
      path: '/api/admin/settings',
      method: 'PATCH',
      cookie,
      body: {
        selectedProviderId: provider.json.provider.id,
        selectedModel: 'gpt-5.4',
        overrideRequestModel: true,
        requireProxyTokenForLan: true
      }
    });
    assert.equal(saved.json.server.selectedModel, 'gpt-5.4');
    assert.equal(saved.json.server.overrideRequestModel, true);
  } finally {
    app.server.closeAllConnections?.();
    upstream.closeAllConnections?.();
    app.providerManager.close();
    await close(app.server);
    await close(upstream);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('Claude count_tokens compatibility endpoint returns local estimate', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-proxy-count-tokens-'));
  const app = await createApp({ dataDir, dashboard: false, secret: 'count-token-secret' });
  const appPort = await listen(app.server);

  try {
    const result = await requestJson({
      port: appPort,
      path: '/v1/messages/count_tokens',
      method: 'POST',
      body: {
        model: 'gpt-5.5[1m]',
        system: 'You are concise.',
        messages: [
          {
            role: 'user',
            content: 'hello world'
          }
        ]
      }
    });

    assert.equal(result.statusCode, 200, result.text);
    assert.equal(typeof result.json.input_tokens, 'number');
    assert.equal(result.json.input_tokens > 0, true);
    assert.equal(result.json.model, 'gpt-5.5');
    assert.equal(result.json.original_model, 'gpt-5.5[1m]');
  } finally {
    app.server.closeAllConnections?.();
    app.providerManager.close();
    await close(app.server);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
