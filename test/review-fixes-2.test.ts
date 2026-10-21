/** Findings of the second whole-branch review, each pinned where it shows. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { checkWorkflow } from '../src/build/check.ts';
import { convertMake, convertZapier } from '../src/convert.ts';
import { translateMakeExpr } from '../src/make/expr.ts';
import { uploadWorkflow } from '../src/n8n/upload.ts';
import type { N8nWorkflow } from '../src/types.ts';
import { oneMake, oneZap } from './helpers/one.ts';
import { startMockN8n, type MockN8n } from './mock-n8n.ts';

const m = (id: number, module: string, mapper: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ id, module, version: 1, parameters: {}, mapper, metadata: {}, ...extra });
const p = (n: { parameters: Record<string, unknown> }) => n.parameters as Record<string, any>;

let mock: MockN8n;
before(async () => { mock = await startMockN8n(); });
after(() => mock.close());

/** Run a Code node's JavaScript ("Run Once for Each Item") on one item. */
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const runCode = (code: string, $json: unknown) => new AsyncFunction('$json', code)($json);

test('1: Code by Zapier that declares output itself still returns it', async () => {
  for (const code of ['const output = { id: inputData.id, total: 5 };', 'let output = [{ a: 1 }];', 'if (true) { const output = 1; }\nreturn { id: 7 };']) {
    const r = oneZap('CodeCLIAPI', 'run_javascript', { code, input: { id: '{{1__id}}' } });
    const out = await runCode(String(p(r.node).jsCode), { id: 7 });
    assert.notDeepEqual(out.json, {}, code);
  }
  const r = oneZap('CodeCLIAPI', 'run_javascript', { code: 'const output = { id: inputData.id };', input: {} });
  assert.deepEqual(await runCode(String(p(r.node).jsCode), { id: 7 }), { json: { id: 7 } });
});

test('2: a function applied to an operator expression applies to all of it', () => {
  const ctx = { refName: () => 'A' };
  const run = (src: string, json: Record<string, unknown>) => {
    const t = translateMakeExpr(src, ctx);
    assert.ok(t.ok, src);
    const $ = () => ({ item: { json } });
    return new Function('$', `return (${String(t.value).slice(4, -3)})`)($);
  };
  assert.equal(run('{{length(1.a & 1.b)}}', { a: 'Ann', b: 'Lee' }), 6);
  assert.equal(run('{{contains(1.subject & " " & 1.body; "urgent")}}', { subject: 'Re: x', body: 'urgent' }), true);
  assert.equal(run('{{contains(1.subject & " " & 1.body; "urgent")}}', { subject: 'Re: x', body: 'later' }), false);
  assert.equal(run('{{first(split(1.a & "," & 1.b; ","))}}', { a: 'x', b: 'y' }), 'x');
});

test('3: a Sheets search limit holds per incoming item, read through the read node by its final name', () => {
  // A step already named like the read node makes the read node get another name.
  const r = convertMake({
    name: 'Lookup',
    flow: [
      m(1, 'gateway:CustomWebHook'),
      m(2, 'util:SetVariable2', { name: 'x', value: '1' }, { metadata: { designer: { name: 'Find (read)' } } }),
      m(3, 'google-sheets:filterRows', { spreadsheetId: '1A', sheetId: 'S', limit: '2' }, { metadata: { designer: { name: 'Find' } } }),
    ],
    metadata: { instant: true },
  });
  const step = r.report.steps.find((s) => s.sourceId === '3')!;
  const [readName, codeName] = step.n8nNodes;
  assert.notEqual(readName, 'Find (read)');
  const code = String(p(r.workflow.nodes.find((n) => n.name === codeName)!).jsCode);
  assert.ok(code.includes(`$(${JSON.stringify(readName)}).itemMatching(i)`), code);
  // Two searches (items 0 and 1 into the read node) with three rows each: two rows of each are kept.
  const reads = [0, 0, 0, 1, 1, 1].map((item) => ({ pairedItem: { item } }));
  const items = reads.map((_, i) => ({ json: { i } }));
  const $input = { all: () => items };
  const $ = () => ({ itemMatching: (i: number) => reads[i] });
  const kept = new Function('$input', '$', code)($input, $);
  assert.deepEqual(kept.map((k: { json: { i: number } }) => k.json.i), [0, 1, 3, 4]);
});

