/** Make's built-in modules: webhooks, HTTP, JSON, variables, flow control, tools. */
import { randomUUID } from 'node:crypto';

import { nodeRef } from '../../util/names.ts';
import { n8nNode, register, type MapCtx, type MapOutput } from '../registry.ts';

type Pair = { name?: string; key?: string; value?: unknown };

const list = (v: unknown): Pair[] => (Array.isArray(v) ? (v as Pair[]).filter((p) => p && typeof p === 'object') : []);
const pairs = (v: unknown, ctx: MapCtx) =>
  list(v).filter((p) => (p.name ?? p.key) !== undefined && String(p.name ?? p.key) !== '').map((p) => ({ name: String(p.name ?? p.key), value: ctx.expr(p.value ?? '') }));
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const numberOr = (v: unknown, ctx: MapCtx): unknown => (/^\s*-?\d+(\.\d+)?\s*$/.test(str(v)) ? Number(v) : ctx.expr(str(v)));

const assignment = (name: string, value: unknown, type = 'string') => ({ id: randomUUID(), name, value, type });
const setFields = (fields: Array<{ name: string; value: unknown; type?: string }>) => ({
  mode: 'manual',
  assignments: { assignments: fields.map((f) => assignment(f.name, f.value, f.type)) },
  includeOtherFields: true,
  options: {},
});

// ---------- webhooks ----------

register({
  source: 'make', key: 'gateway:CustomWebHook', label: 'Webhook',
  build(ctx) {
    const path = ctx.slug || `make-${ctx.step.id}`;
    const responseMode = ctx.has('gateway:WebhookRespond') ? 'responseNode' : 'onReceived';
    ctx.note('The webhook gets a new URL in n8n: point the sender (form, app) to it. Make accepted GET and POST; this listens to POST.');
    return {
      nodes: [n8nNode('webhook', ctx.step.label, { httpMethod: 'POST', path, responseMode, options: {} }, { webhookId: randomUUID() })],
      status: 'converted',
      webhookPath: path,
      // Make exposes the posted fields at the top; n8n puts them under `body`.
      ref: (out) => ({ base: `${nodeRef(out)}.item.json.body`, drop: 0 }),
    };
  },
});

register({
  source: 'make', key: 'gateway:WebhookRespond', label: 'Respond to Webhook',
  build(ctx) {
    const p = ctx.step.params;
    const options: Record<string, unknown> = { responseCode: numberOr(p.status ?? 200, ctx) };
    const headers = pairs(p.headers, ctx);
    if (headers.length) options.responseHeaders = { entries: headers };
    return {
      nodes: [n8nNode('respondToWebhook', ctx.step.label, { respondWith: 'text', responseBody: ctx.expr(str(p.body)), options })],
      status: 'converted',
    };
  },
});

// ---------- HTTP ----------

