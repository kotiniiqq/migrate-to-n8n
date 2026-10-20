import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';

import { convertMake } from '../src/convert.ts';
import { uploadConfig, uploadWorkflow } from '../src/n8n/upload.ts';
import { startMockN8n, type MockN8n } from './mock-n8n.ts';

let mock: MockN8n;
before(async () => { mock = await startMockN8n(); });
after(() => mock.close());

const workflow = () => convertMake(JSON.parse(readFileSync(new URL('./fixtures/make/filters-onerror.json', import.meta.url), 'utf8'))).workflow;

test('upload creates one inactive workflow and returns its link', async () => {
  const before = mock.requests.length;
  const r = await uploadWorkflow(workflow(), { url: `${mock.url}/`, apiKey: mock.apiKey });
  assert.equal(r.active, false);
  assert.equal(r.url, `${mock.url}/workflow/${r.id}`);
  const saved = mock.store.get(r.id);
  assert.equal(saved.name, 'Order sync with error handling (migrated)');
  assert.equal(saved.nodes.length, workflow().nodes.length);
  assert.deepEqual(mock.requests.slice(before), ['POST /api/v1/workflows']);
});

test('a base URL that already ends in /api/v1 works too', async () => {
  const r = await uploadWorkflow(workflow(), { url: `${mock.url}/api/v1`, apiKey: mock.apiKey });
  assert.ok(mock.store.has(r.id));
});

test('errors become one plain sentence', async () => {
  await assert.rejects(uploadWorkflow(workflow(), { url: mock.url, apiKey: 'wrong' }), /n8n rejected the API key/);
  mock.failNext(404);
  await assert.rejects(uploadWorkflow(workflow(), { url: mock.url, apiKey: mock.apiKey }), /does not look like an n8n instance/);
  mock.failNext(400);
  await assert.rejects(uploadWorkflow(workflow(), { url: mock.url, apiKey: mock.apiKey }), /n8n refused the workflow: failed with 400/);
  await assert.rejects(uploadWorkflow(workflow(), { url: 'http://127.0.0.1:9', apiKey: 'x' }), /Could not reach 127\.0\.0\.1:9/);
});

test('a slow n8n times out with a clear message', async () => {
  mock.delay(500);
  try {
    await assert.rejects(uploadWorkflow(workflow(), { url: mock.url, apiKey: mock.apiKey }, { timeoutMs: 100 }), /did not answer within/);
  } finally {
    mock.delay(0);
  }
});

test('nothing but creating happens: no updates, no activation', async () => {
  for (const r of mock.requests) assert.match(r, /^POST \/api\/v1\/workflows$/);
});

test('upload config comes from N8N_URL and N8N_API_KEY; unfilled settings count as missing', () => {
  assert.deepEqual(uploadConfig({ N8N_URL: 'https://n8n.example.com', N8N_API_KEY: 'k' }), { url: 'https://n8n.example.com', apiKey: 'k' });
  assert.equal(uploadConfig({ N8N_URL: 'https://n8n.example.com' }), null);
  assert.equal(uploadConfig({ N8N_URL: '${user_config.n8n_url}', N8N_API_KEY: '${user_config.n8n_api_key}' }), null);
  assert.equal(uploadConfig({ N8N_URL: '', N8N_API_KEY: '' }), null);
});
