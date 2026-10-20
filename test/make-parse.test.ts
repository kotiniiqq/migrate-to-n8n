import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parseMake } from '../src/make/parse.ts';
import { InputError } from '../src/types.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/make/${name}.json`, import.meta.url), 'utf8'));
const edges = (g: ReturnType<typeof parseMake>) => g.edges.map((e) => `${e.from}>${e.to}${e.branch ? `#${e.branch.index}` : ''}`);

test('a linear blueprint: steps in order, labels, positions, connection, params without internals', () => {
  const g = parseMake(fixture('basic-webhook-sheets'));
  assert.equal(g.source, 'make');
  assert.equal(g.name, 'Leads from the website form');
  assert.deepEqual(g.steps.map((s) => s.key), ['gateway:CustomWebHook', 'util:SetVariable2', 'google-sheets:addRow', 'gateway:WebhookRespond']);
  assert.deepEqual(edges(g), ['1>2', '2>3', '3>4']);
  assert.equal(g.steps[0].label, 'Form submitted');
  assert.equal(g.steps[2].label, 'Google Sheets: Add Row');
  assert.deepEqual(g.steps[2].position, [600, 0]);
  assert.equal(g.steps[2].connectionRef, '5486001');
  assert.equal(g.steps[2].app, 'google-sheets');
  assert.equal(g.steps[2].action, 'addRow');
  assert.equal(g.steps[2].params.spreadsheetId, '/1AbCdEfGhIjKlMnOpQrStUvWxYz');
  assert.equal('__IMTCONN__' in g.steps[2].params, false);
  assert.equal(g.schedule?.kind, 'instant');
});

test('routers: one edge per route, the route filter becomes the branch condition', () => {
  const g = parseMake(fixture('router-nested'));
  assert.equal(g.steps.length, 7);
  assert.deepEqual(edges(g), ['1>2', '2>3#0', '2>4#1', '4>5#0', '4>6#1', '2>7#2']);
  const billing = g.edges.find((e) => e.to === '3')!.branch!;
  assert.equal(billing.label, 'Billing');
  assert.deepEqual(billing.condition, [[{ left: '{{1.category}}', op: 'text:equal', right: 'billing' }]]);
  assert.equal(g.edges.find((e) => e.to === '4')!.branch!.condition!.length, 2);
  assert.equal(g.edges.find((e) => e.to === '7')!.branch!.condition, undefined);
  assert.equal(g.steps.find((s) => s.id === '3')!.filter, undefined); // moved to the branch, not duplicated
});

test('a filter on a step that is not first in a route stays on the step', () => {
  const g = parseMake(fixture('filters-onerror'));
  const slack = g.steps.find((s) => s.id === '3')!;
  assert.equal(slack.filterLabel, 'Has an order');
  assert.equal(slack.filter![0].length, 2);
  assert.deepEqual(slack.filter![0][0], { left: '{{2.data.id}}', op: 'exist' });
});

test('error handlers: the directive and the modules of a custom handler route', () => {
  const g = parseMake(fixture('filters-onerror'));
  const by = (id: string) => g.steps.find((s) => s.id === id)!;
  assert.equal(by('2').onError, 'builtin:Ignore');
  assert.equal(by('3').onError, 'builtin:Break');
  assert.equal(by('4').onError, 'builtin:Resume');
  assert.deepEqual(by('4').errorHandler, ['email:ActionSendEmail']);
  assert.equal(g.steps.some((s) => s.id === '22'), false); // handler modules are not main steps
});

test('scheduling: interval and daily', () => {
  assert.deepEqual(parseMake(fixture('iterator-aggregator')).schedule, { kind: 'interval', value: 3600 });
  assert.deepEqual(parseMake(fixture('scheduled')).schedule, { kind: 'daily', value: '08:30' });
});

test('accepts a JSON string with a BOM, a {blueprint} wrapper and a one-element array', () => {
  const raw = readFileSync(new URL('./fixtures/make/basic-webhook-sheets.json', import.meta.url), 'utf8');
  assert.equal(parseMake('﻿' + raw).steps.length, 4);
  assert.equal(parseMake({ blueprint: fixture('basic-webhook-sheets') }).steps.length, 4);
  assert.equal(parseMake([fixture('basic-webhook-sheets')]).steps.length, 4);
});

test('wrong input gives a one-line InputError that says what was expected', () => {
  for (const bad of [{}, 'not json', 42, null, [], { flow: 'x' }]) {
    assert.throws(() => parseMake(bad), (e: unknown) => e instanceof InputError && /Make blueprint/.test((e as Error).message) && !(e as Error).message.includes('\n'));
  }
});

test('a Zapier export given to the Make parser points to the Zapier converter', () => {
  assert.throws(() => parseMake({ metadata: {}, zaps: [{ nodes: { 1: { selected_api: 'SlackCLIAPI' } } }] }), (e: unknown) => e instanceof InputError && /Zapier/.test((e as Error).message));
});

test('output and input field labels from the module metadata are kept', () => {
  const g = parseMake({
    name: 'x',
    flow: [{
      id: 1, module: 'google-sheets:filterRows', version: 2, mapper: {},
      metadata: {
        designer: { x: 0, y: 0 },
        interface: [{ name: '__ROW_NUMBER__', label: 'Row number' }, { name: '0', label: 'Name (A)' }, { name: '1', label: 'Email (B)', type: 'text' }],
        expect: [{ name: 'values', spec: [{ name: '0', label: 'Name (A)' }, { name: '1', label: 'Email (B)' }] }],
      },
    }],
  });
  assert.deepEqual(g.steps[0].outputFields, [{ name: '__ROW_NUMBER__', label: 'Row number' }, { name: '0', label: 'Name (A)' }, { name: '1', label: 'Email (B)' }]);
  assert.deepEqual(g.steps[0].inputFields, { values: [{ name: '0', label: 'Name (A)' }, { name: '1', label: 'Email (B)' }] });
});
