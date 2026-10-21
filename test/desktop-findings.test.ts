/** Found by converting the demo scenario from Claude Desktop and reading the result against n8n's sources. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { convertMake, convertZapier, defaultOutputDir } from '../src/convert.ts';
import { translateMakeExpr } from '../src/make/expr.ts';
import { translateZapierExpr } from '../src/zapier/expr.ts';
import { MAKE_OPS } from '../src/map/conditions.ts';
import { oneMake, oneZap } from './helpers/one.ts';

const m = (id: number, module: string, mapper: Record<string, unknown> = {}) => ({ id, module, version: 1, parameters: {}, mapper, metadata: {} });
const p = (n: { parameters: Record<string, unknown> }) => n.parameters as Record<string, any>;

const withOpenAi = (reader: string, mapper: Record<string, unknown> = {}) => convertMake({
  name: 'AI reply',
  flow: [
    m(1, 'gateway:CustomWebHook'),
    m(2, 'openai-gpt-3:CreateCompletion', { select: 'chat', model: 'gpt-4o-mini', messages: [{ role: 'user', content: '{{1.message}}' }], ...mapper }),
    m(3, 'util:SetVariable2', { name: 'reply', value: reader }),
  ],
  metadata: { instant: true },
});
const readerValue = (r: ReturnType<typeof convertMake>) => String(p(r.workflow.nodes.find((n) => n.name === r.report.steps.find((s) => s.sourceId === '3')!.n8nNodes.at(-1))!).assignments.assignments[0].value);

test('OpenAI answers are read where n8n puts them: output[0].content[0].text, not Make\'s choices/result', () => {
  const TEXT = "$('OpenAI: Create Completion').item.json.output[0].content[0].text";
  for (const src of ['{{2.choices[].message.content}}', '{{2.choices[1].message.content}}', '{{2.result}}']) {
    const r = withOpenAi(src);
    assert.equal(readerValue(r), `={{ ${TEXT} }}`, src);
    assert.equal(r.report.steps.find((s) => s.sourceId === '3')!.status, 'converted', src);
  }
  // Make parsed a JSON answer into result.*.
  assert.equal(readerValue(withOpenAi('{{2.result.category}}', { response_format: 'json_object' })), `={{ JSON.parse(${TEXT}).category }}`);
  // Fields n8n does not have stay flagged.
  assert.equal(withOpenAi('{{2.usage.total_tokens}}').report.steps.find((s) => s.sourceId === '3')!.status, 'review');
});

test('messages sent by n8n carry no n8n signature or workflow link (Make and Zapier added none)', () => {
  assert.equal(p(oneMake('google-email:sendAnEmail', { to: ['a@b.c'], subject: 's', bodyType: 'rawHtml', content: 'hi' }).node).options.appendAttribution, false);
  assert.equal(p(oneMake('email:ActionSendEmail', { to: ['a@b.c'], subject: 's', html: '<b>hi</b>' }).node).options.appendAttribution, false);
  assert.equal(p(oneMake('slack:CreateMessage', { channel: 'C1', text: 'hi', channelType: 'public', channelWType: 'list' }).node).otherOptions.includeLinkToWorkflow, false);
  assert.equal(p(oneMake('telegram:SendReplyMessage', { chatId: '1', text: 'hi' }).node).additionalFields.appendAttribution, false);
  // A Gmail step left for finishing by hand sends nothing yet: no option it would not show (oneMake checks the catalog).
  const draft = oneMake('google-email:ActionCreateDraft', { to: ['a@b.c'] });
  assert.equal(draft.step.status, 'manual');
  assert.equal(p(draft.node).options, undefined);
});

test('times computed from "now" or dates name the time zone to set in n8n', () => {
  const run = (value: string) => convertMake({ name: 'T', flow: [m(1, 'gateway:CustomWebHook'), m(2, 'util:SetVariable2', { name: 'x', value })], metadata: { instant: true } }).report.nextSteps.join(' ');
  assert.match(run('{{formatDate(now; "YYYY-MM-DD HH:mm")}}'), /time zone/i);
  assert.doesNotMatch(run('{{1.name}}'), /time zone/i);
});

test('a missing field is empty text in Make: no "undefined" from text functions or &', () => {
  const run = (src: string, json: Record<string, unknown>) => {
    const t = translateMakeExpr(src, { refName: () => 'A' });
    assert.ok(t.ok, src);
    return new Function('$', `return (${String(t.value).slice(4, -3)})`)(() => ({ item: { json } }));
  };
  assert.equal(run('{{capitalize(1.last)}}', {}), '');
  assert.equal(run('{{1.first & " " & 1.last}}', { first: 'John' }), 'John ');
  assert.equal(run('{{upper(1.last)}}', { last: null }), '');
  assert.equal(run('{{trim(1.first)}}', { first: 0 }), '0'); // 0 is a value
});

test('the output folder from Claude Desktop expands ${HOME}, ${DOCUMENTS} and ~ instead of becoming a relative path', () => {
  const home = homedir();
  assert.equal(defaultOutputDir({ MIGRATE_OUTPUT_DIR: '${HOME}/Documents/migrate-to-n8n' }), join(home, 'Documents', 'migrate-to-n8n'));
  assert.equal(defaultOutputDir({ MIGRATE_OUTPUT_DIR: '${DOCUMENTS}/out' }), join(home, 'Documents', 'out'));
  assert.equal(defaultOutputDir({ MIGRATE_OUTPUT_DIR: '~/out' }), join(home, 'out'));
  assert.equal(defaultOutputDir({ MIGRATE_OUTPUT_DIR: '~\\out' }), join(home, 'out'));
  assert.ok(isAbsolute(defaultOutputDir({ MIGRATE_OUTPUT_DIR: 'out' })), 'a relative folder is placed under the home folder, never the server working directory');
});

test('a missing field halfway along a path gives an empty value, as in Make, instead of stopping the run', () => {
  const run = (formula: string) => {
    const t = translateMakeExpr(formula, { refName: () => 'Webhook' });
    assert.ok(t.ok, formula);
    const body = t.value.replace(/^=\{\{ /, '').replace(/ \}\}$/, '');
    return new Function('$', `return ${body}`)(() => ({ item: { json: {} } }));
  };
  assert.equal(run('{{1.body.company.domain}}'), undefined);
  assert.equal(run('{{1.body.tags[1]}}'), undefined);
  assert.equal(run('{{1.data.rows[].id}}'), undefined);
  assert.equal(run('{{length(1.body.items)}}'), 0);
  assert.equal(run('{{join(1.body.tags; ", ")}}'), '');
  assert.equal(run('{{first(1.body.tags)}}'), undefined);
  assert.equal(run('{{last(1.body.tags)}}'), undefined);
  assert.equal(run('{{contains(1.body.tags; "x")}}'), false);
  assert.deepEqual(run('{{slice(1.body.tags; 1)}}'), []);
  assert.equal(run('{{sum(1.body.prices)}}'), 0);
  assert.deepEqual(run('{{map(1.body.items; "id")}}'), []);
});

test('a missing Zapier field halfway along a path gives an empty value instead of stopping the run', () => {
  const run = (field: string) => {
    const t = translateZapierExpr(field, { refName: () => 'Catch hook' });
    assert.ok(t.ok, field);
    return new Function('$', `return ${t.value.replace(/^=\{\{ /, '').replace(/ \}\}$/, '')}`)(() => ({ item: { json: {} } }));
  };
  assert.equal(run('{{1__company__domain}}'), undefined);
  assert.equal(run('{{1__tags__0}}'), undefined);
  assert.equal(run('{{1__lines__items[]sku}}'), undefined);
});

test('a Make yes/no condition reads the text "false" as no, like Make and n8n\'s own condition rows', () => {
  const ev = (op: string, l: unknown, r: unknown) => new Function(`return ${MAKE_OPS[op].js(JSON.stringify(l), JSON.stringify(r))}`)();
  assert.equal(ev('boolean:equal', 'false', 'true'), false);
  assert.equal(ev('boolean:equal', 'false', 'false'), true);
  assert.equal(ev('boolean:equal', 'TRUE', true), true);
  assert.equal(ev('boolean:equal', false, 'true'), false);
  assert.equal(ev('boolean:notequal', 'false', 'true'), true);
});

/** Fill an n8n `={…{{ js }}…}` text the way n8n does, with the webhook's fields in `body`. */
const fill = (template: unknown, body: Record<string, unknown>) =>
  String(template).replace(/^=/, '').replace(/\{\{ ([\s\S]+?) \}\}/g, (_, js: string) => String(new Function('$', `return ${js}`)(() => ({ item: { json: { body } } }))));

