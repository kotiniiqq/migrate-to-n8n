/** Source graph → n8n workflow + report. Shared by Make and Zapier; each source brings its parser,
 *  formula translator and condition operators. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { buildWorkflow, type PlannedEdge, type PlannedNode } from './build/workflow.ts';
import { translateMakeExpr, translateMakeJs, type MakeExprCtx } from './make/expr.ts';
import { makeLabel, parseMake } from './make/parse.ts';
import { conditionParameters, MAKE_OPS, UNFINISHED_ZAPIER, ZAPIER_OPS, type OpSpec } from './map/conditions.ts';
import './map/make/index.ts';
import './map/zapier/index.ts';
import { findEntry, n8nNode, NODE, worst, type MapCtx, type MapOutput } from './map/registry.ts';
import { suggestFor } from './map/suggest.ts';
import type { ConversionReport, ConversionResult, Source, SourceGraph, SourceStep, Status, StepReport } from './types.ts';
import { renderMarkdown } from './report/render.ts';
import { safeFileName, uniqueName } from './util/names.ts';
import { translateZapierExpr, translateZapierJs } from './zapier/expr.ts';
import { parseZapier, zapierLabel } from './zapier/parse.ts';
import { InputError } from './types.ts';

export interface RefCtx {
  refName(id: string): string | undefined;
  refBase?(id: string, firstField?: string, path?: string[]): { base: string; drop: number; note?: string } | undefined;
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
  /** Last node of a Make error-handler route that resumes: it goes on to the same next steps. */
  resume?: string;
}

const NODE_SCHEDULE = 'n8n-nodes-base.scheduleTrigger';
// The IMAP email trigger is the one trigger whose type name does not say so.
const isTriggerType = (type: string) => (/(trigger|webhook)$/i.test(type) && !/respondToWebhook$/.test(type)) || type === 'n8n-nodes-base.emailReadImap';

/** The scenario name made URL-safe, with an end that stays the same when the same scenario is converted again (the
 *  senders keep their URL) but differs between two workflows of the same name ("Untitled Zap"), or n8n refuses to
 *  activate the second: it comes from the zap id or the Make webhook ids, else from the name. */
function slugify(g: SourceGraph): string {
  const s = g.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  const hooks = g.steps.map((st) => st.params.hook).filter((h) => typeof h === 'number' || (typeof h === 'string' && h));
  const basis = [g.source, g.zapId ?? '', hooks.join(','), g.name].join('|');
  return `${s || 'scenario'}-${createHash('sha256').update(basis).digest('hex').slice(0, 8)}`;
}

/** Nodes that mappings add around an app node; the credential belongs to the app node. */
const HELPER_TYPES = new Set<string>(['set', 'code', 'filter', 'splitOut', 'aggregate', 'merge', 'noOp', 'limit'].map((k) => NODE[k as keyof typeof NODE].type));

/** n8n adds "sent automatically with n8n" or a link to the workflow to messages unless told not to; Make and
 *  Zapier added nothing. [node type, default resource, sending operations, collection, option]. */
const QUIET: Array<[string, string, string[], string, string]> = [
  [NODE.gmail.type, 'message', ['send', 'reply'], 'options', 'appendAttribution'],
  [NODE.emailSend.type, 'email', ['send'], 'options', 'appendAttribution'],
  [NODE.slack.type, 'message', ['post', 'update'], 'otherOptions', 'includeLinkToWorkflow'],
  [NODE.telegram.type, 'message', ['editMessageText', 'sendAnimation', 'sendAudio', 'sendDocument', 'sendLocation', 'sendMessage', 'sendMediaGroup', 'sendPhoto', 'sendSticker', 'sendVideo'], 'additionalFields', 'appendAttribution'],
];

function quiet(n: { type: string; parameters: Record<string, unknown> }): void {
  for (const [type, resource, ops, collection, option] of QUIET) {
    const p = n.parameters;
    // Only nodes a mapping set to send: a bare app node (a manual step) shows no such option.
    if (n.type !== type || (p.resource ?? resource) !== resource || p.operation === undefined || !ops.includes(String(p.operation))) continue;
    const c = p[collection] && typeof p[collection] === 'object' ? (p[collection] as Record<string, unknown>) : {};
    p[collection] = { ...c, [option]: c[option] ?? false };
  }
}

