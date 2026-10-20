/** Convert one Make module (after a webhook) and return what it became, already checked against n8n. */
import assert from 'node:assert/strict';

import { checkWorkflow } from '../../src/build/check.ts';
import { convertMake, convertZapier } from '../../src/convert.ts';
import type { ConversionResult, N8nNode, StepReport } from '../../src/types.ts';
import { catalogIssues } from './n8n-types.ts';

export interface One {
  result: ConversionResult;
  step: StepReport;
  /** The node that holds the step's output (the last one). */
  node: N8nNode;
  nodes: N8nNode[];
  /** The report of a later step that reads this step's output, when `reader` was given. */
  readerStep?: StepReport;
  readerNode?: N8nNode;
}

export function oneMake(module: string, mapper: Record<string, unknown>, opts: { parameters?: Record<string, unknown>; first?: boolean; reader?: string; metadata?: Record<string, unknown> } = {}): One {
  const mod = { id: 2, module, version: 1, parameters: opts.parameters ?? {}, mapper, metadata: { designer: { x: 300, y: 0 }, ...(opts.metadata ?? {}) } };
  const flow: Array<Record<string, unknown>> = opts.first ? [{ ...mod, id: 1 }] : [{ id: 1, module: 'gateway:CustomWebHook', version: 1, parameters: { hook: 1 }, mapper: {}, metadata: {} }, mod];
  if (opts.reader) flow.push({ id: 9, module: 'util:SetVariable2', version: 1, mapper: { name: 'read', value: opts.reader }, metadata: {} });
  const result = convertMake({ name: 'One', flow, metadata: { instant: !opts.first } });
  assert.deepEqual(checkWorkflow(result.workflow).filter((i) => i.level === 'error'), []);
  assert.deepEqual(catalogIssues(result.workflow), []);
  const id = opts.first ? '1' : '2';
  const step = result.report.steps.find((s) => s.sourceId === id)!;
  const nodes = step.n8nNodes.map((n) => result.workflow.nodes.find((x) => x.name === n)!);
  const out: One = { result, step, node: nodes[nodes.length - 1], nodes };
  if (opts.reader) {
    out.readerStep = result.report.steps.find((s) => s.sourceId === '9');
    out.readerNode = result.workflow.nodes.find((x) => x.name === out.readerStep!.n8nNodes.at(-1));
  }
  return out;
}

/** Convert one Zapier step (after a catch hook) and return what it became, checked against n8n. */
export function oneZap(api: string, action: string, params: Record<string, unknown>, opts: { first?: boolean; reader?: string } = {}): One {
  const nodes: Record<string, unknown> = {};
  if (!opts.first) nodes[1] = { id: 1, parent_id: null, type_of: 'read', selected_api: 'WebHookCLIAPI@1.0.0', action: 'hook_v2', title: 'Webhook', params: {} };
  const id = opts.first ? 1 : 2;
  nodes[id] = { id, parent_id: opts.first ? null : 1, type_of: opts.first ? 'read' : 'write', selected_api: `${api}@1.0.0`, action, params };
  if (opts.reader) nodes[9] = { id: 9, parent_id: id, type_of: 'write', selected_api: 'ZapierFormatterCLIAPI@1.0.0', action: 'text_line_item', title: 'Reader', params: { transform: 'string.trim_space', inputs: opts.reader } };
  const [result] = convertZapier({ zaps: [{ id: 1, title: 'One', nodes }] });
  assert.deepEqual(checkWorkflow(result.workflow).filter((i) => i.level === 'error'), []);
  assert.deepEqual(catalogIssues(result.workflow), []);
  const step = result.report.steps.find((s) => s.sourceId === String(id))!;
  const ns = step.n8nNodes.map((n) => result.workflow.nodes.find((x) => x.name === n)!);
  const out: One = { result, step, node: ns[ns.length - 1], nodes: ns };
  if (opts.reader) {
    out.readerStep = result.report.steps.find((s) => s.sourceId === '9');
    out.readerNode = result.workflow.nodes.find((x) => x.name === out.readerStep!.n8nNodes.at(-1));
  }
  return out;
}
