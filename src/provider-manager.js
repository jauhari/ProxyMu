const http = require('node:http');
const https = require('node:https');

class CircuitBreaker {
  constructor({ cooldownMs = 30000 } = {}) {
    this.cooldownMs = cooldownMs;
    this._open = new Map(); // providerId -> reopensAt timestamp
  }

  isOpen(id) {
    const t = this._open.get(id);
    if (t === undefined) return false;
    if (Date.now() >= t) { this._open.delete(id); return false; }
    return true;
  }

  trip(id) {
    this._open.set(id, Date.now() + this.cooldownMs);
  }

  reset(id) {
    this._open.delete(id);
  }
}

function errorCategory(error) {
  const message = String(error?.message || error || '');
  if (message.includes('Timeout')) return 'timeout';
  if (/^\[\d{3}\]/.test(message)) return 'upstream_http';
  if (/ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(message)) return 'network';
  return 'unknown';
}

class ProviderManager {
  constructor(options) {
    this.getProviders = options.getProviders;
    this.circuit = new CircuitBreaker({ cooldownMs: options.circuitCooldownMs || 30000 });
    this._healthTimer = null;
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 100,
      family: 4
    });
    this.httpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 100,
      family: 4
    });
  }

  async enabledProviders() {
    const providers = await this.getProviders();
    const sorted = providers
      .filter((provider) => provider.enabled !== false)
      .sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0));
    // Skip circuit-open providers; fall back to full list if all are open
    const available = sorted.filter((p) => !this.circuit.isOpen(p.id));
    return available.length > 0 ? available : sorted;
  }

  async proxyResponses({ body, clientRes, onAttempt, onFailure, upstreamPath, incomingHeaders, preferredProviderId }) {
    let providers = await this.enabledProviders();
    if (!providers.length) throw Object.assign(new Error('No enabled providers configured'), { category: 'config' });
    if (preferredProviderId) {
      const preferred = providers.filter((p) => p.id === preferredProviderId);
      providers = [...preferred, ...providers.filter((p) => p.id !== preferredProviderId)];
    }

    const failoverPath = [];
    const failures = [];

    for (const provider of providers) {
      failoverPath.push(provider.id);
      if (onAttempt) onAttempt(provider);
      try {
        const result = await this.tryProvider(provider, body, clientRes, { upstreamPath, incomingHeaders });
        this.circuit.reset(provider.id);
        return {
          ...result,
          provider,
          failoverPath
        };
      } catch (error) {
        this.circuit.trip(provider.id);
        failures.push({ provider, error });
        if (onFailure) onFailure(provider, error);
        if (clientRes.headersSent) throw error;
      }
    }

    const last = failures[failures.length - 1];
    const message = failures
      .map((item) => `${item.provider.name}: ${item.error.message}`)
      .join(' | ');
    throw Object.assign(new Error(message || 'All providers failed'), {
      category: errorCategory(last?.error),
      failures,
      failoverPath
    });
  }

  tryProvider(provider, bodyStr, clientRes, options = {}) {
    return new Promise((resolve, reject) => {
      const data = Buffer.from(bodyStr || '', 'utf8');
      const protocol = provider.protocol || 'https:';
      const transport = protocol === 'http:' ? http : https;
      const agent = protocol === 'http:' ? this.httpAgent : this.httpsAgent;
      const startedAt = Date.now();
      let ttfbMs = 0;
      let bytesOut = 0;
      let resolved = false;

      // Short connect timeout (time-to-first-byte); longer stream timeout is handled
      // by the upstream being active — data flow keeps the socket alive.
      const streamTimeoutMs = Number(provider.timeoutMs || 180000);
      const connectTimeoutMs = Math.min(Number(provider.connectTimeoutMs || 5000), streamTimeoutMs);

      const upstreamPath = options.upstreamPath || provider.basePath || '/v1/responses';
      const isAnthropicPath = /\/messages(?:$|\?)/.test(upstreamPath);
      const incomingHeaders = options.incomingHeaders || {};
      const headers = {
        'Content-Type': incomingHeaders['content-type'] || 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Length': data.length,
        Accept: incomingHeaders.accept || 'text/event-stream, application/json'
      };
      if (isAnthropicPath) {
        headers['x-api-key'] = provider.apiKey;
        headers['anthropic-version'] = incomingHeaders['anthropic-version'] || '2023-06-01';
        if (incomingHeaders['anthropic-beta']) headers['anthropic-beta'] = incomingHeaders['anthropic-beta'];
      }

      const req = transport.request(
        {
          protocol,
          hostname: provider.host,
          port: provider.port,
          path: upstreamPath,
          method: 'POST',
          agent,
          headers
        },
        (upstream) => {
          req.setTimeout(0); // response started — disable connect timeout
          ttfbMs = Date.now() - startedAt;

          if (upstream.statusCode >= 400) {
            let err = '';
            upstream.on('data', (chunk) => {
              err += chunk;
            });
            upstream.on('end', () => {
              reject(new Error(`[${upstream.statusCode}] ${err.slice(0, 300)}`));
            });
            return;
          }

          clientRes.writeHead(upstream.statusCode, {
            'Content-Type': upstream.headers['content-type'] || 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          });

          upstream.on('data', (chunk) => {
            bytesOut += chunk.length;
            if (!clientRes.writableEnded) clientRes.write(chunk);
          });

          upstream.on('end', () => {
            if (!clientRes.writableEnded) clientRes.end();
            resolved = true;
            resolve({
              statusCode: upstream.statusCode,
              contentType: upstream.headers['content-type'] || '',
              ttfbMs,
              durationMs: Date.now() - startedAt,
              bytesOut,
              closeReason: 'end'
            });
          });

          upstream.on('close', () => {
            if (!resolved) {
              resolved = true;
              resolve({
                statusCode: upstream.statusCode,
                contentType: upstream.headers['content-type'] || '',
                ttfbMs,
                durationMs: Date.now() - startedAt,
                bytesOut,
                closeReason: 'close'
              });
            }
          });

          upstream.on('error', (error) => {
            if (!clientRes.writableEnded) clientRes.end();
            reject(error);
          });
        }
      );

      req.on('error', reject);
      req.setTimeout(connectTimeoutMs, () => {
        req.destroy(Object.assign(new Error(`Connect timeout ${connectTimeoutMs}ms`), { connectTimeout: true }));
      });
      req.write(data);
      req.end();
    });
  }

  async listModels(provider, { timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const effectiveTimeout = Number(timeoutMs || provider.timeoutMs || 180000);
      const protocol = provider.protocol || 'https:';
      const transport = protocol === 'http:' ? http : https;
      const agent = protocol === 'http:' ? this.httpAgent : this.httpsAgent;
      const basePath = provider.basePath || '/v1/responses';
      const modelsPath = basePath.includes('/responses')
        ? basePath.replace(/\/responses.*$/, '/models')
        : '/v1/models';

      const req = transport.request(
        {
          protocol,
          hostname: provider.host,
          port: provider.port,
          path: modelsPath,
          method: 'GET',
          agent,
          headers: {
            Authorization: `Bearer ${provider.apiKey}`,
            Accept: 'application/json'
          }
        },
        (upstream) => {
          let body = '';
          upstream.setEncoding('utf8');
          upstream.on('data', (chunk) => {
            body += chunk;
          });
          upstream.on('end', () => {
            if (upstream.statusCode >= 400) {
              reject(new Error(`[${upstream.statusCode}] ${body.slice(0, 300)}`));
              return;
            }
            try {
              const payload = JSON.parse(body || '{}');
              const source = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
              const models = source
                .map((item) => (typeof item === 'string' ? item : item.id || item.name))
                .filter(Boolean)
                .sort();
              resolve(models);
            } catch (error) {
              reject(new Error(`Invalid models response: ${error.message}`));
            }
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(effectiveTimeout, () => {
        req.destroy(new Error(`Timeout ${effectiveTimeout}ms`));
      });
      req.end();
    });
  }

  startHealthChecks({ configStore, intervalMs = 60000, checkTimeoutMs = 10000 } = {}) {
    if (this._healthTimer) return;
    const runChecks = async () => {
      let providers;
      try {
        providers = await this.getProviders();
      } catch {
        return;
      }
      for (const p of providers.filter((p) => p.enabled !== false)) {
        try {
          await this.listModels(p, { timeoutMs: checkTimeoutMs });
          this.circuit.reset(p.id);
          if (configStore) {
            configStore.updateProvider(p.id, {
              healthStatus: 'healthy',
              lastError: '',
              lastCheckedAt: new Date().toISOString()
            }).catch(() => {});
          }
        } catch (err) {
          this.circuit.trip(p.id);
          if (configStore) {
            configStore.updateProvider(p.id, {
              healthStatus: 'down',
              lastError: err.message,
              lastCheckedAt: new Date().toISOString()
            }).catch(() => {});
          }
        }
      }
    };
    // Pre-warm: run immediately to establish TLS sessions and seed health status
    runChecks().catch(() => {});
    this._healthTimer = setInterval(runChecks, intervalMs);
    if (this._healthTimer.unref) this._healthTimer.unref();
  }

  stopHealthChecks() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }

  close() {
    this.stopHealthChecks();
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}

module.exports = {
  ProviderManager,
  errorCategory
};