function httpEntry(key: string, label: string, auth?: 'basic' | 'apiKey') {
  register({
    source: 'make', key, label,
    build(ctx): MapOutput {
      const p = ctx.step.params;
      const method = (str(p.method) || 'get').toUpperCase();
      const params: Record<string, unknown> = { method, url: ctx.expr(str(p.url)) };
      let credential: MapOutput['credential'];
      if (auth === 'apiKey') {
        params.authentication = 'genericCredentialType';
        params.genericAuthType = 'httpHeaderAuth';
        credential = { app: 'API key', credentialType: 'httpHeaderAuth' };
        ctx.note('The API key from the Make keychain moves to an n8n "Header Auth" credential (or "Query Auth" if the key went in the URL).', true);
      } else if (auth === 'basic' || p.authUser || p.authPass) {
        params.authentication = 'genericCredentialType';
        params.genericAuthType = 'httpBasicAuth';
        credential = { app: 'HTTP Basic Auth', credentialType: 'httpBasicAuth' };
        ctx.note('Basic auth user and password move to an n8n "Basic Auth" credential.');
      }
      const qs = pairs(p.qs, ctx);
      if (qs.length) Object.assign(params, { sendQuery: true, queryParameters: { parameters: qs } });
      const headers = pairs(p.headers, ctx);
      if (headers.length) Object.assign(params, { sendHeaders: true, headerParameters: { parameters: headers } });
      if (headers.some((h) => /^authorization$/i.test(h.name) || /api[-_]?key|token/i.test(h.name))) {
        ctx.note('A secret is sent in a header; consider moving it to an n8n "Header Auth" credential.');
      }
      const bodyType = str(p.bodyType);
      if (bodyType === 'raw') {
        const ct = str(p.contentType) || 'application/json';
        if (/json/i.test(ct)) Object.assign(params, { sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: ctx.expr(str(p.data)) });
        else Object.assign(params, { sendBody: true, contentType: 'raw', rawContentType: ct, body: ctx.expr(str(p.data)) });
      } else if (bodyType === 'x_www_form_urlencoded') {
        Object.assign(params, { sendBody: true, contentType: 'form-urlencoded', specifyBody: 'keypair', bodyParameters: { parameters: pairs(p.data, ctx) } });
      } else if (bodyType === 'multipart_form_data') {
        const fields = list(p.data);
        const plain = fields.filter((f) => (f as { fieldType?: string }).fieldType !== 'file');
        Object.assign(params, { sendBody: true, contentType: 'multipart-form-data', bodyParameters: { parameters: pairs(plain, ctx).map((x) => ({ parameterType: 'formData', ...x })) } });
        if (plain.length < fields.length) ctx.note('File fields of the multipart body need a binary property in n8n: add them in the Body section.', true);
      }
      const options: Record<string, unknown> = {};
      if (key === 'http:ActionGetFile') options.response = { response: { responseFormat: 'file' } };
      else if (p.parseResponse === false) options.response = { response: { responseFormat: 'text' } };
      if (p.timeout && /^\d+$/.test(str(p.timeout))) options.timeout = Number(p.timeout) * 1000;
      if (p.followRedirect === false) options.redirect = { redirect: { followRedirects: false } };
      if (p.rejectUnauthorized === false) options.allowUnauthorizedCerts = true;
      params.options = options;
      return {
        nodes: [n8nNode('httpRequest', ctx.step.label, params)],
        status: 'converted',
        credential,
        ref: (_out, first) => {
          if (first === 'data') return { base: `${nodeRef(_out)}.item.json`, drop: 1 };
          if (first === 'statusCode' || first === 'headers' || first === 'cookieHeaders') {
            throw new Error(`the HTTP ${first} is not in the n8n output by default (HTTP Request → Options → Response → Include Response Headers and Status)`);
          }
          return undefined;
        },
      };
    },
  });
}
httpEntry('http:ActionSendData', 'HTTP Request');
httpEntry('http:ActionGetFile', 'HTTP Request (file)');
httpEntry('http:ActionSendDataBasicAuth', 'HTTP Request (basic auth)', 'basic');
httpEntry('http:ActionSendDataAPIKeyAuth', 'HTTP Request (API key)', 'apiKey');

