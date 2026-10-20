/** Make app modules beyond Google: AI, messaging, Airtable, data stores, Apify, Perplexity, "Make an API call". */
import { findApp } from '../apps.ts';
import { n8nNode, register, type MapCtx, type MapOutput } from '../registry.ts';
import { appRef, httpMethod, rl, str, urlWith } from '../shared.ts';

const num = (v: unknown): number | undefined => (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
const list = <T = Record<string, unknown>>(v: unknown): T[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as T[]) : []);
const joinList = (v: unknown) => (Array.isArray(v) ? v.filter((x) => x !== '' && x !== null).map(String).join(', ') : str(v));
const AI_NOTE = 'n8n returns the answer in its own output shape: open the node once after a test run and adjust the fields later steps read.';

// ---------- AI ----------

function chatMessages(v: unknown, ctx: MapCtx) {
  return list<{ role?: unknown; content?: unknown }>(v).map((m) => {
    const content = Array.isArray(m.content)
      ? list<{ type?: unknown; text?: unknown }>(m.content).filter((c) => c.type === 'text' || c.text).map((c) => str(c.text)).join('\n')
      : str(m.content);
    if (Array.isArray(m.content) && m.content.some((c: { type?: unknown }) => c?.type && c.type !== 'text')) ctx.note('Images or files in the messages: add them as separate inputs in the n8n node.', true);
    const role = ['system', 'assistant', 'user'].includes(str(m.role)) ? str(m.role) : 'user';
    return { type: 'text', role, content: ctx.expr(content) };
  });
}

register({
  source: 'make', key: 'openai-gpt-3:CreateCompletion', label: 'OpenAI: Message a Model',
  build(ctx) {
    const p = ctx.step.params;
    if (p.select && p.select !== 'chat') ctx.note(`Make used the "${str(p.select)}" mode; n8n sends a chat message: check the prompt.`, true);
    const options: Record<string, unknown> = {};
    if (num(p.max_tokens) !== undefined) options.maxTokens = num(p.max_tokens);
    if (num(p.temperature) !== undefined) options.temperature = num(p.temperature);
    if (num(p.top_p) !== undefined && num(p.top_p) !== 1) options.topP = num(p.top_p);
    if (p.response_format === 'json_object') ctx.note('Make asked for a JSON answer; set Options → Text Format → JSON Object in n8n if later steps parse it.', true);
    if (num(p.n_completions) !== undefined && num(p.n_completions)! > 1) ctx.note('Make asked for several answers; n8n returns one.', true);
    ctx.note(AI_NOTE);
    return {
      nodes: [n8nNode('openAi', ctx.step.label, { resource: 'text', operation: 'response', modelId: rl('id', ctx.expr(str(p.model) || 'gpt-4o-mini')), responses: { values: chatMessages(p.messages, ctx) }, simplify: true, options })],
      status: 'converted', credential: { app: 'OpenAI', credentialType: 'openAiApi' }, ref: appRef('OpenAI'),
    };
  },
});

register({
  source: 'make', key: 'openai-gpt-3:messageAssistantAdvanced', label: 'OpenAI: Message a Model (instructions)',
  build(ctx) {
    const p = ctx.step.params;
    ctx.note(`Make talked to the OpenAI Assistant ${str(p.assistantId)}; n8n sends the message to a model: copy the assistant's instructions into Options → Instructions and pick its model.`, true);
    return {
      nodes: [n8nNode('openAi', ctx.step.label, { resource: 'text', operation: 'response', modelId: rl('id', 'gpt-4o-mini'), responses: { values: [{ type: 'text', role: 'user', content: ctx.expr(str(p.message)) }] }, simplify: true, options: {} })],
      status: 'review', credential: { app: 'OpenAI', credentialType: 'openAiApi' }, ref: appRef('OpenAI'),
    };
  },
});

