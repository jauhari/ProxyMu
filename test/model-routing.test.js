const assert = require('node:assert/strict');
const test = require('node:test');

const { applyModelRouting, matchModelRoute } = require('../src/server');

test('applyModelRouting keeps original body when model override is disabled', () => {
  const original = JSON.stringify({ model: 'gpt-5.4', input: 'hello' });
  const result = applyModelRouting(original, {
    overrideRequestModel: false,
    selectedModel: 'gpt-4.1-mini'
  });

  assert.equal(result.body, original);
  assert.equal(result.model, 'gpt-5.4');
  assert.equal(result.overridden, false);
});

test('applyModelRouting replaces request model when override is enabled', () => {
  const result = applyModelRouting(JSON.stringify({ model: 'gpt-5.4', input: 'hello' }), {
    overrideRequestModel: true,
    selectedModel: 'gpt-4.1-mini'
  });

  assert.equal(JSON.parse(result.body).model, 'gpt-4.1-mini');
  assert.equal(result.model, 'gpt-4.1-mini');
  assert.equal(result.originalModel, 'gpt-5.4');
  assert.equal(result.overridden, true);
});

test('applyModelRouting strips provider prefix from incoming tool model aliases', () => {
  const result = applyModelRouting(JSON.stringify({ model: 'chnzk/gpt-5.5', input: 'hello' }), {
    overrideRequestModel: false,
    selectedModel: ''
  });

  assert.equal(JSON.parse(result.body).model, 'gpt-5.5');
  assert.equal(result.model, 'gpt-5.5');
  assert.equal(result.originalModel, 'chnzk/gpt-5.5');
  assert.equal(result.overridden, true);
});

test('applyModelRouting strips Claude one-million-context suffix from model aliases', () => {
  const result = applyModelRouting(JSON.stringify({ model: 'gpt-5.5[1m]', input: 'hello' }), {
    overrideRequestModel: false,
    selectedModel: ''
  });

  assert.equal(JSON.parse(result.body).model, 'gpt-5.5');
  assert.equal(result.model, 'gpt-5.5');
  assert.equal(result.originalModel, 'gpt-5.5[1m]');
  assert.equal(result.overridden, true);
});

test('matchModelRoute matches wildcard patterns in rule order', () => {
  const routes = [
    { pattern: 'claude-*', providerId: 'anthropic-provider' },
    { pattern: 'gpt-*', providerId: 'openai-provider' },
    { pattern: '*', providerId: 'fallback-provider' }
  ];

  assert.equal(matchModelRoute('claude-sonnet-4-5', routes), 'anthropic-provider');
  assert.equal(matchModelRoute('gpt-5.5', routes), 'openai-provider');
  assert.equal(matchModelRoute('mistral-large', routes), 'fallback-provider');
  assert.equal(matchModelRoute('gpt-5.5', []), '');
  assert.equal(matchModelRoute('', routes), '');
});

test('matchModelRoute requires exact match without wildcard and ignores case', () => {
  const routes = [{ pattern: 'gpt-5.5', providerId: 'exact-provider' }];

  assert.equal(matchModelRoute('GPT-5.5', routes), 'exact-provider');
  assert.equal(matchModelRoute('gpt-5.5-mini', routes), '');
  assert.equal(matchModelRoute('gpt-5x5', routes), '', 'dot must not act as regex wildcard');
});
