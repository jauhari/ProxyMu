const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { ProviderManager } = require('../src/provider-manager');

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

test('ProviderManager fails over and streams from the next enabled provider', async () => {
  let receivedBody = '';
  const failing = await startServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'down' }));
  });
  const healthy = await startServer((req, res) => {
    req.on('data', (chunk) => {
      receivedBody += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: response.output_text.delta\n');
      res.end('data: {"delta":"ok"}\n\n');
    });
  });

  try {
    const providers = [
      {
        id: 'bad',
        name: 'Bad',
        protocol: 'http:',
        host: '127.0.0.1',
        port: failing.port,
        basePath: '/v1/responses',
        apiKey: 'sk-bad',
        priority: 1,
        enabled: true,
        timeoutMs: 1000
      },
      {
        id: 'good',
        name: 'Good',
        protocol: 'http:',
        host: '127.0.0.1',
        port: healthy.port,
        basePath: '/v1/responses',
        apiKey: 'sk-good',
        priority: 2,
        enabled: true,
        timeoutMs: 1000
      }
    ];
    const manager = new ProviderManager({ getProviders: async () => providers });

    const chunks = [];
    const writable = {
      headersSent: false,
      writableEnded: false,
      writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
        this.headersSent = true;
      },
      write(chunk) {
        chunks.push(Buffer.from(chunk));
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        this.writableEnded = true;
      }
    };

    const result = await manager.proxyResponses({
      body: '{"model":"x"}',
      clientRes: writable,
      onAttempt: () => {},
      onFailure: () => {}
    });

    assert.equal(result.provider.id, 'good');
    assert.deepEqual(result.failoverPath, ['bad', 'good']);
    assert.equal(writable.statusCode, 200);
    assert.equal(Buffer.concat(chunks).toString('utf8').includes('"delta":"ok"'), true);
    assert.equal(receivedBody, '{"model":"x"}');
  } finally {
    await failing.close();
    await healthy.close();
  }
});

test('ProviderManager tries the preferred provider first regardless of priority', async () => {
  const hits = [];
  const primary = await startServer((req, res) => {
    hits.push('primary');
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  const secondary = await startServer((req, res) => {
    hits.push('secondary');
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });

  try {
    const manager = new ProviderManager({
      getProviders: async () => [
        {
          id: 'primary',
          name: 'Primary',
          protocol: 'http:',
          host: '127.0.0.1',
          port: primary.port,
          basePath: '/v1/responses',
          apiKey: 'sk-a',
          priority: 1,
          enabled: true,
          timeoutMs: 1000
        },
        {
          id: 'secondary',
          name: 'Secondary',
          protocol: 'http:',
          host: '127.0.0.1',
          port: secondary.port,
          basePath: '/v1/responses',
          apiKey: 'sk-b',
          priority: 2,
          enabled: true,
          timeoutMs: 1000
        }
      ]
    });
    const writable = {
      headersSent: false,
      writableEnded: false,
      writeHead() {
        this.headersSent = true;
      },
      write() {},
      end() {
        this.writableEnded = true;
      }
    };

    const result = await manager.proxyResponses({
      body: '{"model":"claude-x"}',
      clientRes: writable,
      preferredProviderId: 'secondary'
    });

    assert.equal(result.provider.id, 'secondary');
    assert.deepEqual(hits, ['secondary']);
  } finally {
    await primary.close();
    await secondary.close();
  }
});

test('ProviderManager forwards OpenAI-compatible chat completions path unchanged', async () => {
  let seenPath = '';
  let receivedBody = '';
  const upstream = await startServer((req, res) => {
    seenPath = req.url;
    req.on('data', (chunk) => {
      receivedBody += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl_test', choices: [] }));
    });
  });

  try {
    const manager = new ProviderManager({
      getProviders: async () => [
        {
          id: 'openai',
          name: 'OpenAI Compatible',
          protocol: 'http:',
          host: '127.0.0.1',
          port: upstream.port,
          basePath: '/v1/responses',
          apiKey: 'sk-openai',
          priority: 1,
          enabled: true,
          timeoutMs: 1000
        }
      ]
    });
    const chunks = [];
    const writable = {
      headersSent: false,
      writableEnded: false,
      writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
        this.headersSent = true;
      },
      write(chunk) {
        chunks.push(Buffer.from(chunk));
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        this.writableEnded = true;
      }
    };

    await manager.proxyResponses({
      body: '{"model":"gpt-5.4","messages":[]}',
      clientRes: writable,
      upstreamPath: '/v1/chat/completions'
    });

    assert.equal(seenPath, '/v1/chat/completions');
    assert.equal(receivedBody, '{"model":"gpt-5.4","messages":[]}');
    assert.equal(writable.statusCode, 200);
  } finally {
    await upstream.close();
  }
});

test('ProviderManager supports Anthropic messages path with x-api-key header', async () => {
  let seenPath = '';
  let seenApiKey = '';
  let seenVersion = '';
  const upstream = await startServer((req, res) => {
    seenPath = req.url;
    seenApiKey = req.headers['x-api-key'] || '';
    seenVersion = req.headers['anthropic-version'] || '';
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_test', content: [] }));
    });
  });

  try {
    const manager = new ProviderManager({
      getProviders: async () => [
        {
          id: 'anthropic',
          name: 'Anthropic Compatible',
          protocol: 'http:',
          host: '127.0.0.1',
          port: upstream.port,
          basePath: '/v1/responses',
          apiKey: 'sk-ant',
          priority: 1,
          enabled: true,
          timeoutMs: 1000
        }
      ]
    });
    const writable = {
      headersSent: false,
      writableEnded: false,
      writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
        this.headersSent = true;
      },
      write() {},
      end() {
        this.writableEnded = true;
      }
    };

    await manager.proxyResponses({
      body: '{"model":"claude-sonnet-4-5","messages":[]}',
      clientRes: writable,
      upstreamPath: '/v1/messages',
      incomingHeaders: { 'anthropic-version': '2023-06-01' }
    });

    assert.equal(seenPath, '/v1/messages');
    assert.equal(seenApiKey, 'sk-ant');
    assert.equal(seenVersion, '2023-06-01');
    assert.equal(writable.statusCode, 200);
  } finally {
    await upstream.close();
  }
});
