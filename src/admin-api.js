const path = require('node:path');
const fs = require('node:fs/promises');
const { json, readJson } = require('./util');

function adminHeaders() {
  return {
    'Cache-Control': 'no-store'
  };
}

function sendError(res, error) {
  json(res, error.statusCode || 500, {
    error: {
      message: error.message || 'Internal server error'
    }
  });
}

function serverSettingsView(server) {
  return {
    port: server.port,
    host: server.host,
    publicBaseUrl: server.publicBaseUrl,
    requireProxyTokenForLan: server.requireProxyTokenForLan,
    proxyAccessTokenConfigured: Boolean(server.proxyAccessTokenHash),
    selectedProviderId: server.selectedProviderId,
    selectedModel: server.selectedModel,
    overrideRequestModel: server.overrideRequestModel,
    modelRoutes: Array.isArray(server.modelRoutes) ? server.modelRoutes : []
  };
}

function sanitizeModelRoutes(routes) {
  if (!Array.isArray(routes)) return [];
  return routes
    .filter((route) => route && typeof route === 'object')
    .map((route) => ({
      pattern: String(route.pattern || '').trim().slice(0, 200),
      providerId: String(route.providerId || '').trim()
    }))
    .filter((route) => route.pattern && route.providerId)
    .slice(0, 50);
}

function routeMatch(pathname, pattern) {
  const left = pathname.split('/').filter(Boolean);
  const right = pattern.split('/').filter(Boolean);
  if (left.length !== right.length) return null;
  const params = {};
  for (let i = 0; i < right.length; i++) {
    if (right[i].startsWith(':')) {
      params[right[i].slice(1)] = left[i];
    } else if (left[i] !== right[i]) {
      return null;
    }
  }
  return params;
}

class AdminApi {
  constructor({ configStore, auth, telemetry, providerManager, publicDir }) {
    this.configStore = configStore;
    this.auth = auth;
    this.telemetry = telemetry;
    this.providerManager = providerManager;
    this.publicDir = publicDir || path.join(process.cwd(), 'public');
  }

  async handle(req, res, url) {
    try {
      if (url.pathname === '/admin' || url.pathname === '/admin/') {
        await this.serveAdmin(res);
        return true;
      }
      if (url.pathname.startsWith('/assets/')) {
        await this.serveAsset(req, res, url.pathname);
        return true;
      }
      if (!url.pathname.startsWith('/api/admin/')) return false;
      await this.handleApi(req, res, url);
      return true;
    } catch (error) {
      sendError(res, error);
      return true;
    }
  }

