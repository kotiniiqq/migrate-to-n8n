/** Findings of the whole-branch review, each pinned at the convert level. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { convertMake, convertZapier } from '../src/convert.ts';
import { uploadWorkflow } from '../src/n8n/upload.ts';
import { translateMakeExpr } from '../src/make/expr.ts';
import { InputError } from '../src/types.ts';
import { oneMake, oneZap } from './helpers/one.ts';
import { startMockN8n, type MockN8n } from './mock-n8n.ts';

const m = (id: number, module: string, mapper: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ id, module, version: 1, parameters: {}, mapper, metadata: {}, ...extra });
const p = (n: { parameters: Record<string, unknown> }) => n.parameters as Record<string, any>;

test('1: reading a step from another router branch is flagged, also through custom refs and variables', () => {
  const r = convertMake({
    name: 'Branches',
    flow: [m(1, 'gateway:CustomWebHook'), m(2, 'builtin:BasicRouter', {}, {
      routes: [
        { flow: [m(3, 'http:ActionSendData', { url: 'https://x.io', method: 'get' }), m(4, 'builtin:BasicFeeder', { array: '{{3.data.items}}' }), m(5, 'util:SetVariable2', { name: 'myvar', value: '{{4.value}}' })] },
        { flow: [m(6, 'util:SetVariable2', { name: 'other', value: '{{3.data.id}} {{4.value}} {{4.__IMTINDEX__}}' }), m(7, 'util:GetVariable2', { name: 'myvar' })] },
      ],
    })],
    metadata: { instant: true },
  });
  for (const id of ['6', '7']) {
    const s = r.report.steps.find((x) => x.sourceId === id)!;
    assert.equal(s.status, 'review', id);
    assert.match(s.notes.join(' '), /does not always run before/, id);
  }
});

test('2: a literal value that starts with "=" stays text in n8n', () => {
  const r = oneMake('util:SetVariable2', { name: 'f', value: '=SUM(A1:A3)' });
  assert.equal(p(r.node).assignments.assignments[0].value, '==SUM(A1:A3)');
});

test('3: Zapier date formatting with an input format quotes literal text and flags inexact tokens', () => {
  const r = oneZap('ZapierFormatterCLIAPI', 'datetime_line_item', { transform: 'date.formatting', inputs: '{{1__d}}', from_format: 'YYYY-MM-DDTHH:mm:ss', to_format: 'Do MMMM YYYY' });
  const value = String(p(r.node).assignments.assignments[0].value);
  assert.match(value, /fromFormat\(String\(.*\), 'yyyy-LL-dd\\'T\\'HH:mm:ss'\)/);
  assert.doesNotThrow(() => new Function('DateTime', '$', `return (${value.slice(4, -3)})`));
  assert.equal(r.step.status, 'review');
});

test('4: a Sheets search limit keeps that many rows per incoming item (see review-fixes-2 for the run)', () => {
  const r = oneMake('google-sheets:filterRows', { spreadsheetId: '1A', sheetId: 'S', limit: '1' });
  assert.equal(r.node.type, 'n8n-nodes-base.code');
  assert.match(String(p(r.node).jsCode), /const max = 1;/);
});

test('5: an aggregator after a polling trigger is flagged: n8n collects every item of the run', () => {
  const r = convertMake({
    name: 'Polling',
    flow: [m(1, 'google-sheets:watchRows', { spreadsheetId: '1A', sheetId: 'S' }), m(2, 'builtin:BasicFeeder', { array: '{{1.list}}' }), m(3, 'builtin:BasicAggregator', { x: '{{2.a}}' }, { parameters: { feeder: 2 } })],
    metadata: { instant: false },
    scheduling: { type: 'indefinitely', interval: 900 },
  });
  const s = r.report.steps.find((x) => x.sourceId === '3')!;
  assert.equal(s.status, 'review');
  assert.match(s.notes.join(' '), /per bundle|each/i);
});

test('6: HTTP steps warn that a JSON list response becomes one item per element', () => {
  const r = oneMake('http:ActionSendData', { url: 'https://x.io', method: 'get' });
  assert.match(r.step.notes.join(' '), /one item per element/);
});

test('8: an empty Text aggregator separator joins rows with nothing, flagged', () => {
  const r = oneMake('util:TextAggregator', { value: '{{1.a}}', rowSeparator: '' });
  assert.match(JSON.stringify(r.node.parameters), /\.join\(\\"\\"\)/);
  assert.equal(r.step.status, 'review');
});

test('Make: an empty blueprint is an input error; the API response wrapper is accepted', () => {
  assert.throws(() => convertMake({ name: 'x', flow: [] }), (e: unknown) => e instanceof InputError && /no modules/.test((e as Error).message));
  assert.throws(() => convertMake({ name: 'x', flow: [null, 1, 'x'] }), InputError);
  assert.equal(convertMake({ response: { blueprint: { name: 'API', flow: [m(1, 'gateway:CustomWebHook')] } } }).workflow.name, 'API');
});

test('Make: ifempty and coalesce follow Make: only null and "" count as empty', () => {
  const ctx = { refName: () => 'W' };
  const v = translateMakeExpr('{{ifempty(1.a; "x")}}', ctx).value;
  assert.match(v, /v === '' \|\| \(Array\.isArray\(v\) && !v\.length\) \? "x" : v/);
  assert.match(translateMakeExpr('{{coalesce(1.a; 1.b)}}', ctx).value, /\.find\(\(v\) => v !== undefined && v !== null && v !== ''\)/);
});

test('Zapier: steps whose parent is missing are kept and flagged, not dropped', () => {
  const [r] = convertZapier({ zaps: [{ id: 1, title: 'Broken', nodes: {
    1: { id: 1, parent_id: null, type_of: 'read', selected_api: 'WebHookCLIAPI@1', action: 'hook_v2', params: {} },
    3: { id: 3, parent_id: 2, type_of: 'write', selected_api: 'SlackCLIAPI@1', action: 'channel_message', title: 'Lost', params: { channel: 'C1', text: 'x' } },
  } }] });
  const s = r.report.steps.find((x) => x.sourceId === '3');
  assert.ok(s, 'the step is in the report');
  assert.equal(s!.status === 'converted', false);
  assert.match(s!.notes.join(' '), /not connected/i);
});

let mock: MockN8n;
before(async () => { mock = await startMockN8n(); });
after(() => mock.close());

test('7: upload never follows a redirect (the API key stays with the configured address)', async () => {
  mock.redirectNext('http://127.0.0.1:9/elsewhere');
  const wf = oneMake('util:SetVariable2', { name: 'a', value: '1' }).result.workflow;
  await assert.rejects(uploadWorkflow(wf, { url: mock.url, apiKey: mock.apiKey }), /redirects to http:\/\/127\.0\.0\.1:9\/elsewhere/);
});
