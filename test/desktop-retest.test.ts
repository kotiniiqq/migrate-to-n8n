/** What the second Claude Desktop test found: Make error-handler modules missing from the workflow, a new webhook
 *  URL on every conversion, and a credential on the filter in front of a step. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkWorkflow } from '../src/build/check.ts';
import { convertMake, convertZapier } from '../src/convert.ts';
import { renderMarkdown } from '../src/report/render.ts';
import type { ConversionResult } from '../src/types.ts';

const m = (id: number, module: string, mapper: Record<string, unknown> = {}, parameters: Record<string, unknown> = {}) => ({ id, module, version: 1, parameters, mapper, metadata: {} });

/** Webhook → HTTP request (with an error handler: Set variable, then the directive) → Slack. */
const handled = (directive: string) => convertMake({
  name: 'H',
  flow: [
    m(1, 'gateway:CustomWebHook', {}, { hook: 11 }),
    { ...m(2, 'http:ActionSendData', { url: 'https://x.io', method: 'get' }), onerror: [
      { id: 7, module: 'util:SetVariable2', version: 1, parameters: {}, mapper: { name: 'failed', value: 'yes' }, metadata: { designer: { name: 'Remember the failure' } } },
      { id: 8, module: directive, version: 1, parameters: {}, mapper: {}, metadata: {} },
    ] },
    m(3, 'slack:CreateMessage', { channel: 'C1', text: 'done' }),
  ],
  metadata: { instant: true },
});

const node = (r: ConversionResult, name: string) => r.workflow.nodes.find((n) => n.name === name)!;
/** Names of the nodes that output `index` of `name` goes to. */
const next = (r: ConversionResult, name: string, index = 0) => (r.workflow.connections[name]?.main[index] ?? []).map((c) => c.node);

test('Make error-handler modules are placed on the error output, disabled, and converted like any step', () => {
  for (const directive of ['builtin:Ignore', 'builtin:Resume', 'builtin:Break']) {
    const r = handled(directive);
    const http = node(r, 'HTTP request');
    assert.equal(http.onError, 'continueErrorOutput', directive);
    assert.deepEqual(next(r, http.name, 1), ['Remember the failure'], directive);
    const h = node(r, 'Remember the failure');
    assert.equal(h.type, 'n8n-nodes-base.set', directive);
    assert.equal(h.disabled, true, directive);
    const step = r.report.steps.find((s) => s.sourceId === '7')!;
    assert.deepEqual(step.n8nNodes, ['Remember the failure']);
    assert.equal(step.status, 'review');
    assert.match(step.notes[0], /error output of "HTTP request", disabled/);
    // The checker sees what is left to do, as for every other placed step.
    assert.ok(checkWorkflow(r.workflow).some((i) => i.node === 'Remember the failure'), directive);
    assert.match(renderMarkdown(r.report), /\| Remember the failure \(`util:SetVariable2`\) \| Remember the failure \| ⚠️ review \| Make ran this when/);
    assert.doesNotMatch(r.report.steps.find((s) => s.sourceId === '2')!.notes.join(' '), /left unconnected/);
  }
});

test('after the handler the item stops (Ignore), goes on to the next step (Resume), or the run fails (Break)', () => {
  const ignore = handled('builtin:Ignore');
  assert.deepEqual(next(ignore, 'Remember the failure'), []);

  const resume = handled('builtin:Resume');
  assert.deepEqual(next(resume, 'Remember the failure'), ['Slack: Create Message']);
  assert.deepEqual(next(resume, 'HTTP request'), ['Slack: Create Message']);
  assert.match(resume.report.steps.find((s) => s.sourceId === '2')!.notes.join(' '), /goes on to the next step/);

  const brk = handled('builtin:Break');
  const [stop] = next(brk, 'Remember the failure');
  assert.equal(node(brk, stop).type, 'n8n-nodes-base.stopAndError');
  assert.equal(node(brk, stop).disabled, undefined);
  assert.equal(node(brk, 'HTTP request').retryOnFail, true);
});

test('a handler module without an automatic conversion gets the usual suggestion and counts as manual', () => {
  const r = convertMake({
    name: 'H',
    flow: [m(1, 'gateway:CustomWebHook'), { ...m(2, 'http:ActionSendData', { url: 'https://x.io', method: 'get' }), onerror: [
      { id: 7, module: 'pipedrive:createDeal', version: 1, parameters: {}, mapper: { title: 'Failed order' }, metadata: {} },
    ] }],
    metadata: { instant: true },
  });
  const step = r.report.steps.find((s) => s.sourceId === '7')!;
  assert.equal(step.status, 'manual');
  assert.match(step.suggestion ?? '', /^Make ran this when "HTTP request" failed; it is placed on the error output .*, disabled\. Use the Pipedrive node/);
  assert.equal(node(r, step.n8nNodes.at(-1)!).disabled, true);
  // Counted once, by the error-handler line, not again as a step to finish by hand.
  assert.equal(r.report.nextSteps.filter((s) => /Finish \d+ step/.test(s)).length, 0);
  assert.ok(r.report.nextSteps.some((s) => /Check 1 Make error-handler step/.test(s)));
});

test('converting the same scenario again keeps the webhook URL; two workflows of the same name still differ', () => {
  const blueprint = { name: 'Lead form', flow: [m(1, 'gateway:CustomWebHook', {}, { hook: 1450321 })], metadata: { instant: true } };
  const path = (r: ConversionResult) => r.report.webhooks[0].path;
  assert.equal(path(convertMake(blueprint)), path(convertMake(blueprint)));
  assert.match(path(convertMake(blueprint)), /^lead-form-[0-9a-f]{8}$/);
  // Another Make webhook (another hook id) under the same name gets another path.
  const other = { ...blueprint, flow: [m(1, 'gateway:CustomWebHook', {}, { hook: 99 })] };
  assert.notEqual(path(convertMake(other)), path(convertMake(blueprint)));

  const zap = (id: number) => ({ id, title: 'Untitled Zap', nodes: { 1: { id: 1, parent_id: null, type_of: 'read', selected_api: 'WebHookCLIAPI@1.0.0', action: 'hook_v2', params: {} } } });
  const [a] = convertZapier({ zaps: [zap(1)] });
  const [again] = convertZapier({ zaps: [zap(1)] });
  const [b] = convertZapier({ zaps: [zap(2)] });
  assert.equal(path(a), path(again));
  assert.notEqual(path(a), path(b));
});

test('the credential goes on the app node, not on the filter in front of it', () => {
  const r = convertMake({
    name: 'F',
    flow: [m(1, 'gateway:CustomWebHook'), { ...m(2, 'slack:CreateMessage', { channel: 'C1', text: 'hi' }), filter: { name: 'Only x', conditions: [[{ a: '{{1.x}}', o: 'exist' }]] } }],
    metadata: { instant: true },
  });
  assert.equal(node(r, 'Only x').credentials, undefined);
  assert.ok(node(r, 'Slack: Create Message').credentials?.slackApi);
  assert.deepEqual(r.report.credentials[0].nodes, ['Slack: Create Message']);
});