test('a quote in a value inside a JSON body text is escaped, so the body stays valid JSON', () => {
  const name = 'Bob "the builder"';
  const legacy = oneMake('http:ActionSendData', { url: 'https://x.example', method: 'post', bodyType: 'raw', contentType: 'application/json', data: '{"name": "{{1.name}}", "n": {{1.n}}}' });
  assert.deepEqual(JSON.parse(fill(p(legacy.node).jsonBody, { name, n: 2 })), { name, n: 2 });
  const http = oneMake('http:MakeRequest', { url: 'https://x.example', method: 'post', contentType: 'json', inputMethod: 'jsonString', jsonStringBodyContent: '{"name": "{{1.name}}"}' });
  assert.deepEqual(JSON.parse(fill(p(http.node).jsonBody, { name })), { name });
});

test('a value the scenario already escapes for JSON itself is not escaped twice', () => {
  const name = 'Bob "the builder"';
  const legacy = oneMake('http:ActionSendData', { url: 'https://x.example', method: 'post', bodyType: 'raw', contentType: 'application/json', data: '{"name": "{{replace(1.name; \'"\'; \'\\"\')}}"}' });
  assert.deepEqual(JSON.parse(fill(p(legacy.node).jsonBody, { name })), { name });
});

test('the Array aggregator keeps numbers and yes/no values as they are, not as text', () => {
  const r = convertMake({
    name: 'Totals',
    flow: [
      m(1, 'gateway:CustomWebHook'),
      m(2, 'builtin:BasicFeeder', { array: '{{1.items}}' }),
      { ...m(3, 'builtin:BasicAggregator'), parameters: { feeder: 2 }, mapper: { price: '{{2.price}}', paid: '{{2.paid}}', label: 'Item {{2.sku}}' } },
    ],
    metadata: { instant: true },
  });
  const fields = p(r.workflow.nodes.find((n) => n.name.endsWith('(fields)'))!);
  // the Set node's output for one item { price: 5, paid: true, sku: 'A' }, read as n8n reads it
  const item = { price: 5, paid: true, sku: 'A' };
  const $ = () => ({ item: { json: item } });
  const render = (t: unknown) => String(t).replace(/^=/, '').replace(/\{\{ ([\s\S]+?) \}\}/g, (_: string, js: string) => String(new Function('$', `return ${js}`)($)));
  const out = fields.mode === 'raw'
    ? JSON.parse(render(fields.jsonOutput))
    : Object.fromEntries(fields.assignments.assignments.map((a: { name: string; value: string; type: string }) => [a.name, a.type === 'string' ? render(a.value) : null]));
  assert.deepEqual(out, { price: 5, paid: true, label: 'Item A' });
});

