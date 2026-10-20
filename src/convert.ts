/** Source graph → n8n workflow + report. Shared by Make and Zapier; each source brings its parser,
 *  formula translator and condition operators. */
import { buildWorkflow, type PlannedEdge, type PlannedNode } from './build/workflow.ts';
import { translateMakeExpr, translateMakeJs, type MakeExprCtx } from './make/expr.ts';
import { makeLabel, parseMake } from './make/parse.ts';
import { conditionParameters, MAKE_OPS, type OpSpec } from './map/conditions.ts';
import './map/make/index.ts';
import { findEntry, n8nNode, worst, type MapCtx, type MapOutput } from './map/registry.ts';
import { suggestFor } from './map/suggest.ts';
import type { ConversionReport, ConversionResult, Source, SourceGraph, SourceStep, Status, StepReport } from './types.ts';
import { uniqueName } from './util/names.ts';

export interface RefCtx {
  refName(id: string): string | undefined;
  refBase?(id: string, firstField?: string): { base: string; drop: number } | undefined;
}

interface Dialect {
  source: Source;
  ops: Record<string, OpSpec>;
  translate(refs: RefCtx): { expr(s: string): { value: string; ok: boolean; notes: string[] }; js(s: string): { js: string; ok: boolean; notes: string[] } };
  manual(step: SourceStep, ctx: MapCtx): MapOutput;
  /** Human name of a source module key. */
  label(key: string): string;
}

interface StepOut {
  step: SourceStep;
  name: string;
  entry: string;
  exit: string;
  status: Status;
  ref?: MapOutput['ref'];
  report: StepReport;
}

const isTriggerType = (type: string) => /(trigger|webhook)$/i.test(type) && !/respondToWebhook$/.test(type);

function slugify(name: string): string {
  const s = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s || `scenario-${Math.random().toString(36).slice(2, 8)}`;
}

function scheduleNode(g: SourceGraph): { node: ReturnType<typeof n8nNode>; note?: string } {
  const s = g.schedule;
  const interval = (rule: Record<string, unknown>) => ({ rule: { interval: [rule] } });
  if (s?.kind === 'interval' && typeof s.value === 'number' && s.value > 0) {
    const sec = s.value;
    const rule = sec < 60 ? { field: 'seconds', secondsInterval: sec }
      : sec % 3600 === 0 ? { field: 'hours', hoursInterval: sec / 3600 }
        : { field: 'minutes', minutesInterval: Math.max(1, Math.round(sec / 60)) };
    return { node: n8nNode('scheduleTrigger', 'Schedule', interval(rule)) };
  }
  if ((s?.kind === 'daily' || s?.kind === 'weekly' || s?.kind === 'monthly') && typeof s.value === 'string') {
    const [h, m] = s.value.split(':').map(Number);
    const at = { triggerAtHour: Number.isFinite(h) ? h : 0, triggerAtMinute: Number.isFinite(m) ? m : 0 };
    if (s.kind === 'daily') return { node: n8nNode('scheduleTrigger', 'Schedule', interval({ field: 'days', ...at })) };
    return {
      node: n8nNode('scheduleTrigger', 'Schedule', interval({ field: 'days', ...at })),
      note: `Make ran this ${s.kind}; the schedule is set to daily at ${s.value}: pick the days in the Schedule trigger.`,
    };
  }
  if (s?.kind === 'cron' && typeof s.value === 'string') {
    return { node: n8nNode('scheduleTrigger', 'Schedule', interval({ field: 'cronExpression', expression: s.value })) };
  }
  return {
    node: n8nNode('manualTrigger', 'Start', {}),
    note: 'The scenario has no schedule in the export: the workflow starts by hand. Replace "Start" with a Schedule trigger if it should run on its own.',
  };
}

function ancestorsOf(g: SourceGraph): Map<string, Set<string>> {
  const anc = new Map<string, Set<string>>(g.steps.map((s) => [s.id, new Set<string>()]));
  for (const e of g.edges) {
    const to = anc.get(e.to);
    if (!to) continue;
    to.add(e.from);
    for (const a of anc.get(e.from) ?? []) to.add(a);
  }
  return anc;
}

