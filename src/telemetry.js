const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { nowIso } = require('./util');

const RANGE_MS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000
};

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] || 0;
}

function dayStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

class Telemetry extends EventEmitter {
  constructor(options = {}) {
    super();
    this.dataDir = options.dataDir || path.join(process.cwd(), 'data');
    this.eventsDir = path.join(this.dataDir, 'events');
    this.retentionDays = options.retentionDays || 90;
    this.startedAt = Date.now();
    this.liveEvents = [];
    this.active = new Map();
    this.maxLiveEvents = 5000;
    this.queue = Promise.resolve();
    this.writeFailures = 0;
  }

  async init() {
    await fs.mkdir(this.eventsDir, { recursive: true });
    this.pruneOldFiles().catch(() => {});
  }

  activeStart(event) {
    const enriched = {
      id: event.id,
      startedAt: nowIso(),
      model: event.model || 'unknown',
      provider: event.provider || '',
      clientIp: event.clientIp || '',
      bytesIn: event.bytesIn || 0
    };
    this.active.set(event.id, enriched);
    this.emit('update', { type: 'active:start', event: enriched });
  }

  activeEnd(id) {
    this.active.delete(id);
    this.emit('update', { type: 'active:end', id });
  }

  activeProvider(id, provider) {
    const current = this.active.get(id);
    if (!current) return;
    current.provider = provider;
    this.emit('update', { type: 'active:provider', id, provider });
  }

  record(event) {
    const enriched = {
      timestamp: nowIso(),
      ...event
    };
    this.liveEvents.push(enriched);
    if (this.liveEvents.length > this.maxLiveEvents) this.liveEvents.shift();
    this.emit('update', { type: 'request', event: enriched, live: this.liveMetrics() });

    const file = path.join(this.eventsDir, `${dayStamp(new Date(enriched.timestamp))}.jsonl`);
    const line = `${JSON.stringify(enriched)}\n`;
    this.queue = this.queue
      .then(() => fs.appendFile(file, line))
      .catch(() => {
        this.writeFailures++;
      });
  }

  recordSystem(event) {
    this.record({
      id: event.id || `sys-${Date.now()}`,
      type: event.type || 'system',
      status: event.status || 'info',
      model: '-',
      provider: event.provider || '-',
      message: event.message || '',
      errorCategory: event.errorCategory || '',
      durationMs: 0,
      ttfbMs: 0,
      bytesIn: 0,
      bytesOut: 0,
      retryCount: 0,
      failoverPath: event.failoverPath || []
    });
  }

  liveMetrics() {
    const events = this.liveEvents.filter((event) => event.type !== 'system');
    const ok = events.filter((event) => event.status === 'success');
    const failed = events.filter((event) => event.status === 'failed');
    const latencies = ok.map((event) => Number(event.durationMs || 0)).filter(Boolean);
    const bytesOut = events.reduce((sum, event) => sum + Number(event.bytesOut || 0), 0);
    const bytesIn = events.reduce((sum, event) => sum + Number(event.bytesIn || 0), 0);
    const last = this.liveEvents[this.liveEvents.length - 1] || null;
    return {
      uptimeMs: Date.now() - this.startedAt,
      totalRequests: events.length,
      successRequests: ok.length,
      failedRequests: failed.length,
      activeRequests: this.active.size,
      avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      p95LatencyMs: percentile(latencies, 95),
      p99LatencyMs: percentile(latencies, 99),
      totalBytesIn: bytesIn,
      totalBytesOut: bytesOut,
      lastModel: last?.model || '-',
      lastProvider: last?.provider || '-',
      writeFailures: this.writeFailures,
      active: Array.from(this.active.values()),
      recentEvents: this.liveEvents.slice(-80).reverse(),
      latencySeries: ok.slice(-80).map((event) => ({
        timestamp: event.timestamp,
        value: Number(event.durationMs || 0),
        provider: event.provider
      })),
      throughputSeries: events.slice(-80).map((event) => ({
        timestamp: event.timestamp,
        value: Number(event.bytesOut || 0)
      }))
    };
  }

