const http = require('node:http');
const path = require('node:path');
const { AdminApi } = require('./admin-api');
const { AuthManager, hashPassword, verifyPassword } = require('./auth');
const { ConfigStore } = require('./config-store');
const { ProviderManager, errorCategory } = require('./provider-manager');
const { Telemetry } = require('./telemetry');
const { TerminalDashboard } = require('./terminal-dashboard');
const { clientIp, isLocalAddress, json, randomId } = require('./util');

function extractModel(body) {
  try {
    const payload = JSON.parse(body || '{}');
    return payload.model || payload.reasoning?.model || 'unknown';
  } catch {
    return 'unknown';
  }
}

function normalizeModelAlias(model) {
  if (typeof model !== 'string') return model;
  let normalized = model.trim().replace(/\[[^\]]+\]$/i, '');
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex > 0 && slashIndex < normalized.length - 1) {
    normalized = normalized.slice(slashIndex + 1);
  }
  return normalized;
}

function applyModelRouting(body, serverConfig = {}) {
  const currentModel = extractModel(body);
  const selectedModel = normalizeModelAlias(serverConfig.selectedModel);
  if (!serverConfig.overrideRequestModel || !selectedModel) {
    const normalizedModel = normalizeModelAlias(currentModel);
    if (normalizedModel !== currentModel) {
      try {
        const payload = JSON.parse(body || '{}');
        if (payload.model === currentModel) payload.model = normalizedModel;
        if (payload.reasoning?.model === currentModel) payload.reasoning.model = normalizedModel;
        return {
          body: JSON.stringify(payload),
          model: normalizedModel,
          originalModel: currentModel,
          overridden: true
        };
      } catch {
        return {
          body,
          model: currentModel,
          originalModel: currentModel,
          overridden: false
        };
      }
    }
    return {
      body,
      model: currentModel,
      originalModel: currentModel,
      overridden: false
    };
  }
  try {
    const payload = JSON.parse(body || '{}');
    const originalModel = payload.model || payload.reasoning?.model || currentModel;
    payload.model = selectedModel;
    return {
      body: JSON.stringify(payload),
      model: selectedModel,
      originalModel,
      overridden: originalModel !== selectedModel
    };
  } catch {
    return {
      body,
      model: currentModel,
      originalModel: currentModel,
      overridden: false
    };
  }
}

function estimateAnthropicInputTokens(body) {
  try {
    const payload = JSON.parse(body || '{}');
    const jsonText = JSON.stringify({
      system: payload.system || '',
      messages: payload.messages || [],
      tools: payload.tools || []
    });
    return Math.max(1, Math.ceil(jsonText.length / 4));
  } catch {
    return Math.max(1, Math.ceil(Buffer.byteLength(body || '', 'utf8') / 4));
  }
}

