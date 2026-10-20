/** Assemble an n8n workflow from planned nodes and edges: final names, ids, connections, layout, notes. */
import { randomUUID } from 'node:crypto';

import { NODE } from '../map/registry.ts';
import type { N8nNode, N8nWorkflow } from '../types.ts';
import { uniqueName } from '../util/names.ts';

export interface PlannedNode {
  /** Unique within one build; edges refer to it. */
  key: string;
  wanted: string;
  type: string;
  typeVersion: number;
  parameters: Record<string, unknown>;
  credentials?: N8nNode['credentials'];
  disabled?: boolean;
  onError?: N8nNode['onError'];
  /** Shown as a sticky note next to the node (used for manual steps). */
  note?: string;
  sourcePosition?: [number, number];
  webhookId?: string;
}

export interface PlannedEdge {
  from: string;
  to: string;
  output?: number;
}

const GRID = 20;
const X_STEP = 260;
const Y_STEP = 180;

const snap = (v: number) => Math.round(v / GRID) * GRID;

/** Left-to-right layers: x by longest distance from a start node, y by order within the layer. */
function autoLayout(nodes: PlannedNode[], edges: PlannedEdge[]): Map<string, [number, number]> {
  const incoming = new Map<string, number>(nodes.map((n) => [n.key, 0]));
  const out = new Map<string, PlannedEdge[]>();
  for (const e of edges) {
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
    out.set(e.from, [...(out.get(e.from) ?? []), e]);
  }
  const depth = new Map<string, number>();
  // Kahn's order; a cycle (should not happen) leaves its nodes at depth 0 below.
  const queue = nodes.filter((n) => !incoming.get(n.key)).map((n) => n.key);
  for (const k of queue) depth.set(k, 0);
  const remaining = new Map(incoming);
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i];
    const children = [...(out.get(k) ?? [])].sort((a, b) => (a.output ?? 0) - (b.output ?? 0));
    for (const e of children) {
      depth.set(e.to, Math.max(depth.get(e.to) ?? 0, depth.get(k)! + 1));
      remaining.set(e.to, remaining.get(e.to)! - 1);
      if (remaining.get(e.to) === 0) queue.push(e.to);
    }
  }
  const order = new Map(queue.map((k, i) => [k, i]));
  const layers = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.key) ?? 0;
    layers.set(d, [...(layers.get(d) ?? []), n.key]);
  }
  const pos = new Map<string, [number, number]>();
  for (const [d, keys] of layers) {
    keys.sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
    keys.forEach((k, i) => pos.set(k, [d * X_STEP, (i - (keys.length - 1) / 2) * Y_STEP].map(snap) as [number, number]));
  }
  return pos;
}

function layout(nodes: PlannedNode[], edges: PlannedEdge[]): Map<string, [number, number]> {
  if (nodes.every((n) => n.sourcePosition)) {
    const pos = new Map(nodes.map((n) => [n.key, n.sourcePosition!.map(snap) as [number, number]]));
    if (new Set([...pos.values()].map((p) => p.join(','))).size === nodes.length) return pos;
  }
  return autoLayout(nodes, edges);
}

export function buildWorkflow(name: string, planned: PlannedNode[], edges: PlannedEdge[]): { workflow: N8nWorkflow; names: Map<string, string> } {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const p of planned) {
    if (names.has(p.key)) throw new Error(`duplicate planned node key: ${p.key}`);
    const n = uniqueName(p.wanted, taken);
    taken.add(n);
    names.set(p.key, n);
  }
  const pos = layout(planned, edges);
  const nodes: N8nNode[] = [];
  for (const p of planned) {
    const node: N8nNode = {
      id: randomUUID(),
      name: names.get(p.key)!,
      type: p.type,
      typeVersion: p.typeVersion,
      position: pos.get(p.key)!,
      parameters: p.parameters,
    };
    if (p.credentials) node.credentials = p.credentials;
    if (p.disabled) node.disabled = true;
    if (p.onError) node.onError = p.onError;
    if (p.webhookId) node.webhookId = p.webhookId;
    nodes.push(node);
  }
  for (const p of planned) {
    if (!p.note) continue;
    const [x, y] = pos.get(p.key)!;
    const note = uniqueName(`Note: ${names.get(p.key)}`, taken);
    taken.add(note);
    nodes.push({
      id: randomUUID(),
      name: note,
      type: NODE.stickyNote.type,
      typeVersion: NODE.stickyNote.typeVersion,
      position: [x - 40, y - 220],
      parameters: { content: `### ⚠ ${names.get(p.key)}\n${p.note}`, height: 200, width: 320, color: 3 },
    });
  }
  const connections: N8nWorkflow['connections'] = {};
  for (const e of edges) {
    const from = names.get(e.from);
    const to = names.get(e.to);
    if (!from || !to) throw new Error(`edge refers to an unknown node: ${e.from} -> ${e.to}`);
    const main = (connections[from] ??= { main: [] }).main;
    const output = e.output ?? 0;
    while (main.length <= output) main.push([]);
    main[output].push({ node: to, type: 'main', index: 0 });
  }
  return { workflow: { name, nodes, connections, settings: { executionOrder: 'v1' }, pinData: {} }, names };
}
