const assert = require('node:assert/strict');
const test = require('node:test');

const { applyModelRouting } = require('../src/server');

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