  async serveAdmin(res) {
    const file = path.join(this.publicDir, 'admin.html');
    const body = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': body.length
    });
    res.end(body);
  }

  async serveAsset(req, res, pathname) {
    const safePath = path.normalize(pathname.replace(/^\/assets\//, '')).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(this.publicDir, 'assets', safePath);
    const body = await fs.readFile(file);
    const type = file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Content-Length': body.length
    });
    res.end(body);
  }

  async handleApi(req, res, url) {
    const method = req.method || 'GET';
    if (method === 'GET' && url.pathname === '/api/admin/me') {
      json(res, 200, await this.auth.me(req), adminHeaders());
      return;
    }

    if (method === 'POST' && url.pathname === '/api/admin/setup') {
      const body = await readJson(req);
      await this.auth.setup(body.username, body.password);
      const token = await this.auth.login(body.username, body.password);
      json(res, 200, { ok: true }, { ...adminHeaders(), 'Set-Cookie': this.auth.cookie(token) });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/admin/login') {
      const body = await readJson(req);
      const token = await this.auth.login(body.username, body.password);
      json(res, 200, { ok: true }, { ...adminHeaders(), 'Set-Cookie': this.auth.cookie(token) });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/admin/logout') {
      const session = this.auth.sessionFromReq(req);
      this.auth.logout(session?.token);
      json(res, 200, { ok: true }, { ...adminHeaders(), 'Set-Cookie': this.auth.clearCookie() });
      return;
    }

    this.auth.requireAdmin(req);

    if (method === 'GET' && url.pathname === '/api/admin/providers') {
      json(res, 200, { providers: await this.configStore.listProviders() }, adminHeaders());
      return;
    }

    if (method === 'GET' && url.pathname === '/api/admin/settings') {
      const server = await this.configStore.getServerConfig();
      json(res, 200, { server: serverSettingsView(server) }, adminHeaders());
      return;
    }

    if (method === 'PATCH' && url.pathname === '/api/admin/settings') {
      const body = await readJson(req);
      const patch = {
        requireProxyTokenForLan: body.requireProxyTokenForLan !== false
      };
      if (Object.prototype.hasOwnProperty.call(body, 'selectedProviderId')) {
        patch.selectedProviderId = body.selectedProviderId || '';
      }
      if (Object.prototype.hasOwnProperty.call(body, 'selectedModel')) {
        patch.selectedModel = body.selectedModel || '';
      }
      if (Object.prototype.hasOwnProperty.call(body, 'overrideRequestModel')) {
        patch.overrideRequestModel = body.overrideRequestModel === true;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'modelRoutes')) {
        patch.modelRoutes = sanitizeModelRoutes(body.modelRoutes);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'proxyAccessToken') && body.proxyAccessToken) {
        const { hashPassword } = require('./auth');
        patch.proxyAccessTokenHash = hashPassword(body.proxyAccessToken);
      }
      const server = await this.configStore.updateServerConfig(patch);
      json(res, 200, { server: serverSettingsView(server) }, adminHeaders());
      return;
    }

    if (method === 'POST' && url.pathname === '/api/admin/providers') {
      const body = await readJson(req);
      const provider = await this.configStore.createProvider(body);
      json(res, 201, { provider }, adminHeaders());
      return;
    }

    const providerPatch = routeMatch(url.pathname, '/api/admin/providers/:id');
    if (providerPatch && method === 'PATCH') {
      const body = await readJson(req);
      const provider = await this.configStore.updateProvider(providerPatch.id, body);
      if (!provider) throw Object.assign(new Error('Provider not found'), { statusCode: 404 });
      json(res, 200, { provider }, adminHeaders());
      return;
    }

    if (providerPatch && method === 'DELETE') {
      const deleted = await this.configStore.deleteProvider(providerPatch.id);
      if (!deleted) throw Object.assign(new Error('Provider not found'), { statusCode: 404 });
      json(res, 200, { ok: true }, adminHeaders());
      return;
    }

    const providerTest = routeMatch(url.pathname, '/api/admin/providers/:id/test');
    if (providerTest && method === 'POST') {
      const provider = await this.configStore.getProviderSecret(providerTest.id);
      if (!provider) throw Object.assign(new Error('Provider not found'), { statusCode: 404 });
      const missing = [];
      if (!provider.host) missing.push('host');
      if (!provider.basePath) missing.push('basePath');
      if (!provider.apiKey) missing.push('apiKey');
      if (missing.length) {
        json(res, 200, {
          ok: false,
          syntheticRequestSent: false,
          error: `Missing provider config: ${missing.join(', ')}`
        }, adminHeaders());
        return;
      }
      const updated = await this.configStore.updateProvider(provider.id, {
        healthStatus: 'unknown',
        lastError: '',
        lastCheckedAt: new Date().toISOString()
      });
      json(res, 200, {
        ok: true,
        syntheticRequestSent: false,
        provider: updated,
        message: 'Config looks complete. Provider health will be updated by real Codex traffic.'
      }, adminHeaders());
      return;
    }

    const providerModels = routeMatch(url.pathname, '/api/admin/providers/:id/models');
    if (providerModels && method === 'GET') {
      const provider = await this.configStore.getProviderSecret(providerModels.id);
      if (!provider) throw Object.assign(new Error('Provider not found'), { statusCode: 404 });
      try {
        const models = await this.providerManager.listModels(provider);
        const updated = await this.configStore.updateProvider(provider.id, {
          models,
          modelsUpdatedAt: new Date().toISOString()
        });
        json(res, 200, {
          ok: true,
          models,
          provider: updated
        }, adminHeaders());
      } catch (error) {
        json(res, 200, {
          ok: false,
          models: provider.models || [],
          error: error.message
        }, adminHeaders());
      }
      return;
    }

    if (method === 'GET' && url.pathname === '/api/admin/metrics/live') {
      json(res, 200, this.telemetry.liveMetrics(), adminHeaders());
      return;
    }

    if (method === 'GET' && url.pathname === '/api/admin/metrics/history') {
      json(res, 200, await this.telemetry.history(url.searchParams.get('range') || '24h'), adminHeaders());
      return;
    }

    if (method === 'GET' && url.pathname === '/api/admin/requests') {
      json(
        res,
        200,
        {
          requests: await this.telemetry.requests({
            range: url.searchParams.get('range') || '24h',
            provider: url.searchParams.get('provider') || '',
            model: url.searchParams.get('model') || '',
            status: url.searchParams.get('status') || ''
          })
        },
        adminHeaders()
      );
      return;
    }

    if (method === 'GET' && url.pathname === '/api/admin/inject') {
      const { listTools } = require('./injector');
      json(res, 200, { tools: await listTools() }, adminHeaders());
      return;
    }

    const injectMatch = routeMatch(url.pathname, '/api/admin/inject/:toolId');
    if (injectMatch && method === 'POST') {
      const { injectTool } = require('./injector');
      const serverConfig = await this.configStore.getServerConfig();
      const port = serverConfig.port || 1432;
      const result = await injectTool(injectMatch.toolId, '127.0.0.1', port);
      json(res, 200, result, adminHeaders());
      return;
    }
    if (injectMatch && method === 'DELETE') {
      const { ejectTool } = require('./injector');
      const result = await ejectTool(injectMatch.toolId);
      json(res, 200, result, adminHeaders());
      return;
    }

    if (method === 'GET' && url.pathname === '/api/admin/events/stream') {
      this.handleSse(req, res);
      return;
    }

    throw Object.assign(new Error('Not found'), { statusCode: 404 });
  }

  handleSse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    const send = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    send({ type: 'hello', live: this.telemetry.liveMetrics() });
    const listener = (event) => send(event);
    this.telemetry.on('update', listener);
    req.on('close', () => {
      this.telemetry.off('update', listener);
    });
  }
}

module.exports = {
  AdminApi
};