/** Make's current HTTP module ("Make a request", v4). */
register({
  source: 'make', key: 'http:MakeRequest', label: 'HTTP Request',
  build(ctx): MapOutput {
    const p = ctx.step.params;
    const params: Record<string, unknown> = { method: (str(p.method) || 'get').toUpperCase(), url: ctx.expr(str(p.url)) };
    let credential: MapOutput['credential'];
    const authType = str(p.authenticationType);
    if (authType && authType !== 'noAuth') {
      const generic = authType === 'basicAuth' ? 'httpBasicAuth' : authType === 'apiKey' ? 'httpHeaderAuth' : 'oAuth2Api';
      Object.assign(params, { authentication: 'genericCredentialType', genericAuthType: generic });
      credential = { app: `HTTP (${authType})`, credentialType: generic };
      ctx.note(`Make used "${authType}" from its keychain; create the matching n8n credential.`, true);
    }
    const qs = pairs(p.queryParameters, ctx);
    if (qs.length) Object.assign(params, { sendQuery: true, queryParameters: { parameters: qs } });
    const headers = pairs(p.headers, ctx);
    if (headers.length) Object.assign(params, { sendHeaders: true, headerParameters: { parameters: headers } });
    if (headers.some((h) => /^authorization$/i.test(h.name) || /api[-_]?key|token/i.test(h.name))) ctx.note('A secret is sent in a header; consider moving it to an n8n "Header Auth" credential.');
    const ct = str(p.contentType);
    if (ct === 'json' || ct === 'application/json') {
      if (p.inputMethod === 'dataStructure') {
        Object.assign(params, { sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: `={{ JSON.stringify(${ctx.js(p.jsonDataStructureBodyContent ?? p.bodyContent ?? {})}) }}` });
        ctx.note('Make built the JSON body from a data structure; check the field names.', true);
      } else {
        Object.assign(params, { sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: ctx.expr(str(p.jsonStringBodyContent ?? p.bodyContent)) });
      }
    } else if (ct === 'x-www-form-urlencoded' || ct === 'urlEncoded') {
      Object.assign(params, { sendBody: true, contentType: 'form-urlencoded', specifyBody: 'keypair', bodyParameters: { parameters: pairs(p.formBodyContent ?? p.bodyContent, ctx) } });
    } else if (ct === 'multipart/form-data' || ct === 'multipart') {
      Object.assign(params, { sendBody: true, contentType: 'multipart-form-data', bodyParameters: { parameters: pairs(p.multipartBodyContent ?? p.bodyContent, ctx).map((x) => ({ parameterType: 'formData', ...x })) } });
      ctx.note('Check the multipart fields; files need a binary property in n8n.', true);
    } else if (ct) {
      Object.assign(params, { sendBody: true, contentType: 'raw', rawContentType: str(p.customContentType) || 'text/plain', body: ctx.expr(str(p.textBodyContent ?? p.bodyContent)) });
    }
    params.options = p.stopOnHttpError === false ? { response: { response: { neverError: true } } } : {};
    return {
      nodes: [n8nNode('httpRequest', ctx.step.label, params)], status: 'converted', credential,
      ref: (out, first) => {
        if (first === 'data') return { base: `${nodeRef(out)}.item.json`, drop: 1 };
        if (first === 'statusCode' || first === 'headers') throw new Error(`the HTTP ${first} is not in the n8n output by default (HTTP Request → Options → Response → Include Response Headers and Status)`);
        return undefined;
      },
    };
  },
});

// ---------- JSON ----------

register({
  source: 'make', key: 'json:ParseJSON', label: 'Edit Fields (JSON)',
  build(ctx) {
    const value = ctx.expr(str(ctx.step.params.json));
    return { nodes: [n8nNode('set', ctx.step.label, { mode: 'raw', jsonOutput: value, options: {} })], status: 'converted' };
  },
});

register({
  source: 'make', key: 'json:TransformToJSON', label: 'Edit Fields',
  build(ctx) {
    const js = ctx.js(str(ctx.step.params.object));
    return { nodes: [n8nNode('set', ctx.step.label, setFields([{ name: 'json', value: `={{ JSON.stringify(${js}) }}` }]))], status: 'converted' };
  },
});

register({
  source: 'make', key: 'json:CreateJSON', label: 'Edit Fields',
  build(ctx) {
    const fields = Object.entries(ctx.step.params).filter(([k]) => k !== 'type' && k !== 'space');
    const obj = fields.map(([k, v]) => `${JSON.stringify(k)}: ${typeof v === 'string' ? ctx.js(v) : JSON.stringify(v)}`).join(', ');
    ctx.note('Make built the JSON from a data structure; check that the field names match it.', true);
    return { nodes: [n8nNode('set', ctx.step.label, setFields([{ name: 'json', value: `={{ JSON.stringify({ ${obj} }) }}` }]))], status: 'review' };
  },
});

register({
  source: 'make', key: 'json:AggregateToJSON', label: 'Aggregate + Edit Fields',
  build(ctx) {
    ctx.note('Make aggregated the items into one JSON text; check which fields should be included.', true);
    return {
      nodes: [
        n8nNode('aggregate', `${ctx.step.label} (collect)`, { aggregate: 'aggregateAllItemData', destinationFieldName: 'array', options: {} }),
        n8nNode('set', ctx.step.label, setFields([{ name: 'json', value: '={{ JSON.stringify($json.array) }}' }])),
      ],
      status: 'review',
    };
  },
});

// ---------- variables ----------

register({
  source: 'make', key: 'util:SetVariable2', label: 'Edit Fields',
  build(ctx) {
    const name = str(ctx.step.params.name) || 'value';
    return { nodes: [n8nNode('set', ctx.step.label, setFields([{ name, value: ctx.expr(str(ctx.step.params.value)) }]))], status: 'converted', sets: [name] };
  },
});

