/** Make blueprint (Scenario → … → Export Blueprint) → the neutral source graph. */
import { InputError, type ConditionGroup, type SourceEdge, type SourceGraph, type SourceStep } from '../types.ts';

type MakeModule = {
  id: number | string;
  module: string;
  parameters?: Record<string, unknown> | null;
  mapper?: Record<string, unknown> | null;
  metadata?: {
    designer?: { x?: number; y?: number; name?: string };
    interface?: Array<{ name?: unknown; label?: unknown }>;
    expect?: Array<{ name?: unknown; spec?: unknown }>;
  };
  filter?: { name?: string; conditions?: Array<Array<{ a?: unknown; o?: string; b?: unknown }>> } | null;
  onerror?: MakeModule[];
  routes?: Array<{ flow?: MakeModule[] }>;
};

const NOT_A_BLUEPRINT = 'This is not a Make blueprint: expected an object with "flow" (in Make: open the scenario → "..." → Export Blueprint).';

function looksLikeZapier(v: unknown): boolean {
  const o = v as Record<string, unknown>;
  return !!o && typeof o === 'object' && (Array.isArray(o.zaps) || JSON.stringify(o).includes('"selected_api"'));
}

function unwrap(input: unknown): Record<string, unknown> {
  let v = input;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v.replace(/^﻿/, ''));
    } catch {
      throw new InputError(NOT_A_BLUEPRINT);
    }
  }
  if (Array.isArray(v) && v.length === 1) v = v[0];
  if (v && typeof v === 'object' && !Array.isArray(v) && 'blueprint' in v && !('flow' in v)) v = (v as { blueprint: unknown }).blueprint;
  if (looksLikeZapier(v)) throw new InputError('This looks like a Zapier export, not a Make blueprint: convert it as Zapier (convert_zapier).');
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Array.isArray((v as { flow?: unknown }).flow)) throw new InputError(NOT_A_BLUEPRINT);
  return v as Record<string, unknown>;
}

const APP_NAMES: Record<string, string> = {
  gateway: 'Webhooks', http: 'HTTP', json: 'JSON', util: 'Tools', builtin: 'Flow Control', regexp: 'Text parser',
  'google-sheets': 'Google Sheets', 'google-email': 'Gmail', 'google-calendar': 'Google Calendar', 'google-drive': 'Google Drive',
  'openai-gpt-3': 'OpenAI', email: 'Email', slack: 'Slack', telegram: 'Telegram', airtable: 'Airtable', notion: 'Notion',
};

/** Names Make itself shows for its built-in modules. */
const LABELS: Record<string, string> = {
  'gateway:CustomWebHook': 'Webhook', 'gateway:CustomMailHook': 'Mailhook', 'gateway:WebhookRespond': 'Webhook response',
  'builtin:BasicRouter': 'Router', 'builtin:BasicFeeder': 'Iterator', 'builtin:BasicIterator': 'Iterator',
  'builtin:BasicAggregator': 'Array aggregator', 'util:TextAggregator': 'Text aggregator', 'util:SetVariable2': 'Set variable',
  'util:SetVariables': 'Set variables', 'util:SetMultipleVariables': 'Set variables', 'util:GetVariable2': 'Get variable',
  'util:GetVariables': 'Get variables', 'util:FunctionSleep': 'Sleep', 'util:Switcher': 'Switch', 'json:ParseJSON': 'Parse JSON',
  'json:CreateJSON': 'Create JSON', 'json:TransformToJSON': 'Transform to JSON', 'json:AggregateToJSON': 'Aggregate to JSON',
  'http:ActionSendData': 'HTTP request', 'http:ActionSendDataBasicAuth': 'HTTP request (basic auth)', 'http:ActionGetFile': 'Get a file',
  'placeholder:Placeholder': 'Placeholder', 'regexp:Parser': 'Match pattern', 'regexp:Replace': 'Replace text',
};

