const state = {
  me: null,
  live: null,
  providers: [],
  requests: [],
  settings: null,
  editingProvider: null,
  range: '24h'
};

const $ = (id) => document.getElementById(id);

function fmtBytes(bytes = 0) {
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function fmtUptime(ms = 0) {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h ${m}m ${s}s`;
}

function effectiveModel(models = []) {
  const settings = state.settings || {};
  const live = state.live || {};
  if (settings.overrideRequestModel && settings.selectedModel) return settings.selectedModel;
  if (live.lastModel && live.lastModel !== '-' && models.includes(live.lastModel)) return live.lastModel;
  if (settings.selectedModel && models.includes(settings.selectedModel)) return settings.selectedModel;
  if (live.lastModel && live.lastModel !== '-') return live.lastModel;
  return settings.selectedModel || '';
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(payload.error?.message || `HTTP ${res.status}`);
  return payload;
}

function showAuth(me) {
  $('authView').classList.remove('hidden');
  $('appView').classList.add('hidden');
  $('authMode').textContent = me.setupRequired ? 'First Run Setup' : 'Admin Access';
  $('authHelp').textContent = me.setupRequired
    ? 'Buat admin pertama untuk membuka dashboard LAN.'
    : 'Masuk untuk mengelola provider, key, dan telemetry proxy.';
}

function showApp() {
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
}

async function refreshMe() {
  state.me = await api('/api/admin/me');
  if (state.me.authenticated) {
    showApp();
    await refreshAll();
    connectSse();
  } else {
    showAuth(state.me);
  }
}

async function refreshAll() {
  await Promise.all([refreshProviders(), refreshLive(), refreshRequests(), refreshSettings(), refreshInject()]);
}

async function refreshInject() {
  try {
    const payload = await api('/api/admin/inject');
    renderInjectList(payload.tools || []);
  } catch {
    $('injectList').innerHTML = '<p class="message">Gagal memuat status tool.</p>';
  }
}

function renderInjectList(tools) {
  $('injectList').innerHTML = tools
    .map((tool) => {
      const badge = tool.injected
        ? `<span class="inject-badge active">● Aktif</span>`
        : tool.installed
          ? `<span class="inject-badge inactive">○ Tidak aktif</span>`
          : `<span class="inject-badge not-installed">Tidak terdeteksi</span>`;
      const injectBtn = tool.installed && !tool.injected
        ? `<button class="primary inject-do" data-id="${tool.id}">Injek</button>`
        : '';
      const ejectBtn = tool.injected
        ? `<button class="ghost inject-undo" data-id="${tool.id}">Cabut</button>`
        : '';
      return `
        <div class="inject-card ${tool.injected ? 'injected' : ''}">
          <div class="inject-card-head">
            <div class="inject-card-info">
              <strong>${escapeHtml(tool.name)}</strong>
              <span>${escapeHtml(tool.description)}</span>
              <code>${escapeHtml(tool.configPath)}</code>
            </div>
            ${badge}
          </div>
          <div class="inject-card-actions">
            ${injectBtn}
            ${ejectBtn}
          </div>
        </div>`;
    })
    .join('');
}

async function refreshProviders() {
  const payload = await api('/api/admin/providers');
  state.providers = payload.providers || [];
  renderProviders();
  if (state.settings) renderModelRouting();
}

async function refreshLive() {
  state.live = await api('/api/admin/metrics/live');
  renderLive();
}

async function refreshRequests() {
  const params = new URLSearchParams({
    range: state.range,
    model: $('filterModel').value.trim(),
    status: $('filterStatus').value
  });
  const payload = await api(`/api/admin/requests?${params}`);
  state.requests = payload.requests || [];
  renderRequests();
}

async function refreshSettings() {
  const payload = await api('/api/admin/settings');
  state.settings = payload.server;
  renderSettings();
}

function renderLive() {
  const live = state.live || {};
  const settings = state.settings || {};
  const total = live.totalRequests || 0;
  const success = live.successRequests || 0;
  $('totalRequests').textContent = total;
  $('successRate').textContent = `${total ? Math.round((success / total) * 100) : 0}% success`;
  $('activeRequests').textContent = live.activeRequests || 0;
  $('uptime').textContent = `${fmtUptime(live.uptimeMs)} uptime`;
  $('latencyP').textContent = `${live.p95LatencyMs || 0} / ${live.p99LatencyMs || 0} ms`;
  $('avgLatency').textContent = `${live.avgLatencyMs || 0} ms average`;
  $('streamedBytes').textContent = fmtBytes(live.totalBytesOut || 0);
  $('writeFailures').textContent = `${live.writeFailures || 0} telemetry write failures`;
  $('currentModel').textContent = effectiveModel() || '-';
  $('modelMode').textContent = settings.overrideRequestModel
    ? 'override on'
    : live.lastModel && live.lastModel !== '-'
      ? `last request: ${live.lastModel}`
      : 'observe only';
  renderActive(live.active || []);
  renderTimeline(live.recentEvents || []);
  drawLatency(live.latencySeries || []);
}

function renderActive(active) {
  $('activeStreams').innerHTML =
    active.length === 0
      ? '<div class="list-row"><strong>No active streams</strong><span>Proxy is idle.</span></div>'
      : active
          .map(
            (item) => `
        <div class="list-row">
          <strong>${escapeHtml(item.model)}</strong>
          <span>${escapeHtml(item.clientIp)} · ${escapeHtml(item.provider || 'selecting provider')} · ${new Date(item.startedAt).toLocaleTimeString()}</span>
        </div>`
          )
          .join('');
}

function renderTimeline(events) {
  const interesting = events
    .filter((event) => event.status === 'failed' || event.type === 'failover' || event.errorCategory)
    .slice(0, 10);
  $('eventTimeline').innerHTML =
    interesting.length === 0
      ? '<div class="list-row"><strong>No recent errors</strong><span>Failover timeline is clean.</span></div>'
      : interesting
          .map(
            (event) => `
        <div class="list-row">
          <strong>${escapeHtml(event.errorCategory || event.type || event.status)}</strong>
          <span>${new Date(event.timestamp).toLocaleTimeString()} · ${escapeHtml(event.provider || '-')} · ${escapeHtml(event.message || event.model || '')}</span>
        </div>`
          )
          .join('');
}

function renderProviders() {
  $('providers').innerHTML =
    state.providers.length === 0
      ? '<div class="provider-card"><div><h3>No provider configured</h3><div class="provider-meta">Add one provider to start proxying Codex requests.</div></div></div>'
      : state.providers
          .map(
            (provider) => `
      <div class="provider-card">
        <div>
          <h3>${provider.priority}. ${escapeHtml(provider.name)}
            <span class="health ${provider.healthStatus === 'down' ? 'down' : ''}">${escapeHtml(provider.healthStatus || 'unknown')}</span>
          </h3>
          <div class="provider-meta">${escapeHtml(provider.protocol || 'https:')}//${escapeHtml(provider.host)}${provider.port ? `:${provider.port}` : ''}${escapeHtml(provider.basePath)} · ${escapeHtml(provider.apiKeyMasked)} · ${provider.enabled ? 'enabled' : 'disabled'}</div>
          ${provider.models?.length ? `<div class="provider-meta">${provider.models.length} models cached${provider.modelsUpdatedAt ? ` · ${new Date(provider.modelsUpdatedAt).toLocaleString()}` : ''}</div>` : ''}
          ${provider.lastError ? `<div class="provider-meta">${escapeHtml(provider.lastError)}</div>` : ''}
        </div>
        <div class="provider-actions">
          <button class="ghost" onclick="editProvider('${provider.id}')">Edit</button>
          <button class="ghost" onclick="testProvider('${provider.id}')">Validate</button>
        </div>
      </div>`
          )
          .join('');
}

function renderSettings() {
  const settings = state.settings || {};
  $('requireProxyToken').checked = settings.requireProxyTokenForLan !== false;
  $('settingsMessage').textContent = settings.proxyAccessTokenConfigured
    ? 'LAN proxy token is configured.'
    : 'LAN proxy token is not configured yet.';
  renderSetupSnippets();
  renderModelRouting();
}

function setupOrigins() {
  const origin = window.location.origin;
  const openaiBase = `${origin}/v1`;
  return { origin, openaiBase };
}

function renderSetupSnippets() {
  const { origin, openaiBase } = setupOrigins();
  const snippets = [
    {
      title: 'Claude Code',
      note: 'Anthropic base URL harus root proxy, tanpa /v1.',
      value: [
        `$env:ANTHROPIC_BASE_URL="${origin}"`,
        '$env:CLAUDE_MODEL="gpt-5.5"',
        '$env:ANTHROPIC_AUTH_TOKEN="proxy-local-token"'
      ].join('\n')
    },
    {
      title: 'OpenAI Compatible',
      note: 'Untuk Kiro extension, Cline, Roo, Kilo Code, Continue, dan SDK OpenAI-compatible.',
      value: [
        `Base URL: ${openaiBase}`,
        'API Key: proxy-local-token',
        'Model: gpt-5.5'
      ].join('\n')
    },
    {
      title: 'Kiro / Cline / Roo',
      note: 'Pilih provider OpenAI Compatible atau Custom OpenAI.',
      value: [
        'Provider: OpenAI Compatible',
        `Base URL: ${openaiBase}`,
        'API Key: proxy-local-token',
        'Model ID: gpt-5.5'
      ].join('\n')
    },
    {
      title: 'Codex Responses',
      note: 'Endpoint kompatibel untuk client yang langsung memanggil Responses API.',
      value: [
        `POST ${openaiBase}/responses`,
        'Authorization: Bearer proxy-local-token',
        'Content-Type: application/json'
      ].join('\n')
    }
  ];

  $('setupSnippets').innerHTML = snippets
    .map(
      (snippet, index) => `
      <div class="setup-card">
        <div class="setup-card-head">
          <div>
            <strong>${escapeHtml(snippet.title)}</strong>
            <span>${escapeHtml(snippet.note)}</span>
          </div>
          <button type="button" class="ghost copy-setup" data-index="${index}">Copy</button>
        </div>
        <pre>${escapeHtml(snippet.value)}</pre>
      </div>`
    )
    .join('');
  window.codexProxySetupSnippets = snippets;
}

function renderRouteRules() {
  const routes = state.settings?.modelRoutes || [];
  const providerOptions = (selectedId) =>
    state.providers.length === 0
      ? '<option value="">No provider</option>'
      : state.providers
          .map((provider) => `<option value="${provider.id}" ${provider.id === selectedId ? 'selected' : ''}>${escapeHtml(provider.name)}</option>`)
          .join('');
  $('routeRules').innerHTML =
    routes.length === 0
      ? '<div class="route-empty">No routing rules. All requests follow provider priority.</div>'
      : routes
          .map(
            (route, index) => `
      <div class="route-rule" data-index="${index}">
        <input class="route-pattern" placeholder="claude-*" value="${escapeHtml(route.pattern)}" />
        <select class="route-provider">${providerOptions(route.providerId)}</select>
        <button type="button" class="ghost remove-route" title="Remove rule">&times;</button>
      </div>`
          )
          .join('');
}

function readRouteRulesFromDom() {
  return Array.from(document.querySelectorAll('#routeRules .route-rule'))
    .map((row) => ({
      pattern: row.querySelector('.route-pattern').value.trim(),
      providerId: row.querySelector('.route-provider').value
    }))
    .filter((route) => route.pattern && route.providerId);
}

function renderModelRouting() {
  const settings = state.settings || {};
  const selectedProviderId = settings.selectedProviderId || state.providers[0]?.id || '';
  $('modelProviderSelect').innerHTML =
    state.providers.length === 0
      ? '<option value="">No provider</option>'
      : state.providers
          .map((provider) => `<option value="${provider.id}" ${provider.id === selectedProviderId ? 'selected' : ''}>${escapeHtml(provider.name)}</option>`)
          .join('');
  const provider = state.providers.find((item) => item.id === selectedProviderId) || state.providers[0];
  const models = provider?.models || [];
  const selectedModel = effectiveModel(models);
  $('modelPills').innerHTML =
    models.length === 0
      ? `<button type="button" class="model-pill empty">${selectedModel ? escapeHtml(selectedModel) : 'Load models first'}</button>`
      : models
          .map((model) => `<button type="button" class="model-pill ${model === selectedModel ? 'active' : ''}" data-model="${escapeHtml(model)}">${escapeHtml(model)}</button>`)
          .join('');
  $('overrideRequestModel').checked = settings.overrideRequestModel === true;
  $('modelRoutingMessage').textContent = selectedModel
    ? `Selected: ${selectedModel}${settings.overrideRequestModel ? ' (override on)' : ' (observe only)'}`
    : 'No model selected yet.';
  renderRouteRules();
  renderLive();
}

function renderRequests() {
  $('requestRows').innerHTML =
    state.requests.length === 0
      ? '<tr><td colspan="8">No request data for this filter.</td></tr>'
      : state.requests
          .map(
            (request) => `
      <tr>
        <td>${new Date(request.timestamp).toLocaleString()}</td>
        <td class="status-${request.status}">${escapeHtml(request.status)}</td>
        <td>${escapeHtml(request.model || '-')}</td>
        <td>${escapeHtml(request.provider || '-')}</td>
        <td>${request.ttfbMs || 0} ms</td>
        <td>${request.durationMs || 0} ms</td>
        <td>${fmtBytes(request.bytesOut || 0)}</td>
        <td>${escapeHtml((request.failoverPath || []).join(' -> ') || '-')}</td>
      </tr>`
          )
          .join('');
}

function drawLatency(series) {
  const canvas = $('latencyCanvas');
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) {
    const y = (height / 5) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  if (!series.length) {
    ctx.fillStyle = '#8a93a3';
    ctx.font = '14px Inter, system-ui';
    ctx.fillText('No latency samples yet', 24, 36);
    return;
  }
  const max = Math.max(...series.map((item) => item.value), 100);
  const pointAt = (item, index) => ({
    x: series.length === 1 ? 16 : (index / (series.length - 1)) * (width - 32) + 16,
    y: height - 20 - (item.value / max) * (height - 42)
  });

  // Soft area fill under the line
  const fill = ctx.createLinearGradient(0, 0, 0, height);
  fill.addColorStop(0, 'rgba(74, 222, 128, 0.18)');
  fill.addColorStop(1, 'rgba(74, 222, 128, 0)');
  ctx.fillStyle = fill;
  ctx.beginPath();
  series.forEach((item, index) => {
    const { x, y } = pointAt(item, index);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(pointAt(series[series.length - 1], series.length - 1).x, height - 20);
  ctx.lineTo(pointAt(series[0], 0).x, height - 20);
  ctx.closePath();
  ctx.fill();

  const stroke = ctx.createLinearGradient(0, 0, width, 0);
  stroke.addColorStop(0, '#4ade80');
  stroke.addColorStop(1, '#60a5fa');
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  series.forEach((item, index) => {
    const { x, y } = pointAt(item, index);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#8a93a3';
  ctx.font = '12px Inter, system-ui';
  ctx.fillText(`max ${max} ms`, 16, 18);
}

function openDrawer(provider = null) {
  state.editingProvider = provider;
  $('providerDrawer').classList.remove('hidden');
  $('providerFormTitle').textContent = provider ? 'Edit Provider' : 'Add Provider';
  $('providerId').value = provider?.id || '';
  $('providerName').value = provider?.name || '';
  $('providerProtocol').value = provider?.protocol || 'https:';
  $('providerHost').value = provider?.host || '';
  $('providerPort').value = provider?.port || '';
  $('providerBasePath').value = provider?.basePath || '/v1/responses';
  $('providerKey').value = '';
  $('providerPriority').value = provider?.priority || state.providers.length + 1;
  $('providerTimeout').value = provider?.timeoutMs || 180000;
  $('providerEnabled').checked = provider?.enabled !== false;
  $('deleteProviderBtn').style.display = provider ? 'inline-flex' : 'none';
  $('testProviderBtn').style.display = provider ? 'inline-flex' : 'none';
  $('providerMessage').textContent = provider ? `Current key: ${provider.apiKeyMasked}` : '';
}

function closeDrawer() {
  $('providerDrawer').classList.add('hidden');
  $('providerForm').reset();
  state.editingProvider = null;
}

window.editProvider = function editProvider(id) {
  openDrawer(state.providers.find((provider) => provider.id === id));
};

window.testProvider = async function testProvider(id) {
  const message = $('providerMessage');
  try {
    message.textContent = 'Validating provider config...';
    const result = await api(`/api/admin/providers/${id}/test`, { method: 'POST', body: '{}' });
    message.textContent = result.ok ? result.message : `Invalid: ${result.error}`;
    await refreshProviders();
  } catch (error) {
    message.textContent = error.message;
  }
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[char];
  });
}

function connectSse() {
  if (window.codexProxyEvents) window.codexProxyEvents.close();
  const source = new EventSource('/api/admin/events/stream');
  window.codexProxyEvents = source;
  source.onopen = () => {
    $('connectionState').textContent = 'Live';
  };
  source.onerror = () => {
    $('connectionState').textContent = 'Reconnecting';
  };
  source.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.live) state.live = payload.live;
    if (payload.type === 'request' && payload.live) refreshRequests().catch(() => {});
    if (payload.type === 'inject_status' && payload.tools) renderInjectList(payload.tools);
    renderLive();
  };
}

$('authForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('authError').textContent = '';
  try {
    await api(state.me.setupRequired ? '/api/admin/setup' : '/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('username').value.trim(),
        password: $('password').value
      })
    });
    await refreshMe();
  } catch (error) {
    $('authError').textContent = error.message;
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST', body: '{}' });
  location.reload();
});

$('tabNav').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('#tabNav .tab').forEach((el) => el.classList.toggle('active', el === tab));
  $('tabOverview').classList.toggle('hidden', tab.dataset.tab !== 'overview');
  $('tabSettings').classList.toggle('hidden', tab.dataset.tab !== 'settings');
});

$('addRouteBtn').addEventListener('click', () => {
  state.settings = {
    ...(state.settings || {}),
    modelRoutes: [...readRouteRulesFromDom(), { pattern: '', providerId: state.providers[0]?.id || '' }]
  };
  renderRouteRules();
});

$('routeRules').addEventListener('click', (event) => {
  const button = event.target.closest('.remove-route');
  if (!button) return;
  const index = Number(button.closest('.route-rule').dataset.index);
  const routes = Array.from(document.querySelectorAll('#routeRules .route-rule')).map((row) => ({
    pattern: row.querySelector('.route-pattern').value.trim(),
    providerId: row.querySelector('.route-provider').value
  }));
  routes.splice(index, 1);
  state.settings = { ...(state.settings || {}), modelRoutes: routes };
  renderRouteRules();
});

$('refreshBtn').addEventListener('click', refreshAll);
$('refreshInjectBtn').addEventListener('click', refreshInject);

$('injectList').addEventListener('click', async (event) => {
  const injectBtn = event.target.closest('.inject-do');
  const ejectBtn = event.target.closest('.inject-undo');
  const btn = injectBtn || ejectBtn;
  if (!btn) return;
  const id = btn.dataset.id;
  btn.disabled = true;
  btn.textContent = injectBtn ? 'Menginjek…' : 'Mencabut…';
  try {
    await api(`/api/admin/inject/${id}`, { method: injectBtn ? 'POST' : 'DELETE', body: '{}' });
    await refreshInject();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = injectBtn ? 'Injek' : 'Cabut';
    alert(err.message);
  }
});
$('newProviderBtn').addEventListener('click', () => openDrawer());
$('closeDrawer').addEventListener('click', closeDrawer);
$('historyRange').addEventListener('change', async (event) => {
  state.range = event.target.value;
  await refreshRequests();
});
$('applyFilters').addEventListener('click', refreshRequests);

$('setupSnippets').addEventListener('click', async (event) => {
  const button = event.target.closest('.copy-setup');
  if (!button) return;
  const snippet = window.codexProxySetupSnippets?.[Number(button.dataset.index)];
  if (!snippet) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(snippet.value);
    } else {
      const textArea = document.createElement('textarea');
      textArea.value = snippet.value;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      textArea.remove();
    }
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1200);
  } catch {
    button.textContent = 'Copy failed';
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1400);
  }
});

$('settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = {
      requireProxyTokenForLan: $('requireProxyToken').checked
    };
    if ($('proxyAccessToken').value) payload.proxyAccessToken = $('proxyAccessToken').value;
    await api('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
    $('proxyAccessToken').value = '';
    $('settingsMessage').textContent = 'Settings saved.';
    await refreshSettings();
  } catch (error) {
    $('settingsMessage').textContent = error.message;
  }
});

$('modelProviderSelect').addEventListener('change', () => {
  const providerId = $('modelProviderSelect').value;
  const provider = state.providers.find((item) => item.id === providerId);
  const models = provider?.models || [];
  state.settings = {
    ...(state.settings || {}),
    selectedProviderId: providerId,
    selectedModel: effectiveModel(models)
  };
  renderModelRouting();
});

$('modelPills').addEventListener('click', (event) => {
  const button = event.target.closest('.model-pill[data-model]');
  if (!button) return;
  state.settings = {
    ...(state.settings || {}),
    selectedModel: button.dataset.model
  };
  renderModelRouting();
});

$('loadModelsBtn').addEventListener('click', async () => {
  const providerId = $('modelProviderSelect').value;
  if (!providerId) return;
  try {
    $('modelRoutingMessage').textContent = 'Loading available models...';
    const result = await api(`/api/admin/providers/${providerId}/models`);
    if (!result.ok) {
      $('modelRoutingMessage').textContent = `Failed: ${result.error}`;
      return;
    }
    await refreshProviders();
    state.settings = {
      ...(state.settings || {}),
      selectedProviderId: providerId,
      selectedModel: effectiveModel(result.models) || result.models[0] || ''
    };
    renderModelRouting();
  } catch (error) {
    $('modelRoutingMessage').textContent = error.message;
  }
});

$('modelRoutingForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = {
      requireProxyTokenForLan: $('requireProxyToken').checked,
      selectedProviderId: $('modelProviderSelect').value,
      selectedModel: state.settings?.selectedModel || '',
      overrideRequestModel: $('overrideRequestModel').checked,
      modelRoutes: readRouteRulesFromDom()
    };
    await api('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
    $('modelRoutingMessage').textContent = 'Model routing saved.';
    await refreshSettings();
  } catch (error) {
    $('modelRoutingMessage').textContent = error.message;
  }
});

$('providerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = $('providerId').value;
  const payload = {
    name: $('providerName').value.trim(),
    protocol: $('providerProtocol').value,
    host: $('providerHost').value.trim(),
    port: $('providerPort').value ? Number($('providerPort').value) : '',
    basePath: $('providerBasePath').value.trim(),
    priority: Number($('providerPriority').value),
    timeoutMs: Number($('providerTimeout').value),
    enabled: $('providerEnabled').checked
  };
  if ($('providerKey').value) payload.apiKey = $('providerKey').value;
  try {
    await api(id ? `/api/admin/providers/${id}` : '/api/admin/providers', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(payload)
    });
    $('providerMessage').textContent = 'Saved.';
    await refreshProviders();
    setTimeout(closeDrawer, 500);
  } catch (error) {
    $('providerMessage').textContent = error.message;
  }
});

$('deleteProviderBtn').addEventListener('click', async () => {
  const id = $('providerId').value;
  if (!id || !confirm('Delete this provider?')) return;
  await api(`/api/admin/providers/${id}`, { method: 'DELETE' });
  await refreshProviders();
  closeDrawer();
});

$('testProviderBtn').addEventListener('click', () => {
  const id = $('providerId').value;
  if (id) window.testProvider(id);
});

refreshMe().catch((error) => {
  $('authError').textContent = error.message;
});