const duration = (sec: number) => {
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]] as const) {
    if (sec % size === 0) return `${sec / size} ${unit}${sec === size ? '' : 's'}`;
  }
  return `${sec} second${sec === 1 ? '' : 's'}`;
};

function scheduleNode(g: SourceGraph): { node: ReturnType<typeof n8nNode>; note?: string } {
  const s = g.schedule;
  const interval = (rule: Record<string, unknown>) => ({ rule: { interval: [rule] } });
  if (s?.kind === 'interval' && typeof s.value === 'number' && s.value > 0) {
    // n8n repeats seconds and minutes as a cron step (*/n), exact only when n divides 60; hours below 24 and
    // whole days it counts itself. Anything else gets the nearest interval n8n can keep, with a note.
    const sec = s.value;
    const exact = [
      ...[1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30].flatMap((n) => [{ sec: n, rule: { field: 'seconds', secondsInterval: n } }, { sec: n * 60, rule: { field: 'minutes', minutesInterval: n } }]),
      ...Array.from({ length: 23 }, (_, i) => ({ sec: (i + 1) * 3600, rule: { field: 'hours', hoursInterval: i + 1 } })),
      ...Array.from({ length: 31 }, (_, i) => ({ sec: (i + 1) * 86400, rule: { field: 'days', daysInterval: i + 1 } })),
    ];
    const ratio = (a: number) => Math.abs(Math.log(a / sec));
    const best = exact.reduce((b, c) => (ratio(c.sec) < ratio(b.sec) ? c : b));
    const node = n8nNode('scheduleTrigger', 'Schedule', interval(best.rule));
    if (best.sec === sec) return { node };
    return { node, note: `Make ran this every ${duration(sec)}; n8n cannot repeat at exactly that interval, so the schedule runs every ${duration(best.sec)}: change it (or use a cron expression) if the timing matters.` };
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
  const vars = new Map<string, { name: string; stepId: string }>();
  const keys = new Set(g.steps.map((s) => s.key));
  const ancestors = ancestorsOf(g);
  const slug = slugify(g);
  const extraNotes: string[] = [];

  /** Context for mapping one step; notes and status land in `sink`. */
  const makeCtx = (step: SourceStep, sink: { notes: string[]; status: Status }): MapCtx => {
    const note = (text: string, review = false) => {
      if (!sink.notes.includes(text)) sink.notes.push(text);
      if (review) sink.status = worst(sink.status, 'review');
    };
    /** Reading another step's output: it must run before this one (n8n's .item needs a path back) and be finished. */
    const checkSource = (id: string) => {
      const o = outs.get(id);
      if (!o) return;
      if (o.status === 'manual') note(`Uses data from "${o.step.label}", which must be finished by hand first.`, true);
      if (!ancestors.get(step.id)?.has(id)) note(`Uses data from "${o.step.label}", which does not always run before this step.`, true);
    };
    const refs: RefCtx = {
      refName(id) {
        const o = outs.get(id);
        if (!o) return undefined;
        checkSource(id);
        return o.name;
      },
      refBase(id, first, path) {
        const o = outs.get(id);
        if (!o?.ref) return undefined;
        checkSource(id);
        return o.ref(o.name, first, path);
      },
    };
    const tr = d.translate(refs);
    const deep = (v: unknown): unknown => {
      if (typeof v === 'string') {
        const r = tr.expr(v);
        for (const n of r.notes) note(n, !r.ok);
        if (!r.ok && !r.notes.length) note(`Formula not translated: ${v}`, true);
        // n8n reads any value that starts with "=" as an expression; keep plain text like "=SUM(A1)" as text.
        if (r.value === v && v.startsWith('=')) return `=${v}`;
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
      js: function js(v: unknown): string {
        if (Array.isArray(v)) return `[${v.map(js).join(', ')}]`;
        if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${js(x)}`).join(', ')} }`;
        if (typeof v !== 'string') return JSON.stringify(v ?? null);
        const r = tr.js(v);
        for (const n of r.notes) note(n, !r.ok);
        return r.js;
      },
      note,
      has: (k) => keys.has(k),
      variable: (n) => {
        const v = vars.get(n);
        if (v) checkSource(v.stepId);
        return v?.name;
      },
      slug,
      previous: (() => {
        const incoming = g.edges.filter((e) => e.to === step.id);
        if (incoming.length !== 1 || incoming[0].branch?.condition || step.filter) return undefined;
        return outs.get(incoming[0].from)?.name;
      })(),
    };
  };

  /** The app node of a step (helpers such as a Filter or Code node may come after it) gets the credential without an
   *  id: n8n keeps it for picking, and `check` reports it until one is selected. */
  const addCredential = (res: MapOutput, nodes: PlannedNode[], names: string[]) => {
    const at = Math.max(0, res.nodes.map((n) => !HELPER_TYPES.has(n.type)).lastIndexOf(true));
    const { app, credentialType } = res.credential!;
    const k = `${app}|${credentialType}`;
    const c = credentials.get(k) ?? { ...res.credential!, nodes: [] };
    // A step that calls the app twice (Instagram: create the media, then publish it) needs it on both nodes.
    res.nodes.forEach((n, i) => {
      if (n.type !== res.nodes[at].type) return;
      nodes[i].credentials = { ...nodes[i].credentials, [credentialType]: { name: `${app} account` } };
      c.nodes.push(names[i]);
    });
    credentials.set(k, c);
  };

  // Modules of Make error-handler routes: reported after their step, placed on its error output.
  const handlerReports = new Map<string, StepReport[]>();
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
    if (step.detached) ctx.note('This step is not connected to the rest of the workflow in the export (its parent step is missing): connect it where it belongs.', true);
    for (const f of step.flagged ?? []) ctx.note(f.text, f.serious);
    for (const n of res.notes ?? []) ctx.note(n);
    let status = worst(sink.status, res.status);

    const stepKeys: string[] = [];
    const names: string[] = [];
    res.nodes.forEach((n, i) => {
      const name = reserve(i === res.nodes.length - 1 ? step.label : n.wanted);
      const key = `${step.id}#${i}`;
      quiet(n);
      planned.push({ ...n, key, wanted: name });
      if (i > 0) edges.push({ from: stepKeys[i - 1], to: key });
      stepKeys.push(key);
      names.push(name);
    });
    const own = new Map(res.nodes.map((n, i) => [n.wanted, names[i]]));
    for (const p of planned.slice(-res.nodes.length)) {
      if (!p.named) continue;
      p.parameters = p.named((w) => own.get(w) ?? w);
      delete p.named;
    }
    const exitKey = stepKeys[stepKeys.length - 1];
    const work = planned[planned.length - 1];

    if (step.onError) {
      const directive = step.onError.replace(/^builtin:/, '');
      if (directive === 'Ignore') {
        work.onError = 'continueErrorOutput';
        if (!step.errorHandler?.length) ctx.note('Errors here are ignored: the item stops at this step (the error output is left unconnected), like Make "Ignore".');
      } else if (directive === 'Resume') {
        work.onError = 'continueRegularOutput';
        ctx.note('Make continued with substitute values after an error; n8n continues with the error details instead: add the substitute values if later steps need them.', true);
      } else if (directive === 'Break') {
        const params = step.onErrorParams ?? {};
        if (params.storesIncomplete === false) {
          ctx.note('Make "Break" kept nothing to retry, because the scenario does not store incomplete executions: the workflow stops on an error here, as in Make.');
        } else if (params.retry === false || params.retry === 'false') {
          ctx.note('Make stored the failed run for you to resolve by hand (automatic retry was off); n8n stops on an error here: look at the failed executions in n8n.', true);
        } else {
          const n = Number(params.count ?? 3);
          const count = Number.isFinite(n) && n > 0 ? Math.round(n) : 3;
          const tries = Math.min(5, count + 1);
          const interval = Number(params.interval ?? 15);
          work.retry = { maxTries: tries, waitBetweenTries: 5000 };
          ctx.note(`Make retried the stored run ${count} times${Number.isFinite(interval) ? `, ${interval} min apart` : ''}; n8n makes ${tries - 1} retries (${tries} attempts), 5 s apart${tries < count + 1 ? ', the most n8n allows' : ''}. For longer gaps use an error workflow.`, true);
        }
      } else {
        ctx.note(`Make "${directive}" error handling has no n8n equivalent (no transactions): the workflow stops on an error here.`, true);
      }
      status = worst(status, sink.status);
    }
    // Modules of a Make error-handler route go on the error output of the node, disabled until checked. After them the
    // item stops (Ignore), goes on to the next steps (Resume), or a Stop and Error node fails the run (Break and the rest).
    let resume: string | undefined;
    if (step.errorHandler?.length) {
      const directive = (step.onError ?? 'builtin:Ignore').replace(/^builtin:/, '');
      const resumes = work.onError === 'continueRegularOutput';
      work.onError = 'continueErrorOutput';
      let prevKey = exitKey;
      let output: number | undefined = 1;
      const reports: StepReport[] = [];
      for (const h of step.errorHandler) {
        // Formulas in the handler can read every step that ran before the failing one, and the failing one itself.
        ancestors.set(h.id, new Set([...(ancestors.get(step.id) ?? []), step.id]));
        const hsink = { notes: [] as string[], status: 'converted' as Status };
        const hctx = makeCtx(h, hsink);
        const hentry = findEntry(d.source, h.key);
        let hres: MapOutput;
        try {
          hres = hentry ? hentry.build(hctx) : d.manual(h, hctx);
        } catch (e) {
          hctx.note(`Automatic conversion stopped: ${(e as Error).message}`);
          hres = d.manual(h, hctx);
        }
        if (!hres.nodes.length) hres = { ...hres, nodes: [n8nNode('noOp', h.label, {})] };
        for (const n of hres.notes ?? []) hctx.note(n);
        const hstatus = worst(hsink.status, hres.status) === 'manual' ? 'manual' : 'review';
        const hnames: string[] = [];
        hres.nodes.forEach((n, i) => {
          const name = reserve(i === hres.nodes.length - 1 ? h.label : n.wanted);
          const key = `${step.id}!${h.id}#${i}`;
          quiet(n);
          planned.push({ ...n, key, wanted: name, disabled: true });
          edges.push({ from: prevKey, to: key, ...(output === undefined ? {} : { output }) });
          prevKey = key;
          output = undefined;
          hnames.push(name);
        });
        const hown = new Map(hres.nodes.map((n, i) => [n.wanted, hnames[i]]));
        for (const p of planned.slice(-hres.nodes.length)) {
          if (!p.named) continue;
          p.parameters = p.named((w) => hown.get(w) ?? w);
          delete p.named;
        }
        if (hres.credential) addCredential(hres, planned.slice(planned.length - hres.nodes.length), hnames);
        for (const p of hres.placeholders ?? []) placeholders.push({ node: hnames[hnames.length - 1], ...p });
        const where = `Make ran this when "${step.label}" failed; it is placed on the error output of "${work.wanted}", disabled`;
        const report: StepReport = { sourceId: h.id, sourceLabel: h.label, sourceKey: h.key, n8nNodes: hnames, status: hstatus, notes: hsink.notes };
        if (hstatus === 'manual') report.suggestion = `${where}. ${hres.suggestion ?? 'Finish it by hand, then enable it.'}`;
        else hsink.notes.unshift(`${where}: check it, then enable it.`);
        reports.push(report);
      }
      handlerReports.set(step.id, reports);
      if (resumes) {
        resume = prevKey;
      } else if (directive !== 'Ignore') {
        const name = reserve(`Stop: ${step.label} failed`);
        const key = `${step.id}!stop`;
        planned.push({ ...n8nNode('stopAndError', name, { errorMessage: `"${step.label}" failed (Make: error handler ended with ${directive})` }), key, wanted: name });
        edges.push({ from: prevKey, to: key });
      }
      const then = resumes ? 'then the item goes on to the next step, as Make resumed' : directive === 'Ignore' ? 'then the item stops, as Make ignored the error' : `then "Stop and Error" fails the run, as Make "${directive}" did`;
      const many = step.errorHandler.length > 1;
      ctx.note(`On an error Make ran ${step.errorHandler.map((h) => `"${h.label}"`).join(', ')}: ${many ? 'they are' : 'it is'} on the error output of this node, disabled; ${then}. Check ${many ? 'them' : 'it'} and enable ${many ? 'them' : 'it'}.`, true);
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
    for (const v of res.sets ?? []) vars.set(v, { name: outName, stepId: step.id });
    // A filter in front of the step is already in `planned` and `names`: pick the step's own nodes by key.
    if (res.credential) addCredential(res, stepKeys.map((k) => planned.find((p) => p.key === k)!), names.slice(names.length - res.nodes.length));
    if (res.webhookPath) webhooks.push({ node: outName, path: res.webhookPath });
    for (const p of res.placeholders ?? []) placeholders.push({ node: outName, ...p });

    const report: StepReport = { sourceId: step.id, sourceLabel: step.label, sourceKey: step.key, n8nNodes: names, status, notes: sink.notes };
    if (res.suggestion) report.suggestion = res.suggestion;
    outs.set(step.id, { step, name: outName, entry: entryKey, exit: exitKey, status, ref: res.ref, report, resume });
  }

  for (const e of g.edges) {
    const from = outs.get(e.from);
    const to = outs.get(e.to);
    if (!from || !to) continue;
    // A Zapier path without conditions (and not set to always run) was left unfinished: it gets a REPLACE-ME filter.
    const unfinished = d.source === 'zapier' && e.branch && !e.branch.condition && !e.branch.alwaysRun;
    const condition = e.branch?.condition ?? (unfinished ? UNFINISHED_ZAPIER : undefined);
    if (e.branch && condition) {
      const sink = { notes: to.report.notes, status: to.report.status };
      const ctx = makeCtx(to.step, sink);
      const fname = reserve(e.branch.label || `Route ${e.branch.index + 1}`);
      const fkey = `${e.from}>${e.to}#route`;
      if (unfinished) ctx.note(`"${fname}" has no conditions in the export: it holds every item back until you replace its REPLACE-ME condition.`, true);
      planned.push({ ...n8nNode('filter', fname, conditionParameters(condition, d.ops, ctx, fname)), key: fkey, wanted: fname });
      edges.push({ from: from.exit, to: fkey }, { from: fkey, to: to.entry });
      if (from.resume) edges.push({ from: from.resume, to: fkey });
      to.report.n8nNodes.unshift(fname);
      to.report.status = worst(to.report.status, sink.status);
    } else {
      edges.push({ from: from.exit, to: to.entry });
      if (from.resume) edges.push({ from: from.resume, to: to.entry });
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
    if (g.source === 'zapier' && node.type === NODE_SCHEDULE) {
      extraNotes.push(`Zapier checked "${first!.label}" for new data every few minutes; this workflow runs every 15 minutes: change the Schedule, or use the app's trigger node if n8n has one.`);
    }
  }

  // n8n accepts workflow names of up to 128 characters.
  const { workflow } = buildWorkflow([...g.name].slice(0, 128).join('').trim() || 'Workflow', planned, edges);
  const steps = [...outs.values()].flatMap((o) => [o.report, ...(handlerReports.get(o.step.id) ?? [])]);
  const totals: Record<Status, number> = { converted: 0, review: 0, manual: 0 };
  for (const s of steps) totals[s.status]++;
  const handlerSteps = [...handlerReports.values()].flat();
  const handlers = handlerSteps.length;
  const placed = totals.manual - handlerSteps.filter((s) => s.status === 'manual').length;

  const nextSteps: string[] = [];
  if (credentials.size) nextSteps.push(`Connect credentials in n8n for: ${[...credentials.values()].map((c) => c.app).join(', ')}.`);
  if (webhooks.length) nextSteps.push(`Point the senders to the new webhook URL${webhooks.length > 1 ? 's' : ''}: ${webhooks.map((w) => `"${w.node}" (…/webhook/${w.path})`).join(', ')}.`);
  if (placed) nextSteps.push(`Finish ${placed} step${placed > 1 ? 's' : ''} by hand: ${placed > 1 ? 'they are' : 'it is'} disabled and marked ⚠, with a suggestion next to ${placed > 1 ? 'each' : 'it'}.`);
  if (handlers) nextSteps.push(`Check ${handlers} Make error-handler step${handlers > 1 ? 's' : ''} on the error output${handlers > 1 ? 's' : ''} (disabled), finish ${handlers > 1 ? 'them' : 'it'} as the report suggests, then enable ${handlers > 1 ? 'them' : 'it'}.`);
  if (totals.review) nextSteps.push(`Check ${totals.review} step${totals.review > 1 ? 's' : ''} marked "review".`);
  if (placeholders.length) nextSteps.push(`Fill in ${placeholders.length} REPLACE-ME value${placeholders.length > 1 ? 's' : ''}.`);
  // The export has no time zone; n8n uses the workflow's, else the instance default.
  const timed = workflow.nodes.some((n) => /\$now|\$today|DateTime\./.test(JSON.stringify(n.parameters))
    || (n.type === NODE_SCHEDULE && /triggerAtHour|cronExpression/.test(JSON.stringify(n.parameters))));
  if (timed) {
    nextSteps.push(`Set the time zone in the workflow settings to the one your ${g.source === 'make' ? 'Make' : 'Zapier'} account used: dates, times and schedules here follow it (without it n8n uses the instance default, often America/New_York).`);
  }
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

/** A setting that Claude Desktop passes through unfilled arrives empty or as the literal `${user_config.x}`. */
export function setting(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && !/^\$\{[^}]*\}$/.test(v) ? v : undefined;
}

const PLACES: Record<string, string[]> = { HOME: [], DOCUMENTS: ['Documents'], DESKTOP: ['Desktop'], DOWNLOADS: ['Downloads'] };

/** A folder chosen by the user: Claude Desktop passes `${HOME}` and the like through as text, and a relative folder goes under the home folder, never the server's working directory. */
export function homePath(dir: string): string {
  const t = dir.trim().replace(/^["']|["']$/g, '')
    .replace(/^\$\{(\w+)\}/, (whole, name: string) => (PLACES[name] ? join(homedir(), ...PLACES[name]) : whole))
    .replace(/^~(?=$|[\\/])/, homedir());
  return isAbsolute(t) ? join(t) : join(homedir(), t);
}

export function defaultOutputDir(env: Record<string, string | undefined> = process.env): string {
  const dir = setting(env.MIGRATE_OUTPUT_DIR);
  return dir ? homePath(dir) : join(homedir(), 'Documents', 'migrate-to-n8n');
}

/** Write `<name>.n8n.json`, `<name>.report.md` and `<name>.report.json` into `dir`, never overwriting files. */
export function writeResult(res: ConversionResult, dir: string): { workflowPath: string; reportPath: string; reportJsonPath: string } {
  mkdirSync(dir, { recursive: true });
  const base = safeFileName(res.workflow.name);
  const paths = (n: number) => {
    const stem = join(dir, n === 1 ? base : `${base} (${n})`);
    return { workflowPath: `${stem}.n8n.json`, reportPath: `${stem}.report.md`, reportJsonPath: `${stem}.report.json` };
  };
  let n = 1;
  while (Object.values(paths(n)).some((p) => existsSync(p))) n++;
  const p = paths(n);
  writeFileSync(p.workflowPath, JSON.stringify(res.workflow, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(p.reportPath, renderMarkdown(res.report), { flag: 'wx' });
  writeFileSync(p.reportJsonPath, JSON.stringify(res.report, null, 2) + '\n', { flag: 'wx' });
  return p;
}

const ZAPIER: Dialect = {
  source: 'zapier',
  ops: ZAPIER_OPS,
  translate(refs) {
    return { expr: (s) => translateZapierExpr(s, refs), js: (s) => translateZapierJs(s, refs) };
  },
  manual: suggestFor,
  label: zapierLabel,
};

/** One result per zap; `zaps` picks zaps by id or title (case does not matter). */
export function convertZapier(input: unknown, opts: { zaps?: string[] } = {}): ConversionResult[] {
  const graphs = parseZapier(input);
  let chosen = graphs;
  if (opts.zaps?.length) {
    const wanted = opts.zaps.map((z) => z.trim().toLowerCase());
    chosen = graphs.filter((g) => wanted.includes(g.name.toLowerCase()) || wanted.includes(String(g.zapId ?? '').toLowerCase()));
    if (!chosen.length) throw new InputError(`No zap matches ${opts.zaps.map((z) => `"${z}"`).join(', ')}; the export has: ${graphs.map((g) => g.name).join(', ')}.`);
  }
  return chosen.map((g) => convertGraph(g, ZAPIER));
}