register({
  source: 'make', key: 'gemini-ai:createACompletionGeminiPro', label: 'Google Gemini: Message a Model',
  build(ctx) {
    const p = ctx.step.params;
    const messages = list<{ role?: unknown; parts?: unknown }>(p.contents).map((c) => ({
      content: ctx.expr(list<{ text?: unknown }>(c.parts).map((x) => str(x.text)).join('\n')),
      role: c.role === 'model' ? 'model' : 'user',
    }));
    const options: Record<string, unknown> = {};
    const sys = list<{ text?: unknown }>((p.system_instruction as { parts?: unknown })?.parts).map((x) => str(x.text)).join('\n');
    if (sys) options.systemMessage = ctx.expr(sys);
    const cfg = (p.generationConfig ?? {}) as Record<string, unknown>;
    if (num(cfg.temperature) !== undefined) options.temperature = num(cfg.temperature);
    if (num(cfg.maxOutputTokens) !== undefined) options.maxOutputTokens = num(cfg.maxOutputTokens);
    ctx.note(AI_NOTE);
    const model = str(p.model) || 'gemini-1.5-flash';
    return {
      nodes: [n8nNode('googleGemini', ctx.step.label, { resource: 'text', operation: 'message', modelId: rl('id', model.startsWith('models/') ? model : `models/${model}`), messages: { values: messages }, options })],
      status: 'converted', credential: { app: 'Google Gemini', credentialType: 'googlePalmApi' }, ref: appRef('Google Gemini'),
    };
  },
});

register({
  source: 'make', key: 'anthropic-claude:createAMessage', label: 'Anthropic: Message a Model',
  build(ctx) {
    const p = ctx.step.params;
    const messages = list<{ role?: unknown; content?: unknown }>(p.messages).map((m) => ({ content: ctx.expr(typeof m.content === 'string' ? m.content : list<{ text?: unknown }>(m.content).map((c) => str(c.text)).join('\n')), role: m.role === 'assistant' ? 'assistant' : 'user' }));
    const options: Record<string, unknown> = {};
    if (str(p.system)) options.system = ctx.expr(str(p.system));
    if (num(p.max_tokens) !== undefined) options.maxTokens = num(p.max_tokens);
    if (num(p.temperature) !== undefined) options.temperature = num(p.temperature);
    ctx.note(AI_NOTE);
    return {
      nodes: [n8nNode('anthropic', ctx.step.label, { resource: 'text', operation: 'message', modelId: rl('id', ctx.expr(str(p.model) || 'claude-3-5-haiku-latest')), messages: { values: messages }, options })],
      status: 'converted', credential: { app: 'Anthropic', credentialType: 'anthropicApi' }, ref: appRef('Anthropic'),
    };
  },
});

