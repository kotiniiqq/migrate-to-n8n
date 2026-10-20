/** Zapier's built-in apps: Webhooks, Filter, Paths, Formatter, Code, Delay, Storage, Schedule, Looping, Email. */
import { randomUUID } from 'node:crypto';

import { convertDateFormat } from '../../make/expr.ts';
import { criteria } from '../../zapier/parse.ts';
import { nodeRef } from '../../util/names.ts';
import { conditionParameters, ZAPIER_OPS } from '../conditions.ts';
import { n8nNode, register, type MapCtx, type MapOutput } from '../registry.ts';
import { httpMethod } from '../shared.ts';

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const dict = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const assignment = (name: string, value: unknown, type = 'string') => ({ id: randomUUID(), name, value, type });
const setNode = (label: string, fields: Array<[string, unknown]>, keepOthers = true) =>
  n8nNode('set', label, {
    mode: 'manual',
    assignments: { assignments: fields.map(([n, v]) => assignment(n, v)) },
    ...(keepOthers ? { includeOtherFields: true } : {}),
    options: {},
  });
const pairs = (v: unknown, ctx: MapCtx) => Object.entries(dict(v)).filter(([k]) => k !== '').map(([name, value]) => ({ name, value: ctx.expr(str(value)) }));

/** Zapier "unflatten": `a__b` keys become nested objects. */
function objectJs(data: Record<string, unknown>, ctx: MapCtx, unflatten: boolean): string {
  const tree: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    const parts = unflatten ? k.split('__') : [k];
    let node = tree;
    parts.slice(0, -1).forEach((p) => { node = (node[p] = node[p] && typeof node[p] === 'object' ? node[p] : {}) as Record<string, unknown>; });
    node[parts[parts.length - 1]] = { __js: ctx.js(typeof v === 'string' ? v : JSON.stringify(v ?? '')) };
  }
  const print = (o: Record<string, unknown>): string =>
    `{ ${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${(v as { __js?: string }).__js ?? print(v as Record<string, unknown>)}`).join(', ')} }`;
  return print(tree);
}

// ---------- Webhooks by Zapier ----------

// Zapier exports spell the app both ways.
const WEBHOOK_APIS = ['WebHookCLIAPI', 'WebhooksCLIAPI'];

for (const api of WEBHOOK_APIS) for (const action of ['hook_v2', 'hook', 'hook_raw', 'catch_hook', 'catch_raw_hook']) {
  register({
    source: 'zapier', key: `${api}:${action}`, label: 'Webhook',
    build(ctx) {
      const path = ctx.slug || `zap-${ctx.step.id}`;
      ctx.note('The webhook gets a new URL in n8n: point the sender to it. Zapier accepted any method; this listens to POST.');
      return {
        nodes: [n8nNode('webhook', ctx.step.label, { httpMethod: 'POST', path, responseMode: 'onReceived', options: {} }, { webhookId: randomUUID() })],
        status: 'converted',
        webhookPath: path,
        ref: (out) => ({ base: `${nodeRef(out)}.item.json.body`, drop: 0 }),
      };
    },
  });
}

/** Headers come as a key/value object, or as text with one "Name: value" per line (custom requests). */
function headerPairs(v: unknown, ctx: MapCtx) {
  if (typeof v !== 'string') return pairs(v, ctx);
  return v.split(/\r?\n/).map((l) => /^\s*([^:]+?)\s*:\s*(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ name: m[1], value: ctx.expr(m[2]) }));
}

function request(action: string, method: string | null) {
  for (const api of WEBHOOK_APIS) register({
    source: 'zapier', key: `${api}:${action}`, label: 'HTTP Request',
    build(ctx): MapOutput {
      const p = ctx.step.params;
      const m = method ?? httpMethod(p.method, ctx, 'POST');
      const params: Record<string, unknown> = { method: m, url: ctx.expr(str(p.url)) };
      const query = pairs(p.params, ctx);
      if (query.length) Object.assign(params, { sendQuery: true, queryParameters: { parameters: query } });
      const headers = headerPairs(p.headers, ctx);
      if (headers.length) Object.assign(params, { sendHeaders: true, headerParameters: { parameters: headers } });
      if (headers.some((h) => /^authorization$/i.test(h.name) || /api[-_]?key|token/i.test(h.name))) {
        ctx.note('A secret is sent in a header; consider moving it to an n8n "Header Auth" credential.');
      }
      let credential: MapOutput['credential'];
      if (p.basic_auth) {
        Object.assign(params, { authentication: 'genericCredentialType', genericAuthType: 'httpBasicAuth' });
        credential = { app: 'HTTP Basic Auth', credentialType: 'httpBasicAuth' };
        ctx.note('The "user|password" basic auth moves to an n8n "Basic Auth" credential.');
      }
      if (m !== 'GET') {
        const data = p.data;
        const type = str(p.payload_type) || 'form';
        if (typeof data === 'string' && data) {
          Object.assign(params, { sendBody: true, contentType: 'raw', rawContentType: type === 'json' ? 'application/json' : 'text/plain', body: ctx.expr(data) });
        } else if (Object.keys(dict(data)).length) {
          if (type === 'json') {
            Object.assign(params, { sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: `={{ JSON.stringify(${objectJs(dict(data), ctx, p.unflatten !== 'no')}) }}` });
          } else {
            Object.assign(params, { sendBody: true, contentType: 'form-urlencoded', specifyBody: 'keypair', bodyParameters: { parameters: pairs(data, ctx) } });
          }
          if (p.wrap_in_array === 'yes') ctx.note('Zapier wrapped the body in a list ("Wrap Request in Array"); n8n sends the object itself.', true);
        }
        if (p.file) ctx.note('Zapier attached a file; add it in n8n as binary data (Body → n8n Binary File).', true);
      }
      params.options = {};
      return { nodes: [n8nNode('httpRequest', ctx.step.label, params)], status: 'converted', credential };
    },
  });
}
request('post', 'POST');
request('put', 'PUT');
request('patch', 'PATCH');
request('get', 'GET');
request('custom_request', null);

// ---------- Filter and Paths ----------

register({
  source: 'zapier', key: 'FilterAPI:filter', label: 'Filter',
  build(ctx) {
    const groups = criteria(ctx.step.params);
    if (!groups) {
      ctx.note('The filter has no conditions in the export; every item passes.');
      return { nodes: [n8nNode('noOp', ctx.step.label, {})], status: 'converted' };
    }
    return { nodes: [n8nNode('filter', ctx.step.label, conditionParameters(groups, ZAPIER_OPS, ctx, ctx.step.label))], status: 'converted' };
  },
});

register({
  source: 'zapier', key: 'BranchingAPI:branch', label: 'No Operation (fan-out)',
  build(ctx) {
    ctx.note('Every path whose conditions match runs, as in Zapier.');
    return { nodes: [n8nNode('noOp', ctx.step.label, {})], status: 'converted' };
  },
});

// ---------- Formatter by Zapier ----------

type Transform = (x: string, p: Record<string, unknown>, ctx: MapCtx) => string | undefined;

const literal = (v: unknown, ctx: MapCtx) => ctx.js(str(v));

const TRANSFORMS: Record<string, Transform> = {
  'string.titlecase': (x) => `String(${x}).toTitleCase()`,
  'string.capitalize': (x) => `(s => s.charAt(0).toUpperCase() + s.slice(1))(String(${x}))`,
  'string.lowercase': (x) => `String(${x}).toLowerCase()`,
  'string.uppercase': (x) => `String(${x}).toUpperCase()`,
  'string.trim_space': (x) => `String(${x}).trim()`,
  'string.strip_html': (x) => `String(${x}).removeTags()`,
  'string.url_encode': (x) => `encodeURIComponent(String(${x}))`,
  'string.url_decode': (x) => `decodeURIComponent(String(${x}))`,
  'string.length': (x) => `String(${x}).length`,
  'string.word_count': (x) => `String(${x}).trim().split(/\\s+/).filter(Boolean).length`,
  'string.find': (x, p, ctx) => `String(${x}).indexOf(${literal(p.find, ctx)})`,
  'string.replace': (x, p, ctx) => `String(${x}).replaceAll(${literal(p.find, ctx)}, ${literal(p.replace, ctx)})`,
  'string.default_value': (x, p, ctx) => `(${x} || ${literal(p.default_value, ctx)})`,
  'string.default_value_v2': (x, p, ctx) => `(${x} || ${literal(p.default_value, ctx)})`,
  'string.truncate': (x, p) => {
    const n = Number(p.max_length);
    if (!Number.isFinite(n)) return undefined;
    return p.append_ellipsis === 'yes' || p.append_ellipsis === true
      ? `(s => s.length > ${n} ? s.slice(0, ${Math.max(0, n - 3)}) + '...' : s)(String(${x}))`
      : `String(${x}).slice(0, ${n})`;
  },
  'string.split': (x, p, ctx) => {
    const sep = p.separator === undefined || p.separator === '' ? '" "' : literal(p.separator, ctx);
    const idx = str(p.segment_index ?? p.index);
    const parts = `String(${x}).split(${sep})`;
    if (idx === 'all' || idx === 'fields' || idx === '') return parts;
    if (idx === 'last' || idx === '-1') return `${parts}.at(-1)`;
    if (idx === 'second_to_last' || idx === '-2') return `${parts}.at(-2)`;
    if (/^\d+$/.test(idx)) return `${parts}[${idx}]`;
    return idx === 'first' ? `${parts}[0]` : undefined;
  },
  'string.extract_email': (x) => `(String(${x}).match(/[\\w.+-]+@[\\w-]+\\.[\\w.-]+/)?.[0] ?? '')`,
  'string.extract_url': (x) => `(String(${x}).match(/https?:\\/\\/[^\\s"'<>]+/)?.[0] ?? '')`,
  'string.extract_number': (x) => `(String(${x}).match(/-?\\d+(?:[.,]\\d+)?/)?.[0] ?? '')`,
  'string.extract_phone': (x) => `(String(${x}).match(/\\+?[\\d\\s().-]{7,}\\d/)?.[0] ?? '')`,
  'date.formatting': (x, p) => {
    const f = convertDateFormat(str(p.to_format) || 'YYYY-MM-DDTHH:mm:ssZ');
    const zone = p.to_timezone ? `.setZone('${str(p.to_timezone).replace(/'/g, "\\'")}')` : '';
    const from = p.from_format ? `DateTime.fromFormat(String(${x}), '${convertDateFormat(str(p.from_format)).fmt}')` : `DateTime.fromISO(String(${x}))`;
    return `${from}${zone}.toFormat('${f.fmt.replace(/'/g, "\\'")}')`;
  },
  'date.manipulate': (x, p) => {
    const m = /^\s*([+-])\s*(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*$/i.exec(str(p.expression));
    if (!m) return undefined;
    return `DateTime.fromISO(String(${x})).plus({ ${m[3].toLowerCase()}s: ${m[1] === '-' ? '-' : ''}${m[2]} }).toISO()`;
  },
  'number.math_v2': (x, p) => {
    const op = ({ sum: '+', add: '+', subtract: '-', sub: '-', multiply: '*', mul: '*', divide: '/', div: '/' } as Record<string, string>)[str(p.operation).toLowerCase()];
    if (!op) return undefined;
    return `(arr => arr.map(Number).reduce((a, b) => a ${op} b))([].concat(${x}))`;
  },
  'util.lookup': (x, p, ctx) => {
    const table = Object.entries(dict(p.table)).map(([k, v]) => `${JSON.stringify(k)}: ${literal(v, ctx)}`).join(', ');
    return `(({ ${table} })[String(${x})] ?? ${p.fallback === undefined ? 'null' : literal(p.fallback, ctx)})`;
  },
  'util.pick_from_list': (x, p) => {
    const list = `(Array.isArray(${x}) ? ${x} : String(${x}).split(','))`;
    const choice = str(p.choice ?? p.operation);
    if (choice === 'last') return `${list}.at(-1)`;
    if (choice === 'random') return `(l => l[Math.floor(Math.random() * l.length)])(${list})`;
    return `${list}[0]`;
  },
};

register({
  source: 'zapier', key: 'ZapierFormatterCLIAPI:*', label: 'Edit Fields',
  build(ctx) {
    const p = ctx.step.params;
    const transform = str(p.transform);
    const input = ctx.js(p.inputs ?? p.input ?? '');
    const js = Object.hasOwn(TRANSFORMS, transform) ? TRANSFORMS[transform](input, p, ctx) : undefined;
    if (js !== undefined) {
      if (/^date\./.test(transform)) ctx.note('Zapier and n8n read unusual date texts differently; check the output once.');
      return { nodes: [setNode(ctx.step.label, [['output', `={{ ${js} }}`]])], status: 'converted' };
    }
    const suggestion = `Formatter "${transform || ctx.step.action}" has no automatic translation: write it in this Code node (placed here, disabled; it receives the input as "input"), then enable it.`;
    const jsCode = [`// Zapier Formatter: ${transform || ctx.step.action}`, `const input = ${input};`, '// TODO: transform the input', 'return { json: { output: input } };'].join('\n');
    return {
      nodes: [n8nNode('code', ctx.step.label, { mode: 'runOnceForEachItem', language: 'javaScript', jsCode }, { disabled: true, note: suggestion })],
      status: 'manual',
      suggestion,
    };
  },
});

// ---------- Code by Zapier ----------

const isPython = (code: string, action: string) =>
  /^01929fad-d3f6/.test(action) || /python/i.test(action) || (/^\s*(def |import |from \w+ import )/m.test(code) && !/\b(const|let|function)\b/.test(code));

register({
  source: 'zapier', key: 'CodeCLIAPI:*', label: 'Code',
  build(ctx) {
    const p = ctx.step.params;
    const code = str(p.code);
    const inputs = Object.entries(dict(p.input ?? p.input_data)).map(([k, v]) => [k, ctx.expr(str(v))] as [string, unknown]);
    if (isPython(code, ctx.step.action)) {
      const suggestion = 'Python from Zapier: n8n runs it in the Code node, but reads inputs differently. Replace `input_data` with the item (`_item["json"]` in n8n 2.x, `_input.item.json` in 1.x), keep `output`/`return` as a dict, then enable it.';
      const pythonCode = [
        '# Code by Zapier (Python), copied as is.',
        `# Inputs in Zapier: ${inputs.map(([k]) => k).join(', ') || 'none'} (they arrive from the step before this one).`,
        'input_data = {}',
        code,
      ].join('\n');
      const nodes = inputs.length ? [setNode(`${ctx.step.label} (inputs)`, inputs, false)] : [];
      nodes.push(n8nNode('code', ctx.step.label, { mode: 'runOnceForEachItem', language: 'pythonNative', pythonCode }, { disabled: true, note: suggestion }));
      return { nodes, status: 'manual', suggestion };
    }
    const declares = /\b(let|const|var)\s+output\b/.test(code);
    const jsCode = [
      '// Code by Zapier, wrapped: inputData holds the input fields, output (or a return value) becomes the item.',
      'const inputData = $json;',
      'const result = await (async () => {',
      declares ? '' : '  let output;',
      code.split('\n').map((l) => `  ${l}`).join('\n'),
      declares ? '' : '  return output;',
      '})();',
      'return { json: Array.isArray(result) ? { items: result } : (result ?? {}) };',
    ].filter((l) => l !== '').join('\n');
    ctx.note('Zapier ran the code in its own sandbox: check it once in n8n (fetch, packages and returning a list of items behave differently).', true);
    const nodes = [setNode(`${ctx.step.label} (inputs)`, inputs, false), n8nNode('code', ctx.step.label, { mode: 'runOnceForEachItem', language: 'javaScript', jsCode })];
    return { nodes, status: 'review' };
  },
});

// ---------- Delay, Storage, Schedule, Looping, Email ----------

register({
  source: 'zapier', key: 'DelayCLIAPI:delay_for', label: 'Wait',
  build(ctx) {
    const p = ctx.step.params;
    let amount = Number(p.time_delay_for_value ?? p.delay_for_value ?? 1);
    let unit = str(p.time_delay_for_unit ?? p.delay_for_unit ?? 'minutes').toLowerCase().replace(/s?$/, 's');
    if (unit === 'weeks') { amount *= 7; unit = 'days'; }
    if (!['seconds', 'minutes', 'hours', 'days'].includes(unit) || !Number.isFinite(amount)) {
      ctx.note(`Delay "${str(p.time_delay_for_value)} ${str(p.time_delay_for_unit)}" could not be read; set the wait time.`, true);
      return { nodes: [n8nNode('wait', ctx.step.label, { amount: 1, unit: 'minutes' })], status: 'review' };
    }
    return { nodes: [n8nNode('wait', ctx.step.label, { amount, unit })], status: 'converted' };
  },
});

register({
  source: 'zapier', key: 'DelayCLIAPI:delay_until', label: 'Wait',
  build(ctx) {
    const when = ctx.expr(str(ctx.step.params.time_delay_until ?? ctx.step.params.delay_until));
    ctx.note('Zapier waited until a date and time; check the time zone of the value.', true);
    return { nodes: [n8nNode('wait', ctx.step.label, { resume: 'specificTime', dateTime: when })], status: 'review' };
  },
});

function storage(action: string, body: (ctx: MapCtx) => string) {
  register({
    source: 'zapier', key: `StorageCLIAPI:${action}`, label: 'Code (static data)',
    build(ctx) {
      ctx.note('Storage by Zapier became this workflow\'s static data: it is kept between production runs of this workflow only (not in test runs, not shared with other workflows). Use a Data Table to share values.', true);
      const jsCode = [`const store = $getWorkflowStaticData('global');`, body(ctx)].join('\n');
      return { nodes: [n8nNode('code', ctx.step.label, { mode: 'runOnceForEachItem', language: 'javaScript', jsCode })], status: 'review' };
    },
  });
}
storage('set_value', (ctx) => `const key = String(${ctx.js(str(ctx.step.params.key))});\nstore[key] = ${ctx.js(str(ctx.step.params.value))};\nreturn { json: { key, value: store[key] } };`);
storage('get_value', (ctx) => `const key = String(${ctx.js(str(ctx.step.params.key))});\nreturn { json: { key, value: store[key] ?? null } };`);
storage('increment_value', (ctx) => `const key = String(${ctx.js(str(ctx.step.params.key))});\nstore[key] = Number(store[key] ?? 0) + Number(${ctx.js(str(ctx.step.params.amount ?? '1'))});\nreturn { json: { key, value: store[key] } };`);
storage('remove_value', (ctx) => `const key = String(${ctx.js(str(ctx.step.params.key))});\ndelete store[key];\nreturn { json: { key } };`);
storage('get_all_values', () => 'return { json: { ...store } };');

const hour = (v: unknown) => {
  const n = Number(String(v ?? '9').replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n >= 0 && n < 24 ? n : 9;
};

register({
  source: 'zapier', key: 'ScheduleAPI:*', label: 'Schedule Trigger',
  build(ctx) {
    const p = ctx.step.params;
    const h = hour(p.time_of_day);
    const weekdays = p.trigger_on_weekends === 'no' || p.trigger_on_weekends === false;
    let rule: Record<string, unknown>;
    switch (ctx.step.action) {
      case 'every_hour': rule = weekdays ? { field: 'cronExpression', expression: '0 * * * 1-5' } : { field: 'hours', hoursInterval: 1 }; break;
      case 'every_week': rule = { field: 'weeks', triggerAtDay: [Number(p.day_of_week ?? 1) % 7], triggerAtHour: h }; break;
      case 'every_month': rule = { field: 'months', triggerAtDayOfMonth: Number(p.day_of_month ?? 1) || 1, triggerAtHour: h }; break;
      default: rule = weekdays ? { field: 'cronExpression', expression: `0 ${h} * * 1-5` } : { field: 'days', triggerAtHour: h };
    }
    if (weekdays) ctx.note('Weekends are skipped, as in Zapier (a cron rule for Monday to Friday).');
    ctx.note('Check the time zone in n8n (Settings → Time zone); Zapier used the account time zone.');
    return { nodes: [n8nNode('scheduleTrigger', ctx.step.label, { rule: { interval: [rule] } })], status: 'converted' };
  },
});

register({
  source: 'zapier', key: 'LoopingCLIAPI:*', label: 'Split Out',
  build(ctx) {
    const values = Object.entries(dict(ctx.step.params.values ?? ctx.step.params.line_items));
    const [first] = values;
    const list = first ? `[].concat(${ctx.js(str(first[1]))}).flatMap((v) => typeof v === 'string' ? v.split(',').map((s) => s.trim()) : [v])` : '[]';
    ctx.note('Looping by Zapier became Split Out: each value becomes one item. Check the field names after the loop.', true);
    return {
      nodes: [
        n8nNode('set', `${ctx.step.label} (list)`, { mode: 'manual', assignments: { assignments: [assignment(first?.[0] ?? 'items', `={{ ${list} }}`, 'array')] }, options: {} }),
        n8nNode('splitOut', ctx.step.label, { fieldToSplitOut: first?.[0] ?? 'items', include: 'noOtherFields', options: {} }),
      ],
      status: 'review',
    };
  },
});

register({
  source: 'zapier', key: 'EmailCLIAPI:*', label: 'Send Email',
  build(ctx) {
    const p = ctx.step.params;
    const params: Record<string, unknown> = {
      fromEmail: 'REPLACE-ME@example.com',
      toEmail: ctx.expr(Array.isArray(p.to) ? p.to.join(', ') : str(p.to)),
      subject: ctx.expr(str(p.subject)),
      emailFormat: 'text',
      text: ctx.expr(str(p.body)),
      options: p.reply_to ? { replyTo: ctx.expr(str(p.reply_to)) } : {},
    };
    ctx.note('Email by Zapier used Zapier\'s mail server; n8n sends through your SMTP account: add the credential and the sender address.', true);
    return {
      nodes: [n8nNode('emailSend', ctx.step.label, params)],
      status: 'review',
      credential: { app: 'SMTP', credentialType: 'smtp' },
      placeholders: [{ field: 'fromEmail', value: 'REPLACE-ME@example.com' }],
    };
  },
});