function readRawBody(req, limitBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isProxyEndpoint(pathname) {
  return [
    '/v1/responses',
    '/v1/chat/completions',
    '/v1/completions',
    '/v1/messages',
    '/v1/complete'
  ].includes(pathname);
}

function isTokenCountEndpoint(pathname) {
  return pathname === '/v1/messages/count_tokens' || pathname === '/v1/messages/count-tokens';
}

async function ensureProxyAccess(req, configStore) {
  const ip = clientIp(req);
  if (isLocalAddress(ip)) return;
  const serverConfig = await configStore.getServerConfig();
  if (!serverConfig.requireProxyTokenForLan) return;
  const expected = serverConfig.proxyAccessTokenHash;
  if (!expected) throw Object.assign(new Error('LAN proxy token is not configured'), { statusCode: 403 });
  const token = req.headers['x-proxy-token'] || '';
  if (!verifyPassword(String(token), expected)) {
    throw Object.assign(new Error('Invalid LAN proxy token'), { statusCode: 403 });
  }
}

async function createApp(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const dataDir = options.dataDir || path.join(rootDir, 'data');
  const configStore = new ConfigStore({ dataDir, secret: options.secret });
  await configStore.load();
  const telemetry = new Telemetry({ dataDir, retentionDays: 90 });
  await telemetry.init();
  const auth = new AuthManager(configStore);
  const providerManager = new ProviderManager({
    getProviders: () => configStore.listProviderSecrets()
  });
  const adminApi = new AdminApi({
    configStore,
    auth,
    telemetry,
    providerManager,
    publicDir: path.join(rootDir, 'public')
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (await adminApi.handle(req, res, url)) return;

      if (req.method === 'GET' && url.pathname === '/') {
        const providers = await configStore.listProviders();
        json(res, 200, {
          status: 'ok',
          admin: '/admin',
          compatibleEndpoints: [
            '/v1/responses',
            '/v1/chat/completions',
            '/v1/completions',
            '/v1/messages',
            '/v1/messages/count_tokens',
            '/v1/complete'
          ],
          providerCount: providers.length,
          enabledProviders: providers.filter((provider) => provider.enabled).length
        });
        return;
      }

      if (req.method === 'POST' && isTokenCountEndpoint(url.pathname)) {
        await ensureProxyAccess(req, configStore);
        const rawBody = await readRawBody(req);
        const routed = applyModelRouting(rawBody, { overrideRequestModel: false, selectedModel: '' });
        json(res, 200, {
          input_tokens: estimateAnthropicInputTokens(routed.body),
          model: routed.model,
          original_model: routed.originalModel
        });
        return;
      }

      if (req.method !== 'POST' || !isProxyEndpoint(url.pathname)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Not found' } }));
        return;
      }

      await ensureProxyAccess(req, configStore);
      const rawBody = await readRawBody(req);
      const serverConfig = await configStore.getServerConfig();
      const routed = applyModelRouting(rawBody, serverConfig);
      const body = routed.body;
      const requestId = randomId('req_');
      const startedAt = Date.now();
      const model = routed.model;
      const ip = clientIp(req);
      const bytesIn = Buffer.byteLength(body);
      const attempts = [];
      telemetry.activeStart({
        id: requestId,
        model,
        clientIp: ip,
        bytesIn
      });

      try {
        const result = await providerManager.proxyResponses({
          body,
          clientRes: res,
          upstreamPath: url.pathname + url.search,
          incomingHeaders: req.headers,
          onAttempt(provider) {
            attempts.push(provider.name);
            telemetry.activeProvider(requestId, provider.name);
          },
          onFailure(provider, error) {
            telemetry.recordSystem({
              type: 'failover',
              status: 'failed',
              provider: provider.name,
              message: error.message,
              errorCategory: errorCategory(error),
              failoverPath: attempts.slice()
            });
            configStore
              .updateProvider(provider.id, {
                healthStatus: 'down',
                lastError: error.message,
                lastCheckedAt: new Date().toISOString()
              })
              .catch(() => {});
          }
        });
        configStore
          .updateProvider(result.provider.id, {
            healthStatus: 'healthy',
            lastError: '',
            lastCheckedAt: new Date().toISOString()
          })
          .catch(() => {});
        telemetry.record({
          id: requestId,
          type: 'request',
          status: 'success',
          clientIp: ip,
          model,
          provider: result.provider.name,
          providerId: result.provider.id,
          statusCode: result.statusCode,
          originalModel: routed.originalModel,
          modelOverridden: routed.overridden,
          ttfbMs: result.ttfbMs,
          durationMs: result.durationMs || Date.now() - startedAt,
          bytesIn,
          bytesOut: result.bytesOut,
          closeReason: result.closeReason,
          retryCount: Math.max(0, result.failoverPath.length - 1),
          failoverPath: result.failoverPath
        });
      } catch (error) {
        telemetry.record({
          id: requestId,
          type: 'request',
          status: 'failed',
          clientIp: ip,
          model,
          originalModel: routed.originalModel,
          modelOverridden: routed.overridden,
          provider: attempts[attempts.length - 1] || '-',
          errorCategory: error.category || errorCategory(error),
          message: error.message,
          ttfbMs: 0,
          durationMs: Date.now() - startedAt,
          bytesIn,
          bytesOut: 0,
          closeReason: 'error',
          retryCount: Math.max(0, attempts.length - 1),
          failoverPath: attempts
        });
        if (!res.headersSent) {
          json(res, error.statusCode || 503, {
            error: {
              message: `Proxy error: ${error.message}`
            }
          });
        } else if (!res.writableEnded) {
          res.end();
        }
      } finally {
        telemetry.activeEnd(requestId);
      }
    } catch (error) {
      if (!res.headersSent) {
        json(res, error.statusCode || 500, {
          error: {
            message: error.message || 'Internal server error'
          }
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  return {
    server,
    configStore,
    telemetry,
    auth,
    providerManager
  };
}

async function start(options = {}) {
  const app = await createApp(options);
  const serverConfig = await app.configStore.getServerConfig();
  const port = Number(options.port || process.env.PORT || serverConfig.port || 1432);
  const host = options.host || process.env.HOST || serverConfig.host || '0.0.0.0';

  await new Promise((resolve) => app.server.listen(port, host, resolve));
  console.log(`Codex Proxy Hybrid Control Center running on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log(`Admin dashboard: http://localhost:${port}/admin`);

  if (options.dashboard !== false && process.stdout.isTTY) {
    const dashboard = new TerminalDashboard({
      telemetry: app.telemetry,
      configStore: app.configStore,
      port,
      server: app.server
    });
    dashboard.start();
  }

  return app;
}

module.exports = {
  applyModelRouting,
  createApp,
  estimateAnthropicInputTokens,
  hashPassword,
  normalizeModelAlias,
  start
};