/** A REST call to a known API, with a Header Auth credential for the key. */
function apiCall(ctx: MapCtx, app: string, method: string, url: unknown, body?: string): MapOutput {
  const params: Record<string, unknown> = { method, url, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' };
  if (body !== undefined) Object.assign(params, { sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: body });
  params.options = {};
  ctx.note(`Add the ${app} API key as an n8n "Header Auth" credential (Authorization: Bearer <key>).`, true);
  return { nodes: [n8nNode('httpRequest', ctx.step.label, params)], status: 'review', credential: { app, credentialType: 'httpHeaderAuth' }, ref: appRef(app) };
}

register({
  source: 'make', key: 'perplexity-ai:createAChatCompletion', label: 'HTTP Request (Perplexity API)',
  build(ctx) {
    const p = ctx.step.params;
    const msgs = list<{ role?: unknown; content?: unknown }>(p.messages).map((m) => `{ role: ${JSON.stringify(str(m.role) || 'user')}, content: ${ctx.js(str(m.content))} }`);
    const extra = num(p.max_tokens) !== undefined ? `, max_tokens: ${num(p.max_tokens)}` : '';
    return apiCall(ctx, 'Perplexity', 'POST', 'https://api.perplexity.ai/chat/completions', `={{ JSON.stringify({ model: ${ctx.js(str(p.model) || 'sonar')}, messages: [${msgs.join(', ')}]${extra} }) }}`);
  },
});

register({
  source: 'make', key: 'apify:fetchDatasetItems', label: 'HTTP Request (Apify API)',
  build(ctx) {
    const p = ctx.step.params;
    const qs = [`format=${encodeURIComponent(str(p.format) || 'json')}`, p.type === 'clean' ? 'clean=true' : '', num(p.limit) ? `limit=${num(p.limit)}` : '', num(p.offset) ? `offset=${num(p.offset)}` : ''].filter(Boolean).join('&');
    return apiCall(ctx, 'Apify', 'GET', urlWith('https://api.apify.com/v2/datasets/', ctx.js(str(p.datasetId)), `/items?${qs}`));
  },
});

register({
  source: 'make', key: 'apify:runActor', label: 'HTTP Request (Apify API)',
  build(ctx) {
    const p = ctx.step.params;
    const path = p.runSync === true ? 'run-sync-get-dataset-items' : 'runs';
    return apiCall(ctx, 'Apify', 'POST', urlWith('https://api.apify.com/v2/acts/', ctx.js(str(p.actorId)), `/${path}`), ctx.expr(str(p.inputBody) || '{}') as string);
  },
});

// ---------- messaging ----------

register({
  source: 'make', key: 'email:ActionSendEmail', label: 'Send Email (SMTP)',
  build(ctx) {
    const p = ctx.step.params;
    const html = p.contentType !== 'text' && str(p.html) !== '';
    const options: Record<string, unknown> = {};
    if (joinList(p.cc)) options.ccEmail = ctx.expr(joinList(p.cc));
    if (joinList(p.bcc)) options.bccEmail = ctx.expr(joinList(p.bcc));
    if (str(p.replyTo)) options.replyTo = ctx.expr(str(p.replyTo));
    const from = str(p.from);
    const placeholders = from ? [] : [{ field: 'fromEmail', value: 'REPLACE-ME@example.com' }];
    if (!from) ctx.note('Make sent from the connected mailbox; set the sender address in n8n.');
    if (list(p.attachments).length) ctx.note('Attachments become n8n binary data: add them under Options → Attachments.', true);
    const params: Record<string, unknown> = { resource: 'email', operation: 'send', fromEmail: from ? ctx.expr(from) : 'REPLACE-ME@example.com', toEmail: ctx.expr(joinList(p.to)), subject: ctx.expr(str(p.subject)), emailFormat: html ? 'html' : 'text' };
    params[html ? 'html' : 'text'] = ctx.expr(str(html ? p.html : p.text ?? p.html));
    params.options = options;
    return { nodes: [n8nNode('emailSend', ctx.step.label, params)], status: 'converted', credential: { app: 'SMTP', credentialType: 'smtp' }, placeholders };
  },
});

register({
  source: 'make', key: 'slack:CreateMessage', label: 'Slack: Send Message',
  build(ctx) {
    const p = ctx.step.params;
    const channel = str(p.channel).trim();
    const toUser = p.channelType === 'im' || /^[UW][A-Z0-9]{6,}$/.test(channel);
    const locator = /^#/.test(channel) ? rl('name', channel.slice(1)) : rl('id', ctx.expr(channel));
    const params: Record<string, unknown> = { resource: 'message', operation: 'post', select: toUser ? 'user' : 'channel', messageType: 'text', text: ctx.expr(str(p.text)), otherOptions: {} };
    params[toUser ? 'user' : 'channelId'] = locator;
    if (p.mrkdwn === false) (params.otherOptions as Record<string, unknown>).mrkdwn = false;
    if (str(p.thread_ts)) (params.otherOptions as Record<string, unknown>).thread_ts = { replyValues: { thread_ts: ctx.expr(str(p.thread_ts)) } };
    if (list(p.blocks).length || str(p.blocks)) ctx.note('Make sent Slack blocks; switch "Message Type" to Blocks and paste them.', true);
    return { nodes: [n8nNode('slack', ctx.step.label, params)], status: 'converted', credential: { app: 'Slack', credentialType: 'slackApi' }, ref: appRef('Slack') };
  },
});

register({
  source: 'make', key: 'telegram:SendReplyMessage', label: 'Telegram: Send Message',
  build(ctx) {
    const p = ctx.step.params;
    const extra: Record<string, unknown> = {};
    if (str(p.parseMode)) extra.parse_mode = str(p.parseMode);
    if (str(p.replyToMessageId)) extra.reply_to_message_id = ctx.expr(str(p.replyToMessageId));
    if (str(p.messageThreadId)) extra.message_thread_id = ctx.expr(str(p.messageThreadId));
    if (p.disableNotification === true) extra.disable_notification = true;
    if (p.disableWebPagePreview === true) extra.disable_web_page_preview = true;
    if (str(p.replyMarkup)) ctx.note('Make sent a reply keyboard; build it under "Reply Markup" in n8n.', true);
    return {
      nodes: [n8nNode('telegram', ctx.step.label, { resource: 'message', operation: 'sendMessage', chatId: ctx.expr(str(p.chatId)), text: ctx.expr(str(p.text)), additionalFields: extra })],
      status: 'converted', credential: { app: 'Telegram', credentialType: 'telegramApi' }, ref: appRef('Telegram'),
    };
  },
});

register({
  source: 'make', key: 'telegram:WatchUpdates', label: 'Telegram Trigger',
  build(ctx) {
    ctx.note('Make received the bot\'s updates through its own webhook; the n8n trigger registers a new one when activated (one webhook per bot).');
    return {
      nodes: [n8nNode('telegramTrigger', ctx.step.label, { updates: ['message'], additionalFields: {} })],
      status: 'converted', credential: { app: 'Telegram', credentialType: 'telegramApi' }, ref: appRef('Telegram'),
    };
  },
});

register({
  source: 'make', key: 'discord:createMessage', label: 'Discord: Send Message',
  build(ctx) {
    const p = ctx.step.params;
    ctx.note('Pick the Discord server in the node; Make only needed the channel.', true);
    return {
      nodes: [n8nNode('discord', ctx.step.label, { authentication: 'botToken', resource: 'message', operation: 'send', guildId: rl('list', ''), sendTo: 'channel', channelId: rl('id', ctx.expr(str(p.channelId))), content: ctx.expr(str(p.content)), options: {} })],
      status: 'review', credential: { app: 'Discord', credentialType: 'discordBotApi' }, ref: appRef('Discord'),
    };
  },
});

// ---------- Airtable ----------

const AIRTABLE = { app: 'Airtable', credentialType: 'airtableTokenApi' };

function airtableColumns(record: unknown, ctx: MapCtx): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  let ids = false;
  for (const [k, v] of Object.entries(record && typeof record === 'object' ? (record as Record<string, unknown>) : {})) {
    if (v === '' || v === null || v === undefined) continue;
    if (/^fld[A-Za-z0-9]{14}$/.test(k)) ids = true;
    value[k] = ctx.expr(typeof v === 'string' ? v : JSON.stringify(v));
  }
  if (ids) ctx.note('Make addressed Airtable fields by id (fld…); n8n maps fields by name: rename them after picking the table.', true);
  return value;
}