  async history(range = '24h') {
    const cutoff = Date.now() - (RANGE_MS[range] || RANGE_MS['24h']);
    const events = await this.readEventsSince(cutoff);
    return this.aggregate(events);
  }

  async requests(filters = {}) {
    const range = filters.range || '24h';
    const cutoff = Date.now() - (RANGE_MS[range] || RANGE_MS['24h']);
    let events = await this.readEventsSince(cutoff);
    events = events.filter((event) => event.type !== 'system');
    if (filters.provider) events = events.filter((event) => event.provider === filters.provider);
    if (filters.model) events = events.filter((event) => event.model === filters.model);
    if (filters.status) events = events.filter((event) => event.status === filters.status);
    return events.slice(-500).reverse();
  }

  aggregate(events) {
    const requestEvents = events.filter((event) => event.type !== 'system');
    const latencies = requestEvents
      .filter((event) => event.status === 'success')
      .map((event) => Number(event.durationMs || 0))
      .filter(Boolean);
    const buckets = new Map();
    requestEvents.forEach((event) => {
      const minute = new Date(event.timestamp);
      minute.setSeconds(0, 0);
      const key = minute.toISOString();
      const current = buckets.get(key) || {
        timestamp: key,
        requests: 0,
        failed: 0,
        bytesOut: 0,
        latencyTotal: 0,
        latencyCount: 0
      };
      current.requests++;
      if (event.status === 'failed') current.failed++;
      current.bytesOut += Number(event.bytesOut || 0);
      if (event.durationMs) {
        current.latencyTotal += Number(event.durationMs);
        current.latencyCount++;
      }
      buckets.set(key, current);
    });

    return {
      totalRequests: requestEvents.length,
      successRequests: requestEvents.filter((event) => event.status === 'success').length,
      failedRequests: requestEvents.filter((event) => event.status === 'failed').length,
      avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      p95LatencyMs: percentile(latencies, 95),
      p99LatencyMs: percentile(latencies, 99),
      totalBytesOut: requestEvents.reduce((sum, event) => sum + Number(event.bytesOut || 0), 0),
      buckets: Array.from(buckets.values()).map((bucket) => ({
        timestamp: bucket.timestamp,
        requests: bucket.requests,
        failed: bucket.failed,
        bytesOut: bucket.bytesOut,
        avgLatencyMs: bucket.latencyCount ? Math.round(bucket.latencyTotal / bucket.latencyCount) : 0
      }))
    };
  }

  async readEventsSince(cutoff) {
    await fs.mkdir(this.eventsDir, { recursive: true });
    const files = await fs.readdir(this.eventsDir).catch(() => []);
    const events = [];
    for (const file of files.filter((name) => name.endsWith('.jsonl')).sort()) {
      const date = Date.parse(file.replace('.jsonl', 'T23:59:59.999Z'));
      if (Number.isFinite(date) && date < cutoff) continue;
      const raw = await fs.readFile(path.join(this.eventsDir, file), 'utf8').catch(() => '');
      raw.split(/\r?\n/).forEach((line) => {
        if (!line) return;
        try {
          const event = JSON.parse(line);
          if (Date.parse(event.timestamp) >= cutoff) events.push(event);
        } catch {}
      });
    }
    return events;
  }

  async pruneOldFiles() {
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    const files = await fs.readdir(this.eventsDir).catch(() => []);
    await Promise.all(
      files.map(async (file) => {
        if (!file.endsWith('.jsonl')) return;
        const date = Date.parse(file.replace('.jsonl', 'T00:00:00.000Z'));
        if (Number.isFinite(date) && date < cutoff) {
          await fs.unlink(path.join(this.eventsDir, file)).catch(() => {});
        }
      })
    );
  }
}

module.exports = {
  Telemetry,
  percentile
};