function setVariables(key: string) {
  register({
    source: 'make', key, label: 'Edit Fields',
    build(ctx) {
      const vars = list(ctx.step.params.variables).map((v) => ({ name: str(v.name), value: ctx.expr(str(v.value)) })).filter((v) => v.name);
      return { nodes: [n8nNode('set', ctx.step.label, setFields(vars))], status: 'converted', sets: vars.map((v) => v.name) };
    },
  });
}
setVariables('util:SetVariables');
setVariables('util:SetMultipleVariables');

function getVariables(key: string) {
  register({
    source: 'make', key, label: 'Edit Fields',
    build(ctx) {
      const names = key === 'util:GetVariable2' ? [str(ctx.step.params.name)] : list(ctx.step.params.variables).map((v) => str(v.name));
      const fields = names.filter(Boolean).map((name) => {
        const from = ctx.variable(name);
        if (!from) ctx.note(`Variable "${name}" is not set earlier in this scenario (another scenario or run may set it); give it a value.`, true);
        const ref = from ? `${nodeRef(from)}.item.json${/^[A-Za-z_$][\w$]*$/.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`}` : 'null';
        return { name, value: `={{ ${ref} }}` };
      });
      return { nodes: [n8nNode('set', ctx.step.label, setFields(fields))], status: 'converted' };
    },
  });
}
getVariables('util:GetVariable2');
getVariables('util:GetVariables');

// ---------- flow control ----------

register({
  source: 'make', key: 'builtin:BasicRouter', label: 'No Operation (fan-out)',
  build(ctx) {
    return { nodes: [n8nNode('noOp', ctx.step.label, {})], status: 'converted' };
  },
});

function iterator(key: string) {
  register({
    source: 'make', key, label: 'Split Out',
    build(ctx) {
      const items = ctx.expr(str(ctx.step.params.array));
      // When the array is a plain field of the step right before, split that field directly.
      const prefix = ctx.previous ? `={{ ${nodeRef(ctx.previous)}.item.json.` : undefined;
      const path = prefix && typeof items === 'string' && items.startsWith(prefix) && items.endsWith(' }}') ? items.slice(prefix.length, -3) : '';
      const direct = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(path);
      const field = direct ? path : 'items';
      const leaf = field.split('.').pop()!;
      ctx.note(`Each array element becomes one item. If the array holds plain values (not objects), read them as {{ $json.${leaf} }}.`);
      const split = n8nNode('splitOut', ctx.step.label, { fieldToSplitOut: field, include: 'noOtherFields', options: {} });
      return {
        nodes: direct
          ? [split]
          : [n8nNode('set', `${ctx.step.label} (array)`, { mode: 'manual', assignments: { assignments: [assignment('items', items, 'array')] }, options: {} }), split],
        status: 'converted',
        ref: (out, first) => {
          const ref = nodeRef(out);
          if (first === '__IMTINDEX__') return { base: '($itemIndex + 1)', drop: 1 };
          if (first === '__IMTLENGTH__') return { base: `${ref}.all().length`, drop: 1 };
          if (first === 'value') return { base: `(${ref}.item.json.${leaf} ?? ${ref}.item.json.value)`, drop: 1 };
          return undefined;
        },
      };
    },
  });
}
iterator('builtin:BasicFeeder');
iterator('builtin:BasicIterator');

register({
  source: 'make', key: 'builtin:BasicAggregator', label: 'Aggregate',
  build(ctx) {
    const fields = Object.entries(ctx.step.params).filter(([k]) => !['feeder', 'groupBy', 'stopIfEmpty', 'target'].includes(k));
    const nodes = [];
    if (fields.length) {
      nodes.push(n8nNode('set', `${ctx.step.label} (fields)`, {
        mode: 'manual',
        assignments: { assignments: fields.map(([k, v]) => assignment(k, ctx.expr(typeof v === 'string' ? v : JSON.stringify(v)))) },
        options: {},
      }));
    }
    nodes.push(n8nNode('aggregate', ctx.step.label, { aggregate: 'aggregateAllItemData', destinationFieldName: 'array', options: {} }));
    if (ctx.step.params.groupBy) ctx.note('Make grouped the items ("Group by"); n8n aggregates all of them: split by group with a Code node or Summarize.', true);
    ctx.note('Collects every item that reaches it into "array", like Make closing the iterator.');
    return { nodes, status: ctx.step.params.groupBy ? 'review' : 'converted' };
  },
});

register({
  source: 'make', key: 'util:TextAggregator', label: 'Aggregate + Edit Fields',
  build(ctx) {
    const p = ctx.step.params;
    const sepRaw = str(p.rowSeparator);
    const sep = sepRaw === '' || sepRaw === '\n' || sepRaw === 'newline' ? '\n' : sepRaw === 'tab' || sepRaw === '\t' ? '\t' : sepRaw === 'other' ? str(p.otherSeparator) : sepRaw;
    return {
      nodes: [
        n8nNode('set', `${ctx.step.label} (rows)`, { mode: 'manual', assignments: { assignments: [assignment('value', ctx.expr(str(p.value)))] }, options: {} }),
        n8nNode('aggregate', `${ctx.step.label} (collect)`, { aggregate: 'aggregateIndividualFields', fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: 'value', renameField: true, outputFieldName: 'rows' }] }, options: {} }),
        n8nNode('set', ctx.step.label, setFields([{ name: 'text', value: `={{ $json.rows.join(${JSON.stringify(sep)}) }}` }])),
      ],
      status: 'converted',
    };
  },
});

register({
  source: 'make', key: 'util:FunctionSleep', label: 'Wait',
  build(ctx) {
    return { nodes: [n8nNode('wait', ctx.step.label, { amount: numberOr(ctx.step.params.duration ?? 1, ctx), unit: 'seconds' })], status: 'converted' };
  },
});

register({
  source: 'make', key: 'util:Switcher', label: 'Edit Fields',
  build(ctx) {
    const p = ctx.step.params;
    const cases = list(p.casesTable).map((c) => ({ pattern: (c as { pattern?: unknown }).pattern, output: (c as { output?: unknown }).output }));
    const input = ctx.js(str(p.input));
    const otherwise = p.elseOutput !== undefined ? ctx.js(str(p.elseOutput)) : 'null';
    const regex = p.useRegexpMatch === true;
    const chain = cases.reduceRight<string>((acc, c) => {
      const test = regex ? `new RegExp(${ctx.js(str(c.pattern))}).test(String(v))` : `String(v) === String(${ctx.js(str(c.pattern))})`;
      return `(${test} ? ${ctx.js(str(c.output))} : ${acc})`;
    }, otherwise);
    return { nodes: [n8nNode('set', ctx.step.label, setFields([{ name: 'output', value: `={{ ((v) => ${chain})(${input}) }}` }]))], status: 'converted' };
  },
});

register({
  source: 'make', key: 'placeholder:Placeholder', label: 'No Operation',
  build(ctx) {
    return { nodes: [n8nNode('noOp', ctx.step.label, {})], status: 'converted' };
  },
});

// ---------- text parser ----------

register({
  source: 'make', key: 'regexp:Parser', label: 'Code',
  build(ctx) {
    const p = ctx.step.params;
    const flags = `${p.global ? 'g' : ''}${p.sensitive === false ? 'i' : ''}${p.multiline ? 'm' : ''}`;
    const code = [
      `const text = String(${ctx.js(str(p.text))});`,
      `const re = new RegExp(${ctx.js(str(p.pattern))}, ${JSON.stringify(flags.replace('g', ''))});`,
      'const m = re.exec(text);',
      'return { json: m ? { ...m.groups, $1: m[1], $2: m[2], $3: m[3], match: m[0] } : {} };',
    ].join('\n');
    ctx.note('Make "Match pattern" became a Code node with a JavaScript RegExp; Make returned one bundle per match when "Global match" was on, this returns the first match.', true);
    return { nodes: [n8nNode('code', ctx.step.label, { mode: 'runOnceForEachItem', language: 'javaScript', jsCode: code })], status: 'review' };
  },
});

register({
  source: 'make', key: 'regexp:Replace', label: 'Edit Fields',
  build(ctx) {
    const p = ctx.step.params;
    const flags = `${p.global === false ? '' : 'g'}${p.sensitive === false ? 'i' : ''}${p.multiline ? 'm' : ''}`;
    const value = `={{ String(${ctx.js(str(p.text))}).replace(new RegExp(${ctx.js(str(p.pattern))}, ${JSON.stringify(flags)}), ${ctx.js(str(p.value))}) }}`;
    ctx.note('Make regular expressions and JavaScript ones differ in rare cases (look-behind, $ references); check the result.', true);
    return { nodes: [n8nNode('set', ctx.step.label, setFields([{ name: 'text', value }]))], status: 'review' };
  },
});