const baseTable = (p: Record<string, unknown>, ctx: MapCtx) => ({ base: rl('id', ctx.expr(str(p.base))), table: rl('id', ctx.expr(str(p.table))) });

register({
  source: 'make', key: 'airtable:ActionCreateRecord', label: 'Airtable: Create',
  build(ctx) {
    const p = ctx.step.params;
    const record = p.record ?? p.fields ?? Object.fromEntries(Object.entries(p).filter(([k]) => !['base', 'table', 'typecast', 'useColumnId'].includes(k)));
    return {
      nodes: [n8nNode('airtable', ctx.step.label, { resource: 'record', operation: 'create', ...baseTable(p, ctx), columns: { mappingMode: 'defineBelow', value: airtableColumns(record, ctx), matchingColumns: [], schema: [] }, options: p.typecast === true ? { typecast: true } : {} })],
      status: 'converted', credential: AIRTABLE, ref: appRef('Airtable'),
    };
  },
});

register({
  source: 'make', key: 'airtable:ActionUpdateRecords', label: 'Airtable: Update',
  build(ctx) {
    const p = ctx.step.params;
    const record = p.record ?? Object.fromEntries(Object.entries(p).filter(([k]) => !['base', 'table', 'typecast', 'useColumnId', 'id'].includes(k)));
    return {
      nodes: [n8nNode('airtable', ctx.step.label, { resource: 'record', operation: 'update', ...baseTable(p, ctx), columns: { mappingMode: 'defineBelow', value: { id: ctx.expr(str(p.id)), ...airtableColumns(record, ctx) }, matchingColumns: ['id'], schema: [] }, options: p.typecast === true ? { typecast: true } : {} })],
      status: 'converted', credential: AIRTABLE, ref: appRef('Airtable'),
    };
  },
});

