import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkWorkflow } from '../src/build/check.ts';
import { buildWorkflow } from '../src/build/workflow.ts';
import { NODE } from '../src/map/registry.ts';

const rules = (issues: ReturnType<typeof checkWorkflow>, level: 'error' | 'warning' | 'info') =>
  [...new Set(issues.filter((i) => i.level === level).map((i) => i.rule))].sort();

test('a good workflow has no errors or warnings', () => {
  const { workflow } = buildWorkflow('Good', [
    { key: 'hook', wanted: 'Webhook', ...NODE.webhook, parameters: { path: 'x' } },
    { key: 'set', wanted: 'Set', ...NODE.set, parameters: {} },
  ], [{ from: 'hook', to: 'set' }]);
  assert.deepEqual(rules(checkWorkflow(workflow), 'error'), []);
  assert.deepEqual(rules(checkWorkflow(workflow), 'warning'), []);
});

test('something that is not a workflow is one shape error', () => {
  assert.deepEqual(checkWorkflow({ hello: 1 }).map((i) => i.rule), ['shape']);
  assert.deepEqual(checkWorkflow('text').map((i) => i.rule), ['shape']);
});

test('each broken rule is reported once', () => {
  const bad = {
    name: 'Bad',
    nodes: [
      { id: '1', name: 'A', type: NODE.set.type, typeVersion: 3.4, position: [0, 0], parameters: { url: 'https://REPLACE-ME.example' } },
      { id: '2', name: 'A', type: NODE.slack.type, typeVersion: 2.4, position: [200, 0], parameters: {}, credentials: { slackApi: { name: 'Slack' } } },
      { id: '3', name: 'M', type: NODE.code.type, typeVersion: 2, position: [400, 0], parameters: {}, disabled: true },
    ],
    connections: { A: { main: [[{ node: 'Ghost', type: 'main', index: 0 }]] }, Nope: { main: [[]] } },
  };
  assert.deepEqual(rules(checkWorkflow(bad), 'error'), ['connections', 'unique-names']);
  assert.deepEqual(rules(checkWorkflow(bad), 'warning'), ['credentials', 'placeholder']);
  assert.deepEqual(rules(checkWorkflow(bad), 'info'), ['disabled', 'trigger']);
});