const humanize = (s: string) => s.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/** "google-sheets:addRow" → "Google Sheets: Add Row"; the Make "Action" prefix is noise. */
function defaultLabel(app: string, action: string): string {
  const appName = APP_NAMES[app] ?? humanize(app.replace(/^app#/, ''));
  return `${appName}: ${humanize(action.replace(/^Action(?=[A-Z])/, ''))}`;
}

/** The name Make shows for a module key. */
export function makeLabel(key: string): string {
  const [app, ...rest] = key.split(':');
  return LABELS[key] || defaultLabel(app, rest.join(':'));
}

function conditions(f: MakeModule['filter']): ConditionGroup | undefined {
  const groups = f?.conditions?.filter((g) => Array.isArray(g) && g.length);
  if (!groups?.length) return undefined;
  return groups.map((g) => g.map((c) => {
    const cond: { left: string; op: string; right?: string } = { left: String(c.a ?? ''), op: String(c.o ?? '') };
    if (c.b !== undefined && c.b !== null) cond.right = String(c.b);
    return cond;
  }));
}

function toStep(m: MakeModule): SourceStep {
  const key = String(m.module);
  const [app, ...rest] = key.split(':');
  const action = rest.join(':');
  const params: Record<string, unknown> = {};
  let connectionRef: string | undefined;
  for (const [k, v] of Object.entries({ ...(m.parameters ?? {}), ...(m.mapper ?? {}) })) {
    if (k.startsWith('__IMTCONN__') || k === '__IMTCONN') { connectionRef = String(v); continue; }
    if (k.startsWith('__IMT')) continue;
    params[k] = v;
  }
  const d = m.metadata?.designer;
  const step: SourceStep = { id: String(m.id), key, app, action, label: d?.name?.trim() || makeLabel(key), params };
  if (typeof d?.x === 'number' && typeof d?.y === 'number') step.position = [d.x, d.y];
  if (connectionRef) step.connectionRef = connectionRef;
  const labelled = (list: unknown) => (Array.isArray(list) ? list : [])
    .filter((f) => f && typeof f === 'object' && f.name !== undefined && f.label !== undefined)
    .map((f) => ({ name: String(f.name), label: String(f.label) }));
  const out = labelled(m.metadata?.interface);
  if (out.length) step.outputFields = out;
  for (const e of m.metadata?.expect ?? []) {
    const spec = labelled(e?.spec);
    if (e?.name !== undefined && spec.length) (step.inputFields ??= {})[String(e.name)] = spec;
  }
  if (m.onerror?.length) {
    const directives = m.onerror.filter((h) => String(h.module).startsWith('builtin:'));
    const others = m.onerror.filter((h) => !String(h.module).startsWith('builtin:'));
    step.onError = directives.length ? String(directives[directives.length - 1].module) : 'builtin:Ignore';
    if (others.length) step.errorHandler = others.map((h) => String(h.module));
  }
  return step;
}

export function parseMake(input: unknown): SourceGraph {
  const bp = unwrap(input);
  const steps: SourceStep[] = [];
  const edges: SourceEdge[] = [];

  /** Walk one flow; `entry` links the first module to what came before (a module or a router branch). */
  const walk = (flow: MakeModule[], entry?: { from: string; branch?: SourceEdge['branch'] }) => {
    let prev = entry;
    for (const [i, m] of flow.entries()) {
      if (!m || typeof m !== 'object' || !m.module) continue;
      const step = toStep(m);
      const cond = conditions(m.filter);
      if (prev?.branch && i === 0) {
        // The filter on the first module of a route is the route's condition.
        if (cond) prev.branch.condition = cond;
        if (m.filter?.name) prev.branch.label = m.filter.name;
      } else if (cond) {
        step.filter = cond;
        if (m.filter?.name) step.filterLabel = m.filter.name;
      }
      steps.push(step);
      if (prev) edges.push(prev.branch ? { from: prev.from, to: step.id, branch: prev.branch } : { from: prev.from, to: step.id });
      if (Array.isArray(m.routes)) {
        m.routes.forEach((r, index) => walk(r?.flow ?? [], { from: step.id, branch: { index } }));
        return; // a router ends its flow
      }
      prev = { from: step.id };
    }
  };
  walk(bp.flow as MakeModule[]);

  const graph: SourceGraph = { source: 'make', name: String(bp.name ?? '').trim() || 'Make scenario', steps, edges };
  const meta = bp.metadata as { instant?: boolean } | undefined;
  const sched = bp.scheduling as { type?: string; interval?: number; time?: string; cron?: string } | undefined;
  if (meta?.instant) graph.schedule = { kind: 'instant' };
  else if (sched?.type === 'indefinitely' && sched.interval) graph.schedule = { kind: 'interval', value: sched.interval };
  else if (sched?.type && ['daily', 'weekly', 'monthly', 'once'].includes(sched.type)) {
    graph.schedule = { kind: sched.type as 'daily', value: sched.time ?? '' };
  } else if (sched?.cron) graph.schedule = { kind: 'cron', value: sched.cron };
  return graph;
}