register({
  source: 'make', key: 'airtable:ActionSearchRecords', label: 'Airtable: Search',
  build(ctx) {
    const p = ctx.step.params;
    const params: Record<string, unknown> = { resource: 'record', operation: 'search', ...baseTable(p, ctx), filterByFormula: ctx.expr(str(p.formula)) };
    if (num(p.maxRecords)) Object.assign(params, { returnAll: false, limit: num(p.maxRecords) });
    params.options = str(p.view) ? { view: rl('id', str(p.view)) } : {};
    return { nodes: [n8nNode('airtable', ctx.step.label, params)], status: 'converted', credential: AIRTABLE, ref: appRef('Airtable') };
  },
});

register({
  source: 'make', key: 'airtable:ActionGetRecord', label: 'Airtable: Get',
  build(ctx) {
    const p = ctx.step.params;
    return { nodes: [n8nNode('airtable', ctx.step.label, { resource: 'record', operation: 'get', ...baseTable(p, ctx), id: ctx.expr(str(p.id ?? p.record)), options: {} })], status: 'converted', credential: AIRTABLE, ref: appRef('Airtable') };
  },
});

// ---------- data store, increment ----------

const DATA_TABLE_NOTE = 'Make data stores became an n8n Data Table (n8n ≥ 1.113): create the table with a "key" column and the same fields, then pick it here. The data itself is not migrated.';

register({
  source: 'make', key: 'datastore:AddRecord', label: 'Data Table: Insert Row',
  build(ctx) {
    const p = ctx.step.params;
    const data = p.data && typeof p.data === 'object' ? (p.data as Record<string, unknown>) : {};
    const value: Record<string, unknown> = { key: ctx.expr(str(p.key)) };
    for (const [k, v] of Object.entries(data)) value[k] = ctx.expr(typeof v === 'string' ? v : JSON.stringify(v));
    ctx.note(DATA_TABLE_NOTE, true);
    if (p.overwrite === true) ctx.note('Make overwrote an existing record with the same key; use the Data Table "Upsert" operation for that.', true);
    return { nodes: [n8nNode('dataTable', ctx.step.label, { resource: 'row', operation: 'insert', dataTableId: rl('list', ''), columns: { mappingMode: 'defineBelow', value, matchingColumns: [], schema: [] }, options: {} })], status: 'review' };
  },
});

register({
  source: 'make', key: 'datastore:GetRecord', label: 'Data Table: Get Rows',
  build(ctx) {
    ctx.note(DATA_TABLE_NOTE, true);
    return {
      nodes: [n8nNode('dataTable', ctx.step.label, { resource: 'row', operation: 'get', dataTableId: rl('list', ''), matchType: 'allConditions', filters: { conditions: [{ keyName: 'key', condition: 'eq', keyValue: ctx.expr(str(ctx.step.params.key)) }] }, returnAll: false, limit: 1 })],
      status: 'review',
    };
  },
});

register({
  source: 'make', key: 'util:FunctionIncrement', label: 'Code (counter)',
  build(ctx) {
    const perRun = ctx.step.params.reset === 'run' || ctx.step.params.reset === 'execution';
    const jsCode = perRun
      ? '// Counts the items of this run, like Make "Increment" reset after each run.\nreturn { json: { i: $itemIndex + 1 } };'
      : "// A counter kept between runs, like Make \"Increment\" that never resets.\nconst store = $getWorkflowStaticData('global');\nstore.counter = (store.counter ?? 0) + 1;\nreturn { json: { i: store.counter } };";
    if (!perRun) ctx.note('The counter lives in this workflow\'s static data: it counts only production runs (not tests).', true);
    return { nodes: [n8nNode('code', ctx.step.label, { mode: 'runOnceForEachItem', language: 'javaScript', jsCode })], status: perRun ? 'converted' : 'review' };
  },
});