export function convertGraph(g: SourceGraph, d: Dialect): ConversionResult {
  const taken = new Set<string>();
  const reserve = (wanted: string) => {
    const n = uniqueName(wanted, taken);
    taken.add(n);
    return n;
  };
  const outs = new Map<string, StepOut>();
  const planned: PlannedNode[] = [];
  const edges: PlannedEdge[] = [];
  const credentials = new Map<string, { app: string; credentialType: string; nodes: string[] }>();
  const webhooks: ConversionReport['webhooks'] = [];
  const placeholders: ConversionReport['placeholders'] = [];
  const vars = new Map<string, string>();
  const keys = new Set(g.steps.map((s) => s.key));
  const ancestors = ancestorsOf(g);
  const slug = slugify(g.name);
  const extraNotes: string[] = [];

  /** Context for mapping one step; notes and status land in `sink`. */
  const makeCtx = (step: SourceStep, sink: { notes: string[]; status: Status }): MapCtx => {
    const note = (text: string, review = false) => {
      if (!sink.notes.includes(text)) sink.notes.push(text);
      if (review) sink.status = worst(sink.status, 'review');
    };
    const refs: RefCtx = {
      refName(id) {
        const o = outs.get(id);
        if (!o) return undefined;
        if (o.status === 'manual') note(`Uses data from "${o.step.label}", which must be finished by hand first.`, true);
        if (!ancestors.get(step.id)?.has(id)) note(`Uses data from "${o.step.label}", which does not always run before this step.`, true);
        return o.name;
      },
      refBase(id, first) {
        const o = outs.get(id);
        return o?.ref ? o.ref(o.name, first) : undefined;
      },
    };
    const tr = d.translate(refs);
    const deep = (v: unknown): unknown => {
      if (typeof v === 'string') {
        const r = tr.expr(v);
        for (const n of r.notes) note(n, !r.ok);
        if (!r.ok && !r.notes.length) note(`Formula not translated: ${v}`, true);
        return r.value;
      }
      if (Array.isArray(v)) return v.map(deep);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]));
      return v;
    };
    return {
      step,
      graph: g,
      expr: deep,
      js(v) {
        const r = tr.js(typeof v === 'string' ? v : JSON.stringify(v ?? ''));
        for (const n of r.notes) note(n, !r.ok);
        return r.js;
      },
      note,
      has: (k) => keys.has(k),
      variable: (n) => vars.get(n),
      slug,
      previous: (() => {
        const incoming = g.edges.filter((e) => e.to === step.id);
        if (incoming.length !== 1 || incoming[0].branch?.condition || step.filter) return undefined;
        return outs.get(incoming[0].from)?.name;
      })(),
    };
  };

  for (const step of g.steps) {
    const sink = { notes: [] as string[], status: 'converted' as Status };
    const ctx = makeCtx(step, sink);
    const entry = findEntry(d.source, step.key);
    let res: MapOutput;
    try {
      res = entry ? entry.build(ctx) : d.manual(step, ctx);
    } catch (e) {
      ctx.note(`Automatic conversion stopped: ${(e as Error).message}`);
      res = d.manual(step, ctx);
    }
    if (!res.nodes.length) res = { ...res, nodes: [n8nNode('noOp', step.label, {})] };
    for (const n of res.notes ?? []) ctx.note(n);
    let status = worst(sink.status, res.status);

    const stepKeys: string[] = [];
    const names: string[] = [];
    res.nodes.forEach((n, i) => {
      const name = reserve(i === res.nodes.length - 1 ? step.label : n.wanted);
      const key = `${step.id}#${i}`;
      planned.push({ ...n, key, wanted: name });
      if (i > 0) edges.push({ from: stepKeys[i - 1], to: key });
      stepKeys.push(key);
      names.push(name);
    });
    const exitKey = stepKeys[stepKeys.length - 1];
    const work = planned[planned.length - 1];

    if (step.onError) {
      const directive = step.onError.replace(/^builtin:/, '');
      if (directive === 'Ignore') {
        work.onError = 'continueErrorOutput';
        ctx.note('Errors here are ignored: the item stops at this step (the error output is left unconnected), like Make "Ignore".');
      } else if (directive === 'Resume') {
        work.onError = 'continueRegularOutput';
        ctx.note('Make continued with substitute values after an error; n8n continues with the error details instead: add the substitute values if later steps need them.', true);
      } else if (directive === 'Break') {
        const count = Number((step.params as { count?: unknown }).count ?? 3);
        const tries = Math.min(5, Math.max(2, (Number.isFinite(count) ? count : 3) + 1));
        work.retry = { maxTries: tries, waitBetweenTries: 5000 };
        ctx.note(`Make stored the failed run and retried it later; n8n retries this step ${tries} times, 5 s apart. For longer gaps use an error workflow.`, true);
      } else {
        ctx.note(`Make "${directive}" error handling has no n8n equivalent (no transactions): the workflow stops on an error here.`, true);
      }
      status = worst(status, sink.status);
    }
    if (step.errorHandler?.length) {
      ctx.note(`On an error Make ran: ${step.errorHandler.map((k) => `"${d.label(k)}"`).join(', ')}. In n8n set this node's "On Error" to "Continue (using error output)" and connect the same steps to the error output.`, true);
      status = worst(status, 'review');
    }

    let entryKey = stepKeys[0];
    if (step.filter) {
      const fname = reserve(step.filterLabel || `Filter: ${step.label}`);
      const fkey = `${step.id}#filter`;
      planned.push({ ...n8nNode('filter', fname, conditionParameters(step.filter, d.ops, ctx, fname)), key: fkey, wanted: fname });
      edges.push({ from: fkey, to: entryKey });
      names.unshift(fname);
      entryKey = fkey;
      status = worst(status, sink.status);
    }

    const outName = names[names.length - 1];
    for (const v of res.sets ?? []) vars.set(v, outName);
    if (res.credential) {
      const k = `${res.credential.app}|${res.credential.credentialType}`;
      const c = credentials.get(k) ?? { ...res.credential, nodes: [] };
      c.nodes.push(outName);
      credentials.set(k, c);
    }
    if (res.webhookPath) webhooks.push({ node: outName, path: res.webhookPath });
    for (const p of res.placeholders ?? []) placeholders.push({ node: outName, ...p });

    const report: StepReport = { sourceId: step.id, sourceLabel: step.label, sourceKey: step.key, n8nNodes: names, status, notes: sink.notes };
    if (res.suggestion) report.suggestion = res.suggestion;
    outs.set(step.id, { step, name: outName, entry: entryKey, exit: exitKey, status, ref: res.ref, report });
  }

  for (const e of g.edges) {
    const from = outs.get(e.from);
    const to = outs.get(e.to);
    if (!from || !to) continue;
    if (e.branch?.condition) {
      const sink = { notes: to.report.notes, status: to.report.status };
      const ctx = makeCtx(to.step, sink);
      const fname = reserve(e.branch.label || `Route ${e.branch.index + 1}`);
      const fkey = `${e.from}>${e.to}#route`;
      planned.push({ ...n8nNode('filter', fname, conditionParameters(e.branch.condition, d.ops, ctx, fname)), key: fkey, wanted: fname });
      edges.push({ from: from.exit, to: fkey }, { from: fkey, to: to.entry });
      to.report.n8nNodes.unshift(fname);
      to.report.status = worst(to.report.status, sink.status);
    } else {
      edges.push({ from: from.exit, to: to.entry });
    }
  }

  const first = g.steps.find((s) => !g.edges.some((e) => e.to === s.id));
  const firstOut = first && outs.get(first.id);
  const firstNode = firstOut && planned.find((p) => p.key === firstOut.entry);
  // A trigger node (even a disabled one waiting to be finished) has no input: nothing goes in front of it.
  if (firstOut && firstNode && !isTriggerType(firstNode.type)) {
    const { node, note } = scheduleNode(g);
    const name = reserve(node.wanted);
    planned.unshift({ ...node, key: 'trigger', wanted: name });
    edges.unshift({ from: 'trigger', to: firstOut.entry });
    if (note) extraNotes.push(note);
  }

  const { workflow } = buildWorkflow(g.name, planned, edges);
  const steps = [...outs.values()].map((o) => o.report);
  const totals: Record<Status, number> = { converted: 0, review: 0, manual: 0 };
  for (const s of steps) totals[s.status]++;

  const nextSteps: string[] = [];
  if (credentials.size) nextSteps.push(`Connect credentials in n8n for: ${[...credentials.values()].map((c) => c.app).join(', ')}.`);
  if (webhooks.length) nextSteps.push(`Point the senders to the new webhook URL${webhooks.length > 1 ? 's' : ''}: ${webhooks.map((w) => `"${w.node}" (…/webhook/${w.path})`).join(', ')}.`);
  if (totals.manual) nextSteps.push(`Finish ${totals.manual} step${totals.manual > 1 ? 's' : ''} by hand: ${totals.manual > 1 ? 'they are' : 'it is'} disabled and marked ⚠, with a suggestion next to ${totals.manual > 1 ? 'each' : 'it'}.`);
  if (totals.review) nextSteps.push(`Check ${totals.review} step${totals.review > 1 ? 's' : ''} marked "review".`);
  if (placeholders.length) nextSteps.push(`Fill in ${placeholders.length} REPLACE-ME value${placeholders.length > 1 ? 's' : ''}.`);
  nextSteps.push(...extraNotes);
  nextSteps.push('Run the workflow once with test data, then activate (publish) it.');

  return {
    workflow,
    report: { source: d.source, workflowName: g.name, totals, steps, credentials: [...credentials.values()], webhooks, placeholders, nextSteps },
  };
}

const MAKE: Dialect = {
  source: 'make',
  ops: MAKE_OPS,
  translate(refs) {
    const ctx: MakeExprCtx = refs;
    return { expr: (s) => translateMakeExpr(s, ctx), js: (s) => translateMakeJs(s, ctx) };
  },
  manual: suggestFor,
  label: makeLabel,
};

export function convertMake(input: unknown): ConversionResult {
  return convertGraph(parseMake(input), MAKE);
}
