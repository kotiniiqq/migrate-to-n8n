import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { checkWorkflow } from '../src/build/check.ts';
import { convertMake } from '../src/convert.ts';
import { NODE } from '../src/map/registry.ts';
import type { ConversionResult, N8nNode } from '../src/types.ts';
import { assertGolden } from './helpers/golden.ts';
import { catalogIssues } from './helpers/n8n-types.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/make/${name}.json`, import.meta.url), 'utf8'));
const FIXTURES = ['basic-webhook-sheets', 'router-nested', 'iterator-aggregator', 'filters-onerror', 'scheduled'];

const byName = (r: ConversionResult, name: string) => {
  const n = r.workflow.nodes.find((x) => x.name === name);
  assert.ok(n, `no node "${name}" in ${r.workflow.nodes.map((x) => x.name).join(', ')}`);
  return n;
};
const next = (r: ConversionResult, name: string, output = 0) => (r.workflow.connections[name]?.main[output] ?? []).map((t) => t.node);
const step = (r: ConversionResult, id: string) => r.report.steps.find((s) => s.sourceId === id)!;
const json = (n: N8nNode) => JSON.stringify(n.parameters);

for (const name of FIXTURES) {
  test(`${name}: imports cleanly, every node matches n8n's own node descriptions, every step has a status`, () => {
    const r = convertMake(fixture(name));
    assert.deepEqual(checkWorkflow(r.workflow).filter((i) => i.level === 'error'), []);
    assert.deepEqual(catalogIssues(r.workflow), []);
    const steps = r.report.steps;
    assert.equal(steps.length, fixture(name).flow.length + countNested(fixture(name).flow));
    assert.equal(r.report.totals.converted + r.report.totals.review + r.report.totals.manual, steps.length);
    for (const s of steps) if (s.status === 'manual') assert.ok(s.suggestion, `${s.sourceLabel} has no suggestion`);
  });
}

/** Modules in routes, and error-handler modules other than directives: each is a step of the report too. */
function countNested(flow: any[]): number {
  return flow.reduce((n, m) => n
    + (m.onerror ?? []).filter((h: any) => !String(h.module).startsWith('builtin:')).length
    + (m.routes ?? []).reduce((k: number, r: any) => k + r.flow.length + countNested(r.flow), 0), 0);
}

test('webhook in, set variable, respond: webhook uses a response node, references read the request body', () => {
  const r = convertMake(fixture('basic-webhook-sheets'));
  const hook = byName(r, 'Form submitted');
  assert.equal(hook.type, NODE.webhook.type);
  assert.equal(hook.parameters.responseMode, 'responseNode');
  assert.equal(hook.parameters.httpMethod, 'POST');
  assert.ok(hook.webhookId);
  assert.deepEqual(r.report.webhooks, [{ node: 'Form submitted', path: String(hook.parameters.path) }]);
  assert.equal(r.workflow.nodes[0].name, 'Form submitted'); // the webhook is the trigger, nothing is prepended
  const set = byName(r, 'Set variable');
  assert.match(json(set), /fullName/);
  assert.match(json(set), /\$\('Form submitted'\)\.item\.json\.body\.first_name/);
  assert.equal(step(r, '2').status, 'converted');
  const respond = byName(r, 'Webhook response');
  assert.equal(respond.type, NODE.respondToWebhook.type);
  assert.equal((respond.parameters.options as any).responseCode, 200);
  assert.deepEqual((respond.parameters.options as any).responseHeaders, { entries: [{ name: 'Content-Type', value: 'application/json' }] });
});

test('a reference to a step that must be finished by hand is flagged', () => {
  const r = convertMake(fixture('basic-webhook-sheets'));
  if (step(r, '3').status !== 'manual') return; // Google Sheets is mapped in a later task
  assert.equal(step(r, '4').status, 'review');
  assert.match(step(r, '4').notes.join(' '), /finished by hand/);
});

test('routers: a NoOp hub, a Filter per route condition, routes without a condition connect directly', () => {
  const r = convertMake(fixture('router-nested'));
  const router = byName(r, 'Router');
  assert.equal(router.type, NODE.noOp.type);
  const fromRouter = next(r, router.name);
  assert.equal(fromRouter.length, 3);
  assert.ok(fromRouter.includes('Billing'));
  assert.ok(fromRouter.includes('Technical'));
  assert.ok(fromRouter.includes('Parse JSON'));
  assert.equal(byName(r, 'Billing').type, NODE.filter.type);
  assert.deepEqual(next(r, 'Billing'), ['HTTP request']);
  const billing = (byName(r, 'Billing').parameters.conditions as any);
  assert.equal(billing.conditions[0].operator.operation, 'equals');
  assert.equal(billing.conditions[0].rightValue, 'billing');
  assert.equal(billing.options.version, 3);
  // two OR groups where one is case-insensitive: one boolean condition built from JavaScript
  const tech = (byName(r, 'Technical').parameters.conditions as any);
  assert.equal(tech.conditions.length, 1);
  assert.match(tech.conditions[0].leftValue, /\|\|/);
  assert.match(tech.conditions[0].leftValue, /toLowerCase\(\)\.includes/);
  assert.equal(step(r, '2').status, 'converted');
});

