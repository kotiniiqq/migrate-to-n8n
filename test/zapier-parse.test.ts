import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { criteria, listZaps, parseZapier } from '../src/zapier/parse.ts';
import { InputError } from '../src/types.ts';

const raw = readFileSync(new URL('./fixtures/zapier/export-basic.json', import.meta.url), 'utf8');
const exportFile = () => JSON.parse(raw);
const edges = (g: ReturnType<typeof parseZapier>[number]) => g.edges.map((e) => `${e.from}>${e.to}${e.branch ? `#${e.branch.index}` : ''}`);

test('one graph per zap, named after the zap', () => {
  const graphs = parseZapier(exportFile());
  assert.deepEqual(graphs.map((g) => g.name), ['Lead routing', 'Daily totals']);
  assert.ok(graphs.every((g) => g.source === 'zapier'));
});

test('steps follow the tree; path filters become branch conditions, not steps', () => {
  const [g] = parseZapier(exportFile());
  assert.deepEqual(g.steps.map((s) => s.id), ['1', '2', '3', '4', '8', '9', '10', '11']);
  assert.deepEqual(edges(g), ['1>2', '2>3', '3>4', '4>8#0', '4>9#1', '4>10#2', '10>11']);
  const germany = g.edges.find((e) => e.to === '8')!.branch!;
  assert.equal(germany.label, 'Germany');
  assert.deepEqual(germany.condition, [[{ left: '{{1__country}}', op: 'iexact:continue', right: 'DE' }]]);
  const big = g.edges.find((e) => e.to === '9')!.branch!;
  assert.deepEqual(big.condition![0].map((c) => c.left), ['{{1__amount}}', "{{=gives['1']['company']['domain']}}"]);
  assert.equal(g.edges.find((e) => e.to === '10')!.branch!.condition, undefined);
});

test('keys, apps, labels and params', () => {
  const [g] = parseZapier(exportFile());
  const by = (id: string) => g.steps.find((s) => s.id === id)!;
  assert.equal(by('1').key, 'WebHookCLIAPI:hook_v2');
  assert.equal(by('1').app, 'WebHookCLIAPI');
  assert.equal(by('9').key, 'SlackCLIAPI:channel_message');
  assert.equal(by('9').label, 'Tell sales');
  assert.equal(by('4').label, 'Paths');
  assert.equal(by('9').connectionRef, '555');
  assert.equal(by('8').params.url, 'https://crm.example.de/api/leads');
});

test('Filter by Zapier conditions: same group = AND, different groups = OR, "stop" negates', () => {
  const [g] = parseZapier(exportFile());
  const f = g.steps.find((s) => s.id === '2')!;
  assert.equal(f.filter, undefined); // the Filter step builds its own node; nothing is inserted before it
  assert.deepEqual(criteria(f.params), [
    [{ left: '{{1__email}}', op: 'iexist:continue', right: '' }, { left: '{{1__email}}', op: 'icontains:stop', right: '@test.' }],
    [{ left: '{{1__source}}', op: 'iexact:continue', right: 'partner' }],
  ]);
});

test('listZaps summarises the export', () => {
  assert.deepEqual(listZaps(exportFile()), [
    { id: '301001', title: 'Lead routing', steps: 8, apps: ['WebHookCLIAPI', 'FilterAPI', 'ZapierFormatterCLIAPI', 'BranchingAPI', 'SlackCLIAPI', 'DelayCLIAPI'], paused: false },
    { id: '301002', title: 'Daily totals', steps: 5, apps: ['ScheduleAPI', 'CodeCLIAPI', 'StorageCLIAPI', 'ZapierFormatterCLIAPI'], paused: true },
  ]);
});

test('accepts a JSON string with a BOM, a single zap and a list of zaps', () => {
  assert.equal(parseZapier('﻿' + raw).length, 2);
  assert.equal(parseZapier(exportFile().zaps[0]).length, 1);
  assert.equal(parseZapier(exportFile().zaps).length, 2);
});

test('wrong input gives a one-line InputError naming the Zapier export', () => {
  for (const bad of [{}, 'nope', 7, null, { zaps: [] }, { zaps: [{ title: 'x' }] }]) {
    assert.throws(() => parseZapier(bad), (e: unknown) => e instanceof InputError && /Zapier export/.test((e as Error).message) && !(e as Error).message.includes('\n'));
  }
});

test('a Make blueprint given to the Zapier parser points to the Make converter', () => {
  assert.throws(() => parseZapier({ name: 'x', flow: [] }), (e: unknown) => e instanceof InputError && /Make blueprint/.test((e as Error).message));
});
