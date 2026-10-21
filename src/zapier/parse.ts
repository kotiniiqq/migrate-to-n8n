/** Zapier export (Settings → Security and data → Download my Zap workflows) → one source graph per zap. */
import { InputError, type Condition, type ConditionGroup, type SourceEdge, type SourceGraph, type SourceStep } from '../types.ts';

interface ZapNode {
  id: number | string;
  parent_id?: number | string | null;
  type_of?: string;
  selected_api?: string | null;
  action?: string | null;
  title?: string | null;
  params?: Record<string, unknown> | null;
  authentication_id?: number | string | null;
  paused?: boolean;
  meta?: { $editor?: { has_automatic_issues?: boolean } } | null;
}
interface Zap {
  id?: number | string;
  title?: string;
  status?: string;
  nodes: ZapNode[];
}

const NOT_AN_EXPORT = 'This is not a Zapier export: expected the file from Zapier → Settings → Security and data → Download my Zap workflows.';

function nodesOf(zap: unknown): ZapNode[] | undefined {
  const n = (zap as { nodes?: unknown })?.nodes;
  const list = Array.isArray(n) ? n : n && typeof n === 'object' ? Object.values(n) : undefined;
  return list?.filter((x): x is ZapNode => !!x && typeof x === 'object' && 'id' in x);
}

function zapsOf(input: unknown): Zap[] {
  let v = input;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v.replace(/^﻿/, ''));
    } catch {
      throw new InputError(NOT_AN_EXPORT);
    }
  }
  if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as { flow?: unknown }).flow)) {
    throw new InputError('This looks like a Make blueprint, not a Zapier export: convert it as Make (convert_make).');
  }
  const list = Array.isArray(v) ? v : Array.isArray((v as { zaps?: unknown })?.zaps) ? (v as { zaps: unknown[] }).zaps : v && typeof v === 'object' ? [v] : [];
  const zaps = list
    .map((z) => ({ z: z as Record<string, unknown>, nodes: nodesOf(z) }))
    .filter((x) => x.nodes?.length)
    .map(({ z, nodes }) => ({ id: z.id as string | number | undefined, title: z.title as string | undefined, status: z.status as string | undefined, nodes: nodes! }));
  if (!zaps.length) throw new InputError(NOT_AN_EXPORT);
  return zaps;
}