test('HTTP: method, URL, headers, raw JSON body; a response field "data.x" reads the body directly', () => {
  const r = convertMake(fixture('router-nested'));
  const http = byName(r, 'HTTP request');
  assert.equal(http.parameters.method, 'POST');
  assert.equal(http.parameters.url, 'https://billing.example.com/api/tickets');
  assert.equal(http.parameters.contentType, 'json');
  assert.equal(http.parameters.specifyBody, 'json');
  assert.match(String(http.parameters.jsonBody), /\{\{ JSON\.stringify\(String\(\$\('Webhook'\)\.item\.json\.body\.subject \?\? ''\)\)\.slice\(1, -1\) \}\}/);
  assert.deepEqual((http.parameters.headerParameters as any).parameters, [{ name: 'X-Source', value: 'make' }]);
  const parse = byName(r, 'Parse JSON');
  assert.equal(parse.type, NODE.set.type);
  assert.equal(parse.parameters.mode, 'raw');

  const r2 = convertMake(fixture('filters-onerror'));
  const slackFilter = byName(r2, 'Has an order');
  assert.match(json(slackFilter), /\$\('HTTP request'\)\.item\.json\.id/);
  assert.doesNotMatch(json(slackFilter), /json\.data\.id/);
});

test('iterator and aggregator: Split Out the array, collect items into "array" like Make', () => {
  const r = convertMake(fixture('iterator-aggregator'));
  const trigger = r.workflow.nodes[0];
  assert.equal(trigger.type, NODE.scheduleTrigger.type);
  assert.deepEqual((trigger.parameters.rule as any).interval, [{ field: 'hours', hoursInterval: 1 }]);
  const split = byName(r, 'Iterator');
  assert.equal(split.type, NODE.splitOut.type);
  assert.equal(split.parameters.fieldToSplitOut, 'items');
  assert.deepEqual(next(r, 'HTTP request'), ['Iterator']);
  assert.match(json(byName(r, 'Set variable')), /\$\('Iterator'\)\.item\.json\.name/);
  const agg = byName(r, 'Array aggregator');
  assert.equal(agg.type, NODE.aggregate.type);
  assert.equal(agg.parameters.destinationFieldName, 'array');
  assert.match(json(byName(r, 'HTTP request 2')), /Array aggregator'\)\.item\.json\.array \?\? \[\]\)\.map\(e => e\?\.line\)/);
  assert.equal(r.report.totals.manual, 0);
});

test('error handlers: Ignore stops the item, Break retries, a custom handler route is flagged', () => {
  const r = convertMake(fixture('filters-onerror'));
  assert.equal(byName(r, 'HTTP request').onError, 'continueErrorOutput');
  assert.equal(next(r, 'HTTP request', 1).length, 0); // error output left open = Make "Ignore"
  assert.match(step(r, '3').notes.join(' '), /retr/i);
  assert.equal(step(r, '4').status === 'converted', false);
  assert.match(step(r, '4').notes.join(' '), /error/i);
  assert.match(step(r, '4').notes.join(' '), /Email: Send Email/);
});

test('a filter between steps becomes a Filter node with AND conditions', () => {
  const r = convertMake(fixture('filters-onerror'));
  const f = byName(r, 'Has an order');
  const c = (f.parameters.conditions as any);
  assert.equal(c.combinator, 'and');
  assert.deepEqual(c.conditions.map((x: any) => x.operator.operation), ['exists', 'gte']);
  assert.equal(c.conditions[1].operator.type, 'number');
  assert.equal(c.conditions[1].rightValue, 100);
  assert.deepEqual(next(r, 'HTTP request'), ['Has an order']);
});

test('scheduled scenario: daily trigger at 08:30, form body, wait in seconds, date filter', () => {
  const r = convertMake(fixture('scheduled'));
  const trigger = r.workflow.nodes[0];
  assert.equal(trigger.type, NODE.scheduleTrigger.type);
  assert.deepEqual((trigger.parameters.rule as any).interval, [{ field: 'days', triggerAtHour: 8, triggerAtMinute: 30 }]);
  const http = byName(r, 'HTTP request');
  assert.equal(http.parameters.contentType, 'form-urlencoded');
  assert.equal((http.parameters.bodyParameters as any).parameters[0].name, 'invoice');
  const wait = byName(r, 'Sleep');
  assert.equal(wait.type, NODE.wait.type);
  assert.equal(wait.parameters.amount, 5);
  assert.equal(wait.parameters.unit, 'seconds');
  const f = byName(r, 'Overdue');
  assert.equal((f.parameters.conditions as any).conditions[0].operator.type, 'dateTime');
  assert.equal((f.parameters.conditions as any).conditions[0].operator.operation, 'before');
});

test('the report lists next steps and is consistent', () => {
  const r = convertMake(fixture('basic-webhook-sheets'));
  assert.equal(r.report.source, 'make');
  assert.equal(r.report.workflowName, 'Leads from the website form');
  assert.ok(r.report.nextSteps.some((s) => /webhook/i.test(s)));
  for (const s of r.report.steps) for (const n of s.n8nNodes) byName(r, n);
});

for (const name of FIXTURES) {
  test(`${name}: matches the reviewed golden conversion`, () => {
    assertGolden(new URL(`./golden/make/${name}.json`, import.meta.url), convertMake(fixture(name)));
  });
}
