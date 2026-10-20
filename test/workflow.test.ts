import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildWorkflow, type PlannedEdge, type PlannedNode } from '../src/build/workflow.ts';
import { NODE } from '../src/map/registry.ts';

const node = (key: string, extra: Partial<PlannedNode> = {}): PlannedNode => ({
  key, wanted: key, ...NODE.noOp, parameters: {}, ...extra,
});

test('an edge becomes a main connection between the final node names', () => {
  const { workflow } = buildWorkflow('Demo', [node('A'), node('B')], [{ from: 'A', to: 'B' }]);
  assert.deepEqual(workflow.connections.A.main[0], [{ node: 'B', type: 'main', index: 0 }]);
  assert.deepEqual(workflow.settings, { executionOrder: 'v1' });
});

test('an edge from output 2 fills the lower outputs with empty lists', () => {
  const { workflow } = buildWorkflow('Demo', [node('IF'), node('C')], [{ from: 'IF', to: 'C', output: 2 }]);
  assert.equal(workflow.connections.IF.main.length, 3);
  assert.deepEqual(workflow.connections.IF.main[0], []);
  assert.equal(workflow.connections.IF.main[2][0].node, 'C');
});

test('duplicate wanted names get unique final names and connections follow them', () => {
  const { workflow, names } = buildWorkflow('Demo', [node('a', { wanted: 'Send' }), node('b', { wanted: 'Send' })], [{ from: 'a', to: 'b' }]);
  assert.equal(names.get('a'), 'Send');
  assert.equal(names.get('b'), 'Send 2');
  assert.equal(workflow.connections.Send.main[0][0].node, 'Send 2');
});

test('node ids are UUID v4', () => {
  const { workflow } = buildWorkflow('Demo', [node('A')], []);
  assert.match(workflow.nodes[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('a disabled node with a note gets a sticky note close to it', () => {
  const { workflow } = buildWorkflow('Demo', [node('A'), node('M', { disabled: true, note: 'Use the Slack node' })], [{ from: 'A', to: 'M' }]);
  const m = workflow.nodes.find((n) => n.name === 'M')!;
  assert.equal(m.disabled, true);
  const stickies = workflow.nodes.filter((n) => n.type === NODE.stickyNote.type);
  assert.equal(stickies.length, 1);
  assert.match(String(stickies[0].parameters.content), /Use the Slack node/);
  const [dx, dy] = [stickies[0].position[0] - m.position[0], stickies[0].position[1] - m.position[1]];
  assert.ok(Math.hypot(dx, dy) <= 300);
  assert.equal(workflow.connections.M, undefined); // nothing goes out of M, and stickies are never connected
});

test('source positions are kept, snapped to a 20 px grid', () => {
  const { workflow } = buildWorkflow('Demo', [node('A', { sourcePosition: [0, 0] }), node('B', { sourcePosition: [303, 11] })], [{ from: 'A', to: 'B' }]);
  assert.deepEqual(workflow.nodes[1].position, [300, 20]);
});

test('without source positions nodes are laid out left to right by depth', () => {
  const { workflow } = buildWorkflow('Demo', [node('A'), node('B'), node('C')], [{ from: 'A', to: 'B' }, { from: 'A', to: 'C' }]);
  const pos = Object.fromEntries(workflow.nodes.map((n) => [n.name, n.position]));
  assert.ok(pos.B[0] > pos.A[0]);
  assert.equal(pos.B[0], pos.C[0]);
  assert.notEqual(pos.B[1], pos.C[1]);
});

test('150 nodes in a 3-deep router tree get distinct positions quickly', () => {
  const nodes: PlannedNode[] = [node('root')];
  const edges: PlannedEdge[] = [];
  let i = 0;
  const grow = (parent: string, depth: number) => {
    for (let k = 0; k < 5 && nodes.length < 150; k++) {
      const key = `n${i++}`;
      nodes.push(node(key));
      edges.push({ from: parent, to: key, output: k });
      if (depth < 3) grow(key, depth + 1);
    }
  };
  grow('root', 1);
  while (nodes.length < 150) {
    const key = `t${i++}`;
    edges.push({ from: nodes[nodes.length - 1].key, to: key });
    nodes.push(node(key));
  }
  const t0 = performance.now();
  const { workflow } = buildWorkflow('Big', nodes, edges);
  assert.ok(performance.now() - t0 < 100);
  assert.equal(new Set(workflow.nodes.map((n) => n.position.join(','))).size, 150);
});

test('duplicate source positions fall back to the automatic layout', () => {
  const { workflow } = buildWorkflow('Demo', [node('A', { sourcePosition: [0, 0] }), node('B', { sourcePosition: [0, 0] })], [{ from: 'A', to: 'B' }]);
  assert.notDeepEqual(workflow.nodes[0].position, workflow.nodes[1].position);
});

test('retry settings and onError are copied to the node', () => {
  const { workflow } = buildWorkflow('Demo', [node('A', { onError: 'continueErrorOutput', retry: { maxTries: 3, waitBetweenTries: 5000 } })], []);
  const a = workflow.nodes[0];
  assert.equal(a.onError, 'continueErrorOutput');
  assert.equal(a.retryOnFail, true);
  assert.equal(a.maxTries, 3);
  assert.equal(a.waitBetweenTries, 5000);
});
