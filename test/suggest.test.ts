import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkWorkflow } from '../src/build/check.ts';
import { convertMake } from '../src/convert.ts';
import { NODE } from '../src/map/registry.ts';
import { catalogIssues } from './helpers/n8n-types.ts';

const blueprint = (modules: Array<Record<string, unknown>>) => ({
  name: 'Suggest',
  flow: modules.map((m, i) => ({ id: i + 1, version: 1, parameters: {}, metadata: { designer: { x: i * 300, y: 0 } }, ...m })),
  metadata: { instant: true },
});

const hook = { module: 'gateway:CustomWebHook', parameters: { hook: 1 }, mapper: {} };

test('an app with an n8n node: the node is placed disabled, with the fields to map in the suggestion', () => {
  const r = convertMake(blueprint([hook, { module: 'trello:createCard', mapper: { name: '{{1.title}}', idList: 'abc123', desc: 'From the form' } }]));
  const s = r.report.steps[1];
  assert.equal(s.status, 'manual');
  const node = r.workflow.nodes.find((n) => n.name === s.n8nNodes.at(-1))!;
  assert.equal(node.type, 'n8n-nodes-base.trello');
  assert.equal(node.disabled, true);
  assert.match(s.suggestion!, /Trello node/);
  assert.match(s.suggestion!, /create Card/i);
  assert.match(s.suggestion!, /name ← \{\{ \$\('Webhook'\)\.item\.json\.body\.title \}\}/);
  assert.match(s.suggestion!, /idList ← abc123/);
  const sticky = r.workflow.nodes.find((n) => n.type === NODE.stickyNote.type)!;
  assert.match(String(sticky.parameters.content), /Trello/);
});

test('an app with a known API but no n8n node: a disabled HTTP Request with the method guessed and a placeholder', () => {
  const r = convertMake(blueprint([hook, { module: 'apify:runActor', mapper: { actorId: 'x' } }]));
  const s = r.report.steps[1];
  const node = r.workflow.nodes.find((n) => n.name === s.n8nNodes.at(-1))!;
  assert.equal(node.type, NODE.httpRequest.type);
  assert.equal(node.disabled, true);
  assert.equal(node.parameters.method, 'POST');
  assert.equal(node.parameters.url, 'https://api.apify.com/v2/REPLACE-ME');
  assert.deepEqual(r.report.placeholders, [{ node: node.name, field: 'url', value: 'https://api.apify.com/v2/REPLACE-ME' }]);
  assert.match(s.suggestion!, /API/);
});

test('an unknown app: a disabled Code node that already collects the mapped inputs', () => {
  const r = convertMake(blueprint([hook, { module: 'app#custom-app-oonbtb:getTaskStatus', mapper: { taskId: '{{1.id}}' } }]));
  const s = r.report.steps[1];
  const node = r.workflow.nodes.find((n) => n.name === s.n8nNodes.at(-1))!;
  assert.equal(node.type, NODE.code.type);
  assert.equal(node.disabled, true);
  assert.match(String(node.parameters.jsCode), /taskId: \$\('Webhook'\)\.item\.json\.body\.id/);
  assert.match(s.suggestion!, /no n8n node/i);
});

test('manual steps keep the workflow connected and valid', () => {
  const r = convertMake(blueprint([hook, { module: 'trello:createCard', mapper: {} }, { module: 'util:SetVariable2', mapper: { name: 'x', value: '1' } }]));
  assert.deepEqual(checkWorkflow(r.workflow).filter((i) => i.level === 'error'), []);
  assert.deepEqual(catalogIssues(r.workflow), []);
  const trello = r.report.steps[1].n8nNodes.at(-1)!;
  assert.deepEqual(r.workflow.connections[trello].main[0].map((t) => t.node), ['Set variable']);
  for (const s of r.report.steps) if (s.status === 'manual') assert.ok(s.suggestion);
});

test('an unmapped first step keeps the schedule in front and mentions the app trigger', () => {
  const r = convertMake({ ...blueprint([{ module: 'airtable:watchRecords', mapper: { base: 'x' } }, { module: 'util:SetVariable2', mapper: { name: 'x', value: '1' } }]), metadata: { instant: false }, scheduling: { type: 'indefinitely', interval: 900 } });
  const s = r.report.steps[0];
  assert.equal(s.status, 'manual');
  const node = r.workflow.nodes.find((n) => n.name === s.n8nNodes.at(-1))!;
  assert.equal(node.type, 'n8n-nodes-base.airtable');
  assert.equal(r.workflow.nodes[0].type, NODE.scheduleTrigger.type);
  assert.deepEqual(r.workflow.connections[r.workflow.nodes[0].name].main[0].map((t) => t.node), [node.name]);
  assert.match(s.suggestion!, /Airtable Trigger/);
});

test('an app whose only n8n node is a trigger: placed first, disabled, with nothing connected into it', () => {
  const r = convertMake(blueprint([{ module: 'typeform:WatchEventsWithResponses', mapper: { formId: 'abc' } }, { module: 'util:SetVariable2', mapper: { name: 'x', value: '1' } }]));
  const s = r.report.steps[0];
  const node = r.workflow.nodes.find((n) => n.name === s.n8nNodes.at(-1))!;
  assert.equal(node.type, 'n8n-nodes-base.typeformTrigger');
  assert.equal(Object.values(r.workflow.connections).some((c) => c.main.flat().some((t) => t.node === node.name)), false);
  assert.deepEqual(checkWorkflow(r.workflow).filter((i) => i.level === 'error'), []);
});

test('a trigger-only app in the middle of a flow becomes a Code stub, never a trigger with an input', () => {
  const r = convertMake(blueprint([hook, { module: 'typeform:ListResponses', mapper: { formId: 'abc' } }]));
  const node = r.workflow.nodes.find((n) => n.name === r.report.steps[1].n8nNodes.at(-1))!;
  assert.notEqual(node.type, 'n8n-nodes-base.typeformTrigger');
});

test('suggestions translate list values too and name the action in plain words', () => {
  const r = convertMake(blueprint([hook, { module: 'trello:createCardFromTemplate', mapper: { labels: ['{{1.tag}}', 'fixed'] } }]));
  const s = r.report.steps[1].suggestion!;
  assert.match(s, /"Create card from template"/);
  assert.match(s, /labels ← \["=\{\{ \$\('Webhook'\)\.item\.json\.body\.tag \}\}","fixed"\]/);
});
