const blessed = require('blessed');

function formatUptime(ms) {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h ${m}m ${s}s`;
}

function sparkline(values) {
  if (!values.length) return 'No latency samples yet';
  const blocks = ['_', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const max = Math.max(...values, 1);
  return values
    .slice(-80)
    .map((value) => blocks[Math.max(0, Math.min(blocks.length - 1, Math.round((value / max) * (blocks.length - 1))))])
    .join('');
}

class TerminalDashboard {
  constructor({ telemetry, configStore, port, server }) {
    this.telemetry = telemetry;
    this.configStore = configStore;
    this.port = port;
    this.server = server;
    this.screen = null;
  }

  start() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Codex Proxy Hybrid Control Center'
    });

    const infoBox = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '42%',
      height: '30%',
      label: ' Proxy ',
      border: 'line',
      tags: true
    });
    const providerBox = blessed.box({
      parent: this.screen,
      top: 0,
      left: '42%',
      width: '58%',
      height: '30%',
      label: ' Providers ',
      border: 'line',
      tags: true
    });
    const latencyBox = blessed.box({
      parent: this.screen,
      top: '30%',
      left: 0,
      width: '100%',
      height: '28%',
      label: ' Latency (ms) ',
      border: 'line',
      tags: true
    });
    const logBox = blessed.log({
      parent: this.screen,
      top: '58%',
      left: 0,
      width: '100%',
      height: '42%-1',
      label: ' Activity ',
      border: 'line',
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      tags: true
    });

    this.screen.key(['q', 'C-c'], () => process.exit(0));
    this.screen.key(['x'], () => {
      logBox.log('{red-fg}Shutdown requested...{/red-fg}');
      this.server.close(() => process.exit(0));
    });
    this.screen.key(['h'], () => {
      const help = blessed.message({
        parent: this.screen,
        border: 'line',
        width: '60%',
        height: '50%',
        top: 'center',
        left: 'center',
        label: ' Help ',
        tags: true
      });
      help.display('Q/Ctrl+C Quit\nX Shutdown proxy\nH Help\n\nWeb dashboard: /admin', 0, () => {});
    });

    blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: true,
      content: ' [Q] Quit  [X] Shutdown  [H] Help  Web: /admin '
    });

    this.telemetry.on('update', (event) => {
      if (event.type === 'request') {
        const status = event.event.status === 'success' ? 'green' : 'red';
        logBox.log(`{${status}-fg}${event.event.timestamp} ${event.event.status} ${event.event.model} ${event.event.provider} ${event.event.durationMs || 0}ms{/}`);
      }
    });

    setInterval(async () => {
      const live = this.telemetry.liveMetrics();
      const providers = await this.configStore.listProviders().catch(() => []);
      infoBox.setContent(
        `{green-fg}Status{/green-fg}: ONLINE\n` +
          `{green-fg}Port{/green-fg}: ${this.port}\n` +
          `{green-fg}Uptime{/green-fg}: ${formatUptime(live.uptimeMs)}\n\n` +
          `{yellow-fg}Requests{/yellow-fg}: ${live.totalRequests}\n` +
          `{green-fg}Success{/green-fg}: ${live.successRequests}\n` +
          `{red-fg}Failed{/red-fg}: ${live.failedRequests}\n` +
          `{cyan-fg}Active{/cyan-fg}: ${live.activeRequests}\n` +
          `P95/P99: ${live.p95LatencyMs}/${live.p99LatencyMs}ms\n` +
          `Stream: ${(live.totalBytesOut / 1024 / 1024).toFixed(2)} MB`
      );
      providerBox.setContent(
        providers.length
          ? providers
              .map((provider) => {
                const color = provider.enabled ? 'green' : 'red';
                return `{${color}-fg}${provider.priority}. ${provider.name}{/} ${provider.host} ${provider.healthStatus}`;
              })
              .join('\n')
          : '{red-fg}No providers configured. Open /admin to add one.{/red-fg}'
      );
      latencyBox.setContent(
        `${sparkline(live.latencySeries.map((item) => item.value))}\n\n` +
          `avg ${live.avgLatencyMs}ms   p95 ${live.p95LatencyMs}ms   p99 ${live.p99LatencyMs}ms`
      );
      this.screen.render();
    }, 1000);

    this.screen.render();
  }
}

module.exports = {
  TerminalDashboard
};