test('a Zapier Formatter left for the user keeps the other fields of the item, like the converted ones', () => {
  const r = oneZap('ZapierFormatterCLIAPI', 'string', { transform: 'string.some_new_transform', inputs: '{{1__name}}' });
  assert.equal(r.step.status, 'manual');
  const code = String(p(r.node).jsCode);
  const $ = () => ({ item: { json: { body: { name: 'Ann' } } } });
  const out = new Function('$', '$json', code)($, { id: 7, email: 'a@b.c' });
  assert.deepEqual(out.json, { id: 7, email: 'a@b.c', output: 'Ann' });
});

test('Zapier Delay "release_at" is the time the wait ended, not a field the n8n Wait node lacks', () => {
  const r = oneZap('DelayCLIAPI', 'delay_for', { time_delay_for_value: '5', time_delay_for_unit: 'minutes' }, { reader: '{{2__release_at}}' });
  const value = JSON.stringify(p(r.readerNode!));
  assert.doesNotMatch(value, /release_at/);
  assert.match(value, /\$now/);
  const until = oneZap('DelayCLIAPI', 'delay_until', { time_delay_until: '{{1__when}}' }, { reader: '{{2__release_at}}' });
  assert.match(JSON.stringify(p(until.readerNode!)), /json\.body\.when/);
});

