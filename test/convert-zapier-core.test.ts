import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { checkWorkflow } from '../src/build/check.ts';
import { convertZapier } from '../src/convert.ts';
import { NODE } from '../src/map/registry.ts';
import { InputError, type ConversionResult } from '../src/types.ts';
import { assertGolden } from './helpers/golden.ts';
import { catalogIssues } from './helpers/n8n-types.ts';

const exportFile = () => JSON.parse(readFileSync(new URL('./fixtures/zapier/export-basic.json', import.meta.url), 'utf8'));
const byName = (r: ConversionResult, name: string) => {
  const n = r.workflow.nodes.find((x) => x.name === name);
  assert.ok(n, `no node "${name}" in ${r.workflow.nodes.map((x) => x.name).join(', ')}`);
  return n;
};
const next = (r: ConversionResult, name: string) => (r.workflow.connections[name]?.main[0] ?? []).map((t) => t.node);
const step = (r: ConversionResult, id: string) => r.report.steps.find((s) => s.sourceId === id)!;
const json = (r: ConversionResult, name: string) => JSON.stringify(byName(r, name).parameters);

test('every zap: imports cleanly, matches n8n node descriptions, every step has a status', () => {
  const results = convertZapier(exportFile());
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.report.source, 'zapier');
    assert.deepEqual(checkWorkflow(r.workflow).filter((i) => i.level === 'error'), []);
    assert.deepEqual(catalogIssues(r.workflow), []);
    for (const s of r.report.steps) if (s.status === 'manual') assert.ok(s.suggestion);
  }
});

test('choose zaps by id or title', () => {
  assert.deepEqual(convertZapier(exportFile(), { zaps: ['301002'] }).map((r) => r.workflow.name), ['Daily totals']);
  assert.deepEqual(convertZapier(exportFile(), { zaps: ['lead routing'] }).map((r) => r.workflow.name), ['Lead routing']);
  assert.throws(() => convertZapier(exportFile(), { zaps: ['nope'] }), (e: unknown) => e instanceof InputError && /Lead routing/.test((e as Error).message));
});

test('catch hook → webhook; fields read from the request body', () => {
  const [r] = convertZapier(exportFile());
  const hook = r.workflow.nodes[0];
  assert.equal(hook.type, NODE.webhook.type);
  assert.equal(hook.name, 'New lead');
  assert.match(json(r, 'Send to the German CRM'), /\$\('New lead'\)\.item\.json\.body\.email/);
});

test('Filter by Zapier: groups joined by OR keep their exact logic', () => {
  const [r] = convertZapier(exportFile());
  const f = byName(r, 'Only real leads');
  assert.equal(f.type, NODE.filter.type);
  const c = (f.parameters.conditions as any).conditions;
  assert.equal(c.length, 1);
  assert.match(c[0].leftValue, /\) \|\| \(/);
  assert.match(c[0].leftValue, /!\(String\(.*\.toLowerCase\(\)\.includes/);
  assert.equal(step(r, '2').status, 'converted');
});

test('Formatter text: title case into "output"', () => {
  const [r] = convertZapier(exportFile());
  const f = byName(r, 'Name in title case');
  assert.equal(f.type, NODE.set.type);
  assert.match(json(r, 'Name in title case'), /"name":"output"/);
  assert.match(json(r, 'Name in title case'), /toTitleCase\(\)/);
});

test('Paths: a NoOp hub, one Filter per path condition, the open path connects directly', () => {
  const [r] = convertZapier(exportFile());
  const hub = byName(r, 'Paths');
  assert.equal(hub.type, NODE.noOp.type);
  assert.deepEqual(next(r, 'Paths').sort(), ['Big corporate', 'Germany', 'Wait a bit']);
  assert.deepEqual(next(r, 'Germany'), ['Send to the German CRM']);
  const big = (byName(r, 'Big corporate').parameters.conditions as any);
  assert.equal(big.combinator, 'and');
  assert.deepEqual(big.conditions.map((c: any) => c.operator.operation), ['gt', 'contains']);
  assert.equal(big.options.caseSensitive, false);
});

test('webhook POST: JSON body from the data fields, headers; GET: query parameters', () => {
  const [r] = convertZapier(exportFile());
  const post = byName(r, 'Send to the German CRM');
  assert.equal(post.parameters.method, 'POST');
  assert.equal(post.parameters.contentType, 'json');
  assert.match(String(post.parameters.jsonBody), /"tags": \$\('New lead'\)\.item\.json\.body\.tags\?\.\[0\]/);
  assert.deepEqual((post.parameters.headerParameters as any).parameters, [{ name: 'X-Api-Key', value: 'abc123' }]);
  const get = byName(r, 'Look up the company');
  assert.equal(get.parameters.method, 'GET');
  assert.equal((get.parameters.queryParameters as any).parameters[0].name, 'domain');
});

test('Delay for 5 minutes → Wait', () => {
  const [r] = convertZapier(exportFile());
  const w = byName(r, 'Wait a bit');
  assert.equal(w.type, NODE.wait.type);
  assert.equal(w.parameters.amount, 5);
  assert.equal(w.parameters.unit, 'minutes');
});

test('Schedule every day at 9 → Schedule trigger', () => {
  const [, r] = convertZapier(exportFile());
  const t = r.workflow.nodes[0];
  assert.equal(t.type, NODE.scheduleTrigger.type);
  assert.deepEqual((t.parameters.rule as any).interval, [{ field: 'cronExpression', expression: '0 9 * * 1-5' }]);
  assert.match(step(r, '1').notes.join(' '), /weekend/i);
});

test('Code by Zapier (JavaScript): inputs in a Set node, the code wrapped so inputData and output work', () => {
  const [, r] = convertZapier(exportFile());
  const s = step(r, '2');
  assert.equal(s.status, 'review');
  assert.equal(s.n8nNodes.length, 2);
  const inputs = byName(r, s.n8nNodes[0]);
  assert.equal(inputs.type, NODE.set.type);
  assert.match(JSON.stringify(inputs.parameters), /"name":"base"/);
  const code = byName(r, 'Add one');
  assert.equal(code.type, NODE.code.type);
  assert.match(String(code.parameters.jsCode), /const inputData = \$json;/);
  assert.match(String(code.parameters.jsCode), /output = \{ next: n \};/);
});

test('Code by Zapier (Python) is placed for finishing by hand with the original code', () => {
  const [, r] = convertZapier(exportFile());
  const s = step(r, '4');
  assert.equal(s.status, 'manual');
  const code = byName(r, 'Python step');
  assert.equal(code.disabled, true);
  assert.equal(code.parameters.language, 'pythonNative'); // the only Python mode both n8n 1.123 and 2.44 have
  assert.match(String(code.parameters.pythonCode), /int\(input_data\['value'\]\) \* 2/);
});

test('Storage set value → workflow static data, flagged for review', () => {
  const [, r] = convertZapier(exportFile());
  const code = byName(r, 'Remember');
  assert.match(String(code.parameters.jsCode), /\$getWorkflowStaticData\('global'\)/);
  assert.equal(step(r, '3').status, 'review');
});

test('Formatter date formatting → Luxon format in the target time zone', () => {
  const [, r] = convertZapier(exportFile());
  assert.match(json(r, 'Format date'), /setZone\('Europe\/Berlin'\)\.toFormat\('yyyy-LL-dd'\)/);
});

test('matches the reviewed golden conversions', () => {
  const results = convertZapier(exportFile());
  results.forEach((r, i) => assertGolden(new URL(`./golden/zapier/export-basic-${i + 1}.json`, import.meta.url), r));
});
