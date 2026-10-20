import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/mcp/server.ts';
import { startMockN8n, type MockN8n } from './mock-n8n.ts';

const MAKE = new URL('./fixtures/make/basic-webhook-sheets.json', import.meta.url);
const ZAPIER = new URL('./fixtures/zapier/export-basic.json', import.meta.url);
const path = (u: URL) => decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1');

let dir: string;
let mock: MockN8n;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mtn-mcp-'));
  mock = await startMockN8n();
});
after(async () => {
  rmSync(dir, { recursive: true, force: true });
  await mock.close();
});

async function connect(env: Record<string, string | undefined> = {}) {
  const server = createServer({ env });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const text = (r: any) => (r.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n');

test('six tools without n8n settings, seven with them; every tool has a title and annotations', async () => {
  const plain = await connect();
  const names = (await plain.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['check_n8n_workflow', 'convert_make', 'convert_zapier', 'list_zaps', 'suggest_replacement', 'supported_modules']);
  const withN8n = await connect({ N8N_URL: mock.url, N8N_API_KEY: mock.apiKey });
  const tools = (await withN8n.listTools()).tools;
  assert.equal(tools.length, 7);
  for (const t of tools) {
    assert.ok(t.title, t.name);
    assert.ok(t.annotations, t.name);
    assert.ok((t.description ?? '').length > 40, t.name);
  }
  const upload = tools.find((t) => t.name === 'upload_to_n8n')!;
  assert.equal(upload.annotations!.openWorldHint, true);
  assert.equal(upload.annotations!.destructiveHint, false);
  assert.equal(tools.find((t) => t.name === 'list_zaps')!.annotations!.readOnlyHint, true);
});

test('convert_make from pasted JSON writes three files and returns the report with their paths', async () => {
  const client = await connect();
  const out = join(dir, 'make-json');
  const r = await client.callTool({ name: 'convert_make', arguments: { json: readFileSync(MAKE, 'utf8'), outputDir: out } });
  assert.equal(r.isError, undefined);
  const t = text(r);
  assert.match(t, /✅ \d+ converted · ⚠️ \d+ to review · 🛠 \d+ manual/);
  assert.match(t, /Import from File/);
  assert.equal(readdirSync(out).length, 3);
  assert.ok(t.includes(join(out, 'Leads from the website form.n8n.json')));
});

test('convert_make from a file path', async () => {
  const client = await connect();
  const r = await client.callTool({ name: 'convert_make', arguments: { path: path(MAKE), outputDir: join(dir, 'make-path') } });
  assert.match(text(r), /Leads from the website form/);
});

test('convert_zapier converts the chosen zaps', async () => {
  const client = await connect();
  const out = join(dir, 'zap');
  const r = await client.callTool({ name: 'convert_zapier', arguments: { path: path(ZAPIER), zaps: ['Daily totals'], outputDir: out } });
  assert.match(text(r), /Zapier → n8n: Daily totals/);
  assert.doesNotMatch(text(r), /Lead routing/);
  assert.ok(existsSync(join(out, 'Daily totals.n8n.json')));
});

test('list_zaps lists titles and step counts', async () => {
  const client = await connect();
  const t = text(await client.callTool({ name: 'list_zaps', arguments: { path: path(ZAPIER) } }));
  assert.match(t, /Lead routing/);
  assert.match(t, /8 steps/);
  assert.match(t, /Daily totals/);
});

test('bad input is an error message without a stack trace', async () => {
  const client = await connect();
  for (const args of [{}, { path: 'a.json', json: '{}' }, { json: '{"hello": 1}' }, { path: join(dir, 'missing.json') }]) {
    const r = await client.callTool({ name: 'convert_make', arguments: args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.doesNotMatch(text(r), /\n\s+at /);
  }
});

test('suggest_replacement and supported_modules answer from the mapping table', async () => {
  const client = await connect();
  assert.match(text(await client.callTool({ name: 'suggest_replacement', arguments: { source: 'make', module: 'http:ActionSendData' } })), /converted automatically/i);
  assert.match(text(await client.callTool({ name: 'suggest_replacement', arguments: { source: 'make', module: 'trello:createCard' } })), /Trello node/);
  const t = text(await client.callTool({ name: 'supported_modules', arguments: { query: 'webhook' } }));
  assert.match(t, /gateway:CustomWebHook/);
  assert.match(t, /WebHookCLIAPI:hook_v2/);
});

test('check_n8n_workflow reports problems of a workflow file', async () => {
  const client = await connect();
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ name: 'x', nodes: [{ name: 'A' }, { name: 'A' }], connections: {} }));
  assert.match(text(await client.callTool({ name: 'check_n8n_workflow', arguments: { path: bad } })), /unique/i);
});

test('upload_to_n8n sends a converted file and returns the link', async () => {
  const client = await connect({ N8N_URL: mock.url, N8N_API_KEY: mock.apiKey });
  const out = join(dir, 'upload');
  await client.callTool({ name: 'convert_make', arguments: { path: path(MAKE), outputDir: out } });
  const r = await client.callTool({ name: 'upload_to_n8n', arguments: { path: join(out, 'Leads from the website form.n8n.json') } });
  assert.match(text(r), new RegExp(`${mock.url}/workflow/wf\\d+`));
  assert.match(text(r), /inactive/i);
});