test('4: Make intervals n8n cannot repeat exactly get the nearest one and a note', () => {
  const rule = (interval: number) => {
    const r = convertMake({ name: 'S', flow: [m(1, 'http:ActionSendData', { url: 'https://x.io', method: 'get' })], metadata: { instant: false }, scheduling: { type: 'indefinitely', interval } });
    return { rule: (p(r.workflow.nodes[0]).rule.interval as unknown[])[0], notes: r.report.nextSteps.join(' ') };
  };
  assert.deepEqual(rule(900).rule, { field: 'minutes', minutesInterval: 15 });
  assert.doesNotMatch(rule(900).notes, /cannot repeat/);
  assert.deepEqual(rule(7200).rule, { field: 'hours', hoursInterval: 2 });
  assert.deepEqual(rule(172800).rule, { field: 'days', daysInterval: 2 });
  const odd = rule(5400);
  assert.notEqual((odd.rule as { minutesInterval?: number }).minutesInterval, 90);
  assert.match(odd.notes, /every 90 minutes; n8n cannot repeat at exactly that interval/);
  assert.match(rule(2700).notes, /cannot repeat/); // */45 would run at :00 and :45
});

test('5: a converted step that needs a credential is reported by check until one is picked', () => {
  const r = oneMake('slack:CreateMessage', { channel: 'C1', text: 'hi' });
  assert.deepEqual(r.node.credentials, { slackApi: { name: 'Slack account' } });
  assert.ok(checkWorkflow(r.result.workflow).some((i) => i.rule === 'credentials' && i.node === r.node.name));
  // The credential sits on the app node, not on a helper that follows it.
  const s = oneMake('google-sheets:filterRows', { spreadsheetId: '1A', sheetId: 'S', limit: '1' });
  assert.equal(s.nodes[0].type, 'n8n-nodes-base.googleSheets');
  assert.ok(s.nodes[0].credentials?.googleSheetsOAuth2Api);
  assert.equal(s.node.credentials, undefined);
  assert.deepEqual(s.result.report.credentials[0].nodes, [s.nodes[0].name]);
});

test('6: two workflows of the same name get different webhook paths', () => {
  const zap = (id: number) => ({ id, title: 'Untitled Zap', nodes: { 1: { id: 1, parent_id: null, type_of: 'read', selected_api: 'WebHookCLIAPI@1.0.0', action: 'hook_v2', params: {} } } });
  const [a, b] = convertZapier({ zaps: [zap(1), zap(2)] });
  assert.match(a.report.webhooks[0].path, /^untitled-zap-[0-9a-f]{8}$/);
  assert.notEqual(a.report.webhooks[0].path, b.report.webhooks[0].path);
});

test('7: the CLI converts a blueprint saved from Make\'s API ({response: {blueprint}})', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mtn-rf2-'));
  try {
    const blueprint = JSON.parse(readFileSync(new URL('./fixtures/make/basic-webhook-sheets.json', import.meta.url), 'utf8'));
    const file = join(dir, 'api.json');
    writeFileSync(file, JSON.stringify({ response: { blueprint } }));
    const cli = decodeURIComponent(new URL('../src/cli.ts', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
    const r = spawnSync(process.execPath, ['--import', 'tsx', cli, 'convert', file, '-o', dir], { encoding: 'utf8', input: '' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Make → n8n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('8 and 10: upload keeps the node and workflow settings n8n accepts, and names a workflow without a name', async () => {
  const w = convertMake({ name: 'Up', flow: [m(1, 'gateway:CustomWebHook'), m(2, 'util:SetVariable2', { name: 'a', value: '1' })], metadata: { instant: true } }).workflow;
  const edited = {
    ...w,
    name: undefined,
    nodes: w.nodes.map((n, i) => (i === 1 ? { ...n, executeOnce: true, alwaysOutputData: true, extra: 'dropped' } : n)),
    settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv', errorWorkflow: '42', unknownSetting: true },
    staticData: { global: { seen: 1 } },
  } as unknown as N8nWorkflow;
  const { id } = await uploadWorkflow(edited, { url: mock.url, apiKey: mock.apiKey });
  const saved = mock.store.get(id);
  assert.equal(saved.name, 'Workflow (migrated)');
  assert.equal(saved.nodes[1].executeOnce, true);
  assert.equal(saved.nodes[1].alwaysOutputData, true);
  assert.equal(saved.nodes[1].extra, undefined);
  assert.deepEqual(saved.settings, { executionOrder: 'v1', timezone: 'Europe/Kyiv', errorWorkflow: '42' });
  assert.deepEqual(saved.staticData, { global: { seen: 1 } });
});

test('9: Make Break retries as many times as its own setting says', () => {
  const tries = (count: unknown, own: Record<string, unknown> = {}) => {
    const r = convertMake({
      name: 'B',
      flow: [m(1, 'gateway:CustomWebHook'), m(2, 'http:ActionSendData', { url: 'https://x.io', method: 'get', ...own }, { onerror: [{ id: 3, module: 'builtin:Break', version: 1, parameters: { count, interval: 15 }, mapper: {}, metadata: {} }] })],
      metadata: { instant: true },
    });
    return r.workflow.nodes.find((n) => n.type === 'n8n-nodes-base.httpRequest')!.maxTries;
  };
  assert.equal(tries(1), 2);
  assert.equal(tries(3), 4);
  assert.equal(tries(1, { count: 10 }), 2); // the module's own "count" is not the retry setting
});
