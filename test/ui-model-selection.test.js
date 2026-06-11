const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('model routing prefers active last model over first available model when override is off', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public/assets/admin.js'), 'utf8');
  assert.equal(js.includes("if (live.lastModel && live.lastModel !== '-' && models.includes(live.lastModel)) return live.lastModel;"), true);
  assert.equal(js.includes("selectedModel: result.models[0] || state.settings?.selectedModel || ''"), false);
});

test('admin dashboard includes copyable client setup snippets', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public/admin.html'), 'utf8');
  const js = fs.readFileSync(path.join(process.cwd(), 'public/assets/admin.js'), 'utf8');
  assert.equal(html.includes('Client Setup'), true);
  assert.equal(js.includes("title: 'Claude Code'"), true);
  assert.equal(js.includes("title: 'OpenAI Compatible'"), true);
  assert.equal(js.includes("title: 'Kiro / Cline / Roo'"), true);
  assert.equal(js.includes("title: 'Codex Responses'"), true);
  assert.equal(js.includes('renderSetupSnippets'), true);
  assert.equal(js.includes('navigator.clipboard.writeText'), true);
});