test('Zapier date formatting reads the date in its "from" time zone', () => {
  const r = oneZap('ZapierFormatterCLIAPI', 'datetime_line_item', { transform: 'date.formatting', inputs: '{{1__d}}', from_format: 'YYYY-MM-DD HH:mm', from_timezone: 'America/New_York', to_format: 'YYYY-MM-DD HH:mm', to_timezone: 'UTC' });
  const value = String(p(r.node).assignments.assignments[0].value);
  assert.match(value, /zone: 'America\/New_York'/);
});

test('Zapier Title Case also changes words written in capitals (JOHN SMITH → John Smith)', () => {
  const r = oneZap('ZapierFormatterCLIAPI', 'string', { transform: 'string.titlecase', inputs: '{{1__name}}' });
  assert.match(String(p(r.node).assignments.assignments[0].value), /\.toLowerCase\(\)\.toTitleCase\(\)/);
});

test('Make Break: the report counts retries and attempts right, names the shorter gap, and does not retry what Make did not', () => {
  const breakStep = (mapper: Record<string, unknown>, dlq?: boolean) => {
    const r = convertMake({
      name: 'B',
      flow: [m(1, 'gateway:CustomWebHook'), { ...m(2, 'http:ActionSendData', { url: 'https://x.io', method: 'get' }), onerror: [{ id: 3, module: 'builtin:Break', version: 1, parameters: {}, mapper, metadata: {} }] }],
      metadata: { instant: true, ...(dlq === undefined ? {} : { scenario: { dlq } }) },
    });
    const node = r.workflow.nodes.find((n) => n.type === 'n8n-nodes-base.httpRequest')!;
    return { node, notes: r.report.steps.find((s) => s.sourceId === '2')!.notes.join(' ') };
  };
  const on = breakStep({ count: '3', retry: true, interval: '15' }, true);
  assert.equal(on.node.maxTries, 4);
  assert.match(on.notes, /3 retries \(4 attempts\)/);
  assert.match(on.notes, /15 min/);
  const noDlq = breakStep({ count: '3', retry: true, interval: '15' }, false);
  assert.equal(noDlq.node.retryOnFail, undefined);
  assert.match(noDlq.notes, /incomplete executions/);
  const noRetry = breakStep({ count: '3', retry: false, interval: '15' }, true);
  assert.equal(noRetry.node.retryOnFail, undefined);
  assert.match(noRetry.notes, /by hand/);
});

test('problems the source itself marked reach the report', () => {
  const make = convertMake({
    name: 'Flagged',
    flow: [
      { ...m(1, 'gateway:CustomWebHook'), parameters: { hook: null } },
      { ...m(2, 'util:SetVariable2', { name: 'x', value: '' }), metadata: { designer: { x: 0, y: 0, messages: [{ category: 'reference', severity: 'error', message: 'Value must not be empty.' }, { category: 'last', severity: 'warning', message: 'A transformer should not be the last module in the route.' }] } } },
    ],
    metadata: { instant: true },
  });
  const step = (id: string) => make.report.steps.find((s) => s.sourceId === id)!;
  assert.equal(step('1').status, 'review');
  assert.match(step('1').notes.join(' '), /no webhook/i);
  assert.equal(step('2').status, 'review');
  assert.match(step('2').notes.join(' '), /Make marked this module: Value must not be empty\./);
  assert.match(step('2').notes.join(' '), /A transformer should not be the last module/);

  const [zap] = convertZapier({ zaps: [{ id: 1, title: 'Z', nodes: {
    1: { id: 1, parent_id: null, type_of: 'read', selected_api: 'WebHookCLIAPI@1.0.0', action: 'hook_v2', params: {} },
    2: { id: 2, parent_id: 1, type_of: 'write', selected_api: 'SlackCLIAPI@1.0.0', action: 'channel_message', params: { channel: 'C1', text: 'hi' }, meta: { $editor: { has_automatic_issues: true } } },
  } }] });
  const s2 = zap.report.steps.find((s) => s.sourceId === '2')!;
  assert.equal(s2.status, 'review');
  assert.match(s2.notes.join(' '), /Zapier marked this step/);
});