// ---------- "Make an API call" of any app ----------

const API_BASES: Record<string, string> = {
  airtable: 'https://api.airtable.com', hubspotcrm: 'https://api.hubapi.com', notion: 'https://api.notion.com', slack: 'https://slack.com/api',
  shopify: 'https://REPLACE-ME.myshopify.com/admin/api/2024-10', trello: 'https://api.trello.com', asana: 'https://app.asana.com/api/1.0',
  pipedrive: 'https://api.pipedrive.com', mailchimp: 'https://REPLACE-ME.api.mailchimp.com/3.0', clickup: 'https://api.clickup.com/api/v2',
  monday: 'https://api.monday.com/v2', 'google-sheets': 'https://sheets.googleapis.com', 'google-drive': 'https://www.googleapis.com/drive/v3',
  'google-email': 'https://gmail.googleapis.com/gmail/v1', 'openai-gpt-3': 'https://api.openai.com', stripe: 'https://api.stripe.com',
  zoho: 'https://www.zohoapis.com', 'zoho-crm': 'https://www.zohoapis.com/crm/v2', github: 'https://api.github.com', calendly: 'https://api.calendly.com',
  telegram: 'https://api.telegram.org', discord: 'https://discord.com/api', typeform: 'https://api.typeform.com', apify: 'https://api.apify.com',
};

register({
  source: 'make', key: '*:makeApiCall', label: 'HTTP Request (the app\'s API)',
  build(ctx) {
    const p = ctx.step.params;
    const known = API_BASES[ctx.step.app] ?? findApp('make', ctx.step.app, false)?.apiBase;
    const path = str(p.url);
    const url = /^https?:\/\//.test(path) ? ctx.expr(path) : ctx.expr(`${known ?? 'https://REPLACE-ME.example'}${path.startsWith('/') ? '' : '/'}${path}`);
    const params: Record<string, unknown> = { method: httpMethod(p.method, ctx), url, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' };
    const headers = list<{ key?: unknown; name?: unknown; value?: unknown }>(p.headers).filter((h) => str(h.key ?? h.name)).map((h) => ({ name: str(h.key ?? h.name), value: ctx.expr(str(h.value)) }));
    if (headers.length) Object.assign(params, { sendHeaders: true, headerParameters: { parameters: headers } });
    const qs = list<{ key?: unknown; name?: unknown; value?: unknown }>(p.qs).filter((h) => str(h.key ?? h.name)).map((h) => ({ name: str(h.key ?? h.name), value: ctx.expr(str(h.value)) }));
    if (qs.length) Object.assign(params, { sendQuery: true, queryParameters: { parameters: qs } });
    if (str(p.body)) Object.assign(params, { sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: ctx.expr(str(p.body)) });
    params.options = {};
    const app = findApp('make', ctx.step.app, false)?.displayName ?? ctx.step.app;
    if (!known) {
      const suggestion = `Make called the ${app} API with its own connection. Set the API's base URL in this HTTP Request (placed here, disabled), add the API key or token as a credential, then enable it.`;
      return { nodes: [n8nNode('httpRequest', ctx.step.label, params, { disabled: true, note: suggestion })], status: 'manual', suggestion, placeholders: [{ field: 'url', value: 'https://REPLACE-ME.example' }] };
    }
    ctx.note(`Make called the ${app} API with its own connection; add the token as an n8n "Header Auth" credential (or switch Authentication to the predefined ${app} credential).`, true);
    return { nodes: [n8nNode('httpRequest', ctx.step.label, params)], status: 'review', credential: { app, credentialType: 'httpHeaderAuth' }, ref: appRef(app) };
  },
});
