/** The way forward for a step nothing in the mapping table covers: the closest n8n node, placed disabled
 *  with the fields to map, or an HTTP Request / Code draft. The workflow stays connected and valid. */
import type { Source, SourceStep } from '../types.ts';
import { findApp } from './apps.ts';
import { findEntry, n8nNode, type MapCtx, type MapOutput } from './registry.ts';

/** `createCardFromTemplate` → "Create card from template". */
const humanAction = (action: string) => {
  const words = action.replace(/^Action(?=[A-Z])/, '').replace(/[-_]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

function guessMethod(action: string): string {
  const a = action.toLowerCase();
  if (/^(get|list|search|find|read|watch|fetch|retrieve|download)/.test(a)) return 'GET';
  if (/^(update|patch|edit|modify)/.test(a)) return 'PATCH';
  if (/^(delete|remove|archive)/.test(a)) return 'DELETE';
  return 'POST';
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const MAX_FIELDS = 15;

/** Source fields with their translated values, for the suggestion text and Code stubs. */
function fields(step: SourceStep, ctx: MapCtx): Array<{ name: string; value: unknown; js: string }> {
  return Object.entries(step.params)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined && !(Array.isArray(v) && !v.length))
    .slice(0, MAX_FIELDS)
    .map(([name, v]) => ({ name, value: ctx.expr(v), js: ctx.js(v) }));
}

const shown = (v: unknown) => {
  const s = typeof v === 'string' ? v.replace(/^=/, '') : JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
};

export function suggestFor(step: SourceStep, ctx: MapCtx): MapOutput {
  const isFirst = !ctx.graph.edges.some((e) => e.to === step.id) && ctx.graph.steps[0]?.id === step.id;
  // The regular app node keeps the schedule in front of it working; its trigger is named in the suggestion.
  const app = findApp(ctx.graph.source, step.app, false);
  const f = fields(step, ctx);
  const mapping = f.length ? ` Fields from ${ctx.graph.source === 'make' ? 'Make' : 'Zapier'}: ${f.map((x) => `${x.name} ← ${shown(x.value)}`).join('; ')}.` : '';
  const action = humanAction(step.action);

  // A trigger node has no input, so it can only stand where the flow starts.
  if (app?.type && !(app.trigger && !isFirst)) {
    const trig = app.triggerName && isFirst ? ` To start the workflow from ${app.displayName.replace(/ Trigger$/, '')} instead, replace the trigger with the ${app.triggerName} node.` : '';
    const suggestion = `Use the ${app.displayName} node (placed here, disabled): choose the operation closest to "${action}", connect the credential, map the fields, then enable it.${mapping}${trig}`;
    return {
      nodes: [{ wanted: step.label, type: app.type, typeVersion: app.typeVersion!, parameters: {}, disabled: true, note: suggestion }],
      status: 'manual',
      suggestion,
    };
  }

  if (app?.apiBase) {
    const url = `${app.apiBase}/REPLACE-ME`;
    const suggestion = `${app.displayName} has no n8n node: call its API with this HTTP Request (placed here, disabled). Set the endpoint for "${action}" in the URL, add the API key as a credential, then enable it.${mapping}`;
    const method = guessMethod(step.action);
    const params: Record<string, unknown> = { method, url, options: {} };
    if (method !== 'GET' && f.length) {
      Object.assign(params, { sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: `={{ JSON.stringify({ ${f.map((x) => `${JSON.stringify(x.name)}: ${x.js}`).join(', ')} }) }}` });
    }
    return {
      nodes: [n8nNode('httpRequest', step.label, params, { disabled: true, note: suggestion })],
      status: 'manual',
      suggestion,
      placeholders: [{ field: 'url', value: url }],
    };
  }

  const appName = step.app.startsWith('app#') ? `the custom app "${step.app.slice(4)}"` : `"${step.app}"`;
  const suggestion = `There is no n8n node for ${appName}: this Code node (placed here, disabled) already collects the inputs. Call the service's API from it, or replace it with an HTTP Request node, then enable it.`;
  const props = f.map((x) => `  ${IDENT.test(x.name) ? x.name : JSON.stringify(x.name)}: ${x.js},`);
  const jsCode = [
    `// ${step.label} (${step.key}) had no automatic conversion.`,
    `// Inputs as they were mapped in ${ctx.graph.source === 'make' ? 'Make' : 'Zapier'}:`,
    'const input = {',
    ...props,
    '};',
    '// TODO: call the service here, for example with this.helpers.httpRequest({ method, url, body }).',
    'return { json: input };',
  ].join('\n');
  return {
    nodes: [n8nNode('code', step.label, { mode: 'runOnceForEachItem', language: 'javaScript', jsCode }, { disabled: true, note: suggestion })],
    status: 'manual',
    suggestion,
  };
}

/** What happens to one source module, in a sentence or two (for the suggest_replacement tool). */
export function describeModule(source: Source, key: string): string {
  const entry = findEntry(source, key);
  if (entry) return `"${key}" is converted automatically: it becomes ${entry.label} in n8n.`;
  const [app, ...rest] = key.split(':');
  const action = rest.join(':');
  const match = findApp(source, app, false);
  if (match?.type) {
    const trig = match.triggerName ? ` To start a workflow from it, use the ${match.triggerName} node.` : '';
    return `"${key}" is not converted automatically yet. Use the ${match.displayName} node (${match.type}) with the operation closest to "${humanAction(action)}".${trig}`;
  }
  if (match?.apiBase) return `"${key}" has no n8n node: call the ${match.displayName} API (${match.apiBase}) with an HTTP Request node.`;
  return `"${key}" has no n8n node and no known API: use an HTTP Request node with the service's API, or a Code node.`;
}