const humanize = (s: string) => s.replace(/[-_]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
const apiName = (api: string) => api.replace(/@.*$/, '');

const LABELS: Record<string, string> = {
  'BranchingAPI:branch': 'Paths', 'FilterAPI:filter': 'Filter', 'WebHookCLIAPI:hook_v2': 'Catch hook', 'WebHookCLIAPI:hook': 'Catch hook',
  'WebHookCLIAPI:hook_raw': 'Catch raw hook', 'WebHookCLIAPI:post': 'POST request', 'WebHookCLIAPI:get': 'GET request',
  'WebHookCLIAPI:put': 'PUT request', 'WebHookCLIAPI:custom_request': 'Custom request',
};
const APP_NAMES: Record<string, string> = {
  WebHookCLIAPI: 'Webhooks', ZapierFormatterCLIAPI: 'Formatter', CodeCLIAPI: 'Code', DelayCLIAPI: 'Delay', StorageCLIAPI: 'Storage',
  ScheduleAPI: 'Schedule', LoopingCLIAPI: 'Looping', EmailCLIAPI: 'Email', AICLIAPI: 'AI by Zapier', FilterAPI: 'Filter', BranchingAPI: 'Paths',
};

/** The name Zapier would show for a step key. */
export function zapierLabel(key: string): string {
  if (LABELS[key]) return LABELS[key];
  const [api, ...rest] = key.split(':');
  const app = APP_NAMES[api] ?? humanize(api.replace(/(V\d+)?(CLI)?API$/i, ''));
  const action = rest.join(':');
  // Newer Zapier actions (Code by Zapier among them) are stored as a UUID, not a name.
  if (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(action)) {
    if (api === 'CodeCLIAPI') return /^01929fad-d3f6/i.test(action) ? 'Code: run Python' : 'Code: run JavaScript';
    return app;
  }
  return `${app}: ${humanize(action)}`;
}

/** Zapier filter criteria → OR of AND groups. `match` is the operator, `action: stop` negates it. */
export function criteria(params: Record<string, unknown> | null | undefined): ConditionGroup | undefined {
  const list = Array.isArray(params?.filter_criteria) ? (params!.filter_criteria as Array<Record<string, unknown>>) : [];
  const groups = new Map<string, Condition[]>();
  for (const c of list) {
    if (!c || !c.key || !c.match) continue;
    const key = String(c.key);
    const cond: Condition = { left: key.startsWith('{{') ? key : `{{${key}}}`, op: `${c.match}:${c.action === 'stop' ? 'stop' : 'continue'}`, right: c.value === undefined || c.value === null ? '' : String(c.value) };
    const g = String(c.group ?? 'default');
    groups.set(g, [...(groups.get(g) ?? []), cond]);
  }
  return groups.size ? [...groups.values()] : undefined;
}

function toStep(n: ZapNode): SourceStep {
  const app = apiName(String(n.selected_api ?? 'Unknown'));
  const action = String(n.action ?? '');
  const key = `${app}:${action}`;
  const step: SourceStep = { id: String(n.id), key, app, action, label: n.title?.trim() || zapierLabel(key), params: { ...(n.params ?? {}) } };
  if (n.authentication_id !== null && n.authentication_id !== undefined) step.connectionRef = String(n.authentication_id);
  if (n.meta?.$editor?.has_automatic_issues === true) step.flagged = [{ text: 'Zapier marked this step as having problems (unfinished or failing in Zapier): check its settings.', serious: true }];
  return step;
}

function graphOf(zap: Zap): SourceGraph {
  const byParent = new Map<string, ZapNode[]>();
  for (const n of zap.nodes) {
    const p = n.parent_id === null || n.parent_id === undefined ? '' : String(n.parent_id);
    byParent.set(p, [...(byParent.get(p) ?? []), n]);
  }
  const order = (a: ZapNode, b: ZapNode) =>
    Number((a.params as { path_eval_index?: number })?.path_eval_index ?? 0) - Number((b.params as { path_eval_index?: number })?.path_eval_index ?? 0) || Number(a.id) - Number(b.id);
  const steps: SourceStep[] = [];
  const edges: SourceEdge[] = [];

  const seen = new Set<string>();
  const visit = (n: ZapNode, from?: { id: string; branch?: SourceEdge['branch'] }) => {
    if (seen.has(String(n.id))) return; // a cycle in a broken export
    seen.add(String(n.id));
    const step = toStep(n);
    steps.push(step);
    if (from) edges.push(from.branch ? { from: from.id, to: step.id, branch: from.branch } : { from: from.id, to: step.id });
    const children = (byParent.get(step.id) ?? []).sort(order);
    if (step.key === 'BranchingAPI:branch') {
      // Each child is a path: a filter whose children are the path's steps.
      children.forEach((path, index) => {
        const branch: NonNullable<SourceEdge['branch']> = { index };
        if (path.title) branch.label = path.title;
        seen.add(String(path.id));
        const cond = criteria(path.params);
        if (cond) branch.condition = cond;
        if ((path.params as { isAlwaysRun?: unknown } | null)?.isAlwaysRun === true) branch.alwaysRun = true;
        for (const first of (byParent.get(String(path.id)) ?? []).sort(order)) visit(first, { id: step.id, branch: { ...branch } });
      });
      return;
    }
    for (const c of children) visit(c, { id: step.id });
  };
  for (const root of (byParent.get('') ?? []).sort(order)) visit(root);
  // Steps whose parent is missing (or that sit in a cycle) are kept, unconnected, so nothing disappears.
  for (const n of [...zap.nodes].sort(order)) {
    if (seen.has(String(n.id))) continue;
    const before = steps.length;
    visit(n);
    for (const s of steps.slice(before, before + 1)) s.detached = true;
  }

  const graph: SourceGraph = { source: 'zapier', name: zap.title?.trim() || `Zap ${zap.id ?? ''}`.trim(), steps, edges };
  if (zap.id !== undefined && zap.id !== null) graph.zapId = String(zap.id);
  const root = steps[0];
  // Polling triggers (anything but a webhook or a schedule) were checked every few minutes by Zapier.
  if (root && !/^(WebHook|Schedule)/.test(root.app)) graph.schedule = { kind: 'interval', value: 900 };
  return graph;
}

export function parseZapier(input: unknown): SourceGraph[] {
  return zapsOf(input).map(graphOf);
}

export function listZaps(input: unknown): Array<{ id: string; title: string; steps: number; apps: string[]; paused: boolean }> {
  return zapsOf(input).map((z) => {
    const g = graphOf(z);
    return {
      id: String(z.id ?? ''),
      title: g.name,
      steps: g.steps.length,
      apps: [...new Set(g.steps.map((s) => s.app))],
      paused: z.status !== undefined ? z.status !== 'on' : z.nodes.some((n) => n.paused),
    };
  });
}
