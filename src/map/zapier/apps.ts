/** Zapier app steps: Gmail, Slack, Google Sheets, AI, Zapier Tables, Tally, Excel, HubSpot, Airtable, Notion,
 *  Telegram, Todoist, S3. Exports often carry no settings for app steps; those still get the right n8n node and
 *  operation, flagged for review. */
import { randomUUID } from 'node:crypto';

import { n8nNode, register, type MapCtx, type MapOutput } from '../registry.ts';
import { appRef, rl, str } from '../shared.ts';

const num = (v: unknown): number | undefined => (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => x !== '' && x !== null).map(String) : str(v) ? [str(v)] : []);
const isFirst = (ctx: MapCtx) => !ctx.graph.edges.some((e) => e.to === ctx.step.id);
const POLL = { pollTimes: { item: [{ mode: 'everyMinute' }] } };
const AI_NOTE = 'n8n returns the answer in its own output shape: open the node once after a test run and adjust the fields later steps read.';

/** Exports without the step's settings: still the right node, but the user has to fill it in. */
function needsSettings(ctx: MapCtx, keys: string[]): boolean {
  const p = ctx.step.params;
  const empty = !keys.some((k) => p[k] !== undefined && p[k] !== '' && p[k] !== null);
  if (empty) ctx.note('The export has no settings for this step (Zapier left them out): fill them in in the n8n node.', true);
  return empty;
}

const letterOf = (k: string) => /^COL\$([A-Z]{1,3})$/.exec(k)?.[1];

function columnsByLetter(p: Record<string, unknown>, ctx: MapCtx): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    const l = letterOf(k);
    if (!l || v === '' || v === null || (Array.isArray(v) && !v.length)) continue;
    value[l] = ctx.expr(Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'string' ? v : JSON.stringify(v));
  }
  if (Object.keys(value).length) ctx.note('Zapier wrote these columns by letter (A, B, C…); n8n writes by column header: open the node, pick the sheet and map each value to its header.', true);
  return value;
}

// ---------- Gmail ----------

for (const api of ['GoogleMailV2CLIAPI', 'GoogleMailCLIAPI', 'GmailV2API', 'GmailAPI']) {
  register({
    source: 'zapier', key: `${api}:message`, label: 'Gmail: Send (or Gmail Trigger as the first step)',
    build(ctx) {
      const p = ctx.step.params;
      if (isFirst(ctx)) {
        const filters: Record<string, unknown> = {};
        if (str(p.search_string ?? p.query)) filters.q = ctx.expr(str(p.search_string ?? p.query));
        const labels = list(p.label_ids);
        if (labels.length) filters.labelIds = labels;
        return { nodes: [n8nNode('gmailTrigger', ctx.step.label, { ...POLL, event: 'messageReceived', simple: true, filters })], status: 'converted', credential: { app: 'Gmail', credentialType: 'gmailOAuth2' }, ref: appRef('Gmail Trigger') };
      }
      const empty = needsSettings(ctx, ['to', 'subject', 'body']);
      const options: Record<string, unknown> = {};
      if (list(p.cc).length) options.ccList = ctx.expr(list(p.cc).join(', '));
      if (list(p.bcc).length) options.bccList = ctx.expr(list(p.bcc).join(', '));
      if (str(p.from_name)) options.senderName = ctx.expr(str(p.from_name));
      if (str(p.reply_to)) options.replyTo = ctx.expr(str(p.reply_to));
      if (p.file || p.attachment) ctx.note('Attachments become n8n binary data: add them under Options → Attachments.', true);
      return {
        nodes: [n8nNode('gmail', ctx.step.label, { resource: 'message', operation: 'send', sendTo: ctx.expr(list(p.to).join(', ')), subject: ctx.expr(str(p.subject)), emailType: p.body_type === 'html' ? 'html' : 'text', message: ctx.expr(str(p.body)), options })],
        status: empty ? 'review' : 'converted', credential: { app: 'Gmail', credentialType: 'gmailOAuth2' }, ref: appRef('Gmail'),
      };
    },
  });
}

// ---------- Slack ----------

function slackPost(ctx: MapCtx, toUser: boolean): MapOutput {
  const p = ctx.step.params;
  const empty = needsSettings(ctx, ['channel', 'text']);
  const channel = str(p.channel).trim();
  const params: Record<string, unknown> = { resource: 'message', operation: 'post', select: toUser ? 'user' : 'channel', messageType: 'text', text: ctx.expr(str(p.text)) };
  params[toUser ? 'user' : 'channelId'] = /^#/.test(channel) ? rl('name', channel.slice(1)) : rl('id', ctx.expr(channel));
  const other: Record<string, unknown> = {};
  if (str(p.thread_ts)) other.thread_ts = { replyValues: { thread_ts: ctx.expr(str(p.thread_ts)) } };
  if (p.link_names === 'yes' || p.link_names === true) other.link_names = true;
  if (p.unfurl === 'no' || p.unfurl === false) other.unfurl_links = false;
  params.otherOptions = other;
  if (str(p.username) || str(p.icon)) ctx.note('Zapier posted with a custom bot name/icon; set "Customize Bot" under Options in n8n.');
  return { nodes: [n8nNode('slack', ctx.step.label, params)], status: empty ? 'review' : 'converted', credential: { app: 'Slack', credentialType: 'slackApi' }, ref: appRef('Slack') };
}

for (const api of ['SlackCLIAPI', 'SlackAPI']) {
  register({
    source: 'zapier', key: `${api}:channel_message`, label: 'Slack: Send Message (or Slack Trigger as the first step)',
    build(ctx) {
      if (isFirst(ctx)) {
        const ch = str(ctx.step.params.channel);
        ctx.note('The Slack trigger needs a Slack app with event subscriptions pointing to n8n (see the node\'s instructions).', true);
        return {
          nodes: [n8nNode('slackTrigger', ctx.step.label, { trigger: ['message'], watchWorkspace: !ch, ...(ch ? { channelId: rl('id', ctx.expr(ch)) } : {}), options: {} }, { webhookId: randomUUID() })],
          status: 'review', credential: { app: 'Slack', credentialType: 'slackApi' }, ref: appRef('Slack Trigger'),
        };
      }
      return slackPost(ctx, false);
    },
  });
  register({ source: 'zapier', key: `${api}:direct_message`, label: 'Slack: Send Message (to a user)', build: (ctx) => slackPost(ctx, true) });
}

// ---------- Google Sheets, Excel ----------

for (const api of ['GoogleSheetsV2CLIAPI', 'GoogleSheetsV2API', 'GoogleSheetsCLIAPI', 'GoogleSheetsAPI']) {
  for (const action of ['add_row', 'add_rows']) {
    register({
      source: 'zapier', key: `${api}:${action}`, label: 'Google Sheets: Append Row',
      build(ctx) {
        const p = ctx.step.params;
        const empty = needsSettings(ctx, ['spreadsheet', 'worksheet']);
        const sheet = str(p.worksheet);
        return {
          nodes: [n8nNode('googleSheets', ctx.step.label, {
            resource: 'sheet', operation: 'append', documentId: rl('id', ctx.expr(str(p.spreadsheet))), sheetName: /^\d+$/.test(sheet) ? rl('id', sheet) : rl('name', ctx.expr(sheet)),
            columns: { mappingMode: 'defineBelow', value: columnsByLetter(p, ctx), matchingColumns: [], schema: [] }, options: {},
          })],
          status: empty || Object.keys(p).some((k) => letterOf(k)) ? 'review' : 'converted', credential: { app: 'Google Sheets', credentialType: 'googleSheetsOAuth2Api' }, ref: appRef('Google Sheets'),
        };
      },
    });
  }
}

for (const action of ['add_row', 'add_rows']) {
  register({
    source: 'zapier', key: `ExcelCLIAPI:${action}`, label: 'Microsoft Excel: Append to Table',
    build(ctx) {
      const p = ctx.step.params;
      needsSettings(ctx, ['workbook_id']);
      const values = columnsByLetter(p, ctx);
      ctx.note('n8n appends rows to an Excel table: pick the table, then map the columns by name.', true);
      return {
        nodes: [n8nNode('microsoftExcel', ctx.step.label, {
          resource: 'table', operation: 'append', workbook: rl('id', ctx.expr(str(p.workbook_id))), worksheet: rl('id', ctx.expr(str(p.worksheet_id))), table: rl('list', ''),
          dataMode: 'define', fieldsUi: { values: Object.entries(values).map(([column, fieldValue]) => ({ column, fieldValue })) }, options: {},
        })],
        status: 'review', credential: { app: 'Microsoft Excel', credentialType: 'microsoftExcelOAuth2Api' }, ref: appRef('Microsoft Excel'),
      };
    },
  });
}

// ---------- AI ----------

function openAiNode(ctx: MapCtx, model: string, messages: Array<{ role: string; content: unknown }>, options: Record<string, unknown> = {}): MapOutput {
  ctx.note(AI_NOTE);
  return {
    nodes: [n8nNode('openAi', ctx.step.label, { resource: 'text', operation: 'response', modelId: rl('id', model), responses: { values: messages.map((m) => ({ type: 'text', ...m })) }, simplify: true, options })],
    status: 'converted', credential: { app: 'OpenAI', credentialType: 'openAiApi' }, ref: appRef('OpenAI'),
  };
}

const temps = (p: Record<string, unknown>) => {
  const o: Record<string, unknown> = {};
  if (num(p.temperature) !== undefined) o.temperature = num(p.temperature);
  if (num(p.max_tokens) !== undefined) o.maxTokens = num(p.max_tokens);
  return o;
};

register({
  source: 'zapier', key: 'OpenAiCLIAPI:send_prompt', label: 'OpenAI: Message a Model',
  build(ctx) {
    const p = ctx.step.params;
    const model = /instruct|davinci|babbage/.test(str(p.model)) ? 'gpt-4o-mini' : str(p.model) || 'gpt-4o-mini';
    if (model !== str(p.model) && str(p.model)) ctx.note(`Zapier used ${str(p.model)}, which only completes text; n8n chats with ${model}: check the prompt.`, true);
    const out = openAiNode(ctx, model, [{ role: 'user', content: ctx.expr(str(p.prompt)) }], temps(p));
    return needsSettings(ctx, ['prompt']) ? { ...out, status: 'review' } : out;
  },
});

for (const action of ['chat_completion', 'chat_completion_memory', 'conversation']) {
  register({
    source: 'zapier', key: `ChatGPTCLIAPI:${action}`, label: 'OpenAI: Message a Model',
    build(ctx) {
      const p = ctx.step.params;
      const msgs: Array<{ role: string; content: unknown }> = [];
      if (str(p.system_message)) msgs.push({ role: 'system', content: ctx.expr(str(p.system_message)) });
      msgs.push({ role: 'user', content: ctx.expr(str(p.user_message ?? p.message)) });
      if (p.memory_key) ctx.note('Zapier kept a conversation memory; the n8n OpenAI node has "Conversation" options, or use an AI Agent with memory for that.', true);
      if (p.image) ctx.note('An image was sent along; add it as an image input in the node.', true);
      const out = openAiNode(ctx, str(p.model) || 'gpt-4o-mini', msgs, temps(p));
      return { ...out, status: p.memory_key || p.image || needsSettings(ctx, ['user_message', 'message']) ? 'review' : 'converted' };
    },
  });
}

register({
  source: 'zapier', key: 'AICLIAPI:get_completion', label: 'OpenAI: Message a Model',
  build(ctx) {
    const p = ctx.step.params;
    const raw = str(p.model_id);
    const model = raw.startsWith('openai/') ? raw.slice(7) : 'gpt-4o-mini';
    if (raw && !raw.startsWith('openai/')) ctx.note(`AI by Zapier used "${raw}"; n8n uses OpenAI ${model} here (Gemini and Anthropic have their own n8n nodes).`, true);
    const out = openAiNode(ctx, model, [{ role: 'user', content: ctx.expr(str(p.instructions)) }]);
    const schema = p.outputSchema ?? p.outputFields;
    if (schema) ctx.note('Zapier returned named output fields; ask for JSON (Options → Text Format) and parse it, or rename the fields later steps read.', true);
    return { ...out, status: schema || needsSettings(ctx, ['instructions']) ? 'review' : 'converted' };
  },
});

// ---------- Zapier Tables → Data Table, Tally ----------

const TABLES_NOTE = 'Zapier Tables became an n8n Data Table (n8n ≥ 1.113): create the table with the same fields (Zapier calls them f1, f2…; rename to yours), then pick it here. The data is not migrated.';

function tableFields(p: Record<string, unknown>, ctx: MapCtx) {
  const value: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    const m = /^new__data__(\w+)$/.exec(k);
    if (m && v !== '' && v !== null) value[m[1]] = ctx.expr(typeof v === 'string' ? v : JSON.stringify(v));
  }
  return value;
}

register({
  source: 'zapier', key: 'TableCLIAPI:create_record', label: 'Data Table: Insert Row',
  build(ctx) {
    ctx.note(TABLES_NOTE, true);
    return { nodes: [n8nNode('dataTable', ctx.step.label, { resource: 'row', operation: 'insert', dataTableId: rl('list', ''), columns: { mappingMode: 'defineBelow', value: tableFields(ctx.step.params, ctx), matchingColumns: [], schema: [] }, options: {} })], status: 'review' };
  },
});

register({
  source: 'zapier', key: 'TableCLIAPI:update_record', label: 'Data Table: Update Row',
  build(ctx) {
    ctx.note(TABLES_NOTE, true);
    return {
      nodes: [n8nNode('dataTable', ctx.step.label, {
        resource: 'row', operation: 'update', dataTableId: rl('list', ''), matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'id', condition: 'eq', keyValue: ctx.expr(str(ctx.step.params.record_id)) }] },
        columns: { mappingMode: 'defineBelow', value: tableFields(ctx.step.params, ctx), matchingColumns: [], schema: [] }, options: {},
      })],
      status: 'review',
    };
  },
});

register({
  source: 'zapier', key: 'TableCLIAPI:increment_value', label: 'Code (increment a Data Table value)',
  build(ctx) {
    const suggestion = 'Zapier Tables "increment" has no single n8n step: read the row (Data Table → Get), add the amount in Edit Fields, then update the row (Data Table → Update).';
    return { nodes: [n8nNode('dataTable', ctx.step.label, { resource: 'row', operation: 'get', dataTableId: rl('list', ''), matchType: 'allConditions', filters: { conditions: [{ keyName: 'id', condition: 'eq', keyValue: ctx.expr(str(ctx.step.params.record_id)) }] } }, { disabled: true, note: suggestion })], status: 'manual', suggestion };
  },
});

for (const action of ['updated_record', 'new_record', 'new_or_updated_record']) {
  register({
    source: 'zapier', key: `TableCLIAPI:${action}`, label: 'Schedule + Data Table (watch rows)',
    build(ctx) {
      const suggestion = 'Zapier watched a Table for changes; n8n Data Tables have no trigger: this step reads the table (the workflow runs on the Schedule in front of it). Filter for new or changed rows, e.g. by an "updated" column.';
      return { nodes: [n8nNode('dataTable', ctx.step.label, { resource: 'row', operation: 'get', dataTableId: rl('list', ''), returnAll: true })], status: 'review', notes: [suggestion] };
    },
  });
}

register({
  source: 'zapier', key: 'TallyCLIAPI:response', label: 'Webhook (Tally)',
  build(ctx) {
    const path = `${ctx.slug || 'zap'}-tally`;
    ctx.note('Tally sends submissions to a webhook: in Tally open the form → Integrations → Webhooks and paste this n8n URL. The answers arrive under body.data.fields.', true);
    return { nodes: [n8nNode('webhook', ctx.step.label, { httpMethod: 'POST', path, responseMode: 'onReceived', options: {} }, { webhookId: randomUUID() })], status: 'review', webhookPath: path, ref: appRef('Webhook (Tally)') };
  },
});

// ---------- HubSpot ----------

const HUBSPOT_FIELDS: Record<string, string> = {
  firstname: 'firstName', lastname: 'lastName', city: 'city', company: 'companyName', jobtitle: 'jobTitle', phone: 'phoneNumber',
  mobilephone: 'mobilePhoneNumber', website: 'websiteUrl', country: 'country', zip: 'postalCode', address: 'streetAddress',
  state: 'stateRegion', industry: 'industry', lifecyclestage: 'lifeCycleStage', hs_lead_status: 'leadStatus', hubspot_owner_id: 'contactOwner',
};

register({
  source: 'zapier', key: 'HubSpotCLIAPI:upsert_contact', label: 'HubSpot: Create or Update Contact',
  build(ctx) {
    const p = ctx.step.params;
    const empty = needsSettings(ctx, ['email']);
    const extra: Record<string, unknown> = {};
    const custom: Array<{ property: string; value: unknown }> = [];
    for (const [k, v] of Object.entries(p)) {
      if (k === 'email' || v === '' || v === null) continue;
      if (HUBSPOT_FIELDS[k]) extra[HUBSPOT_FIELDS[k]] = ctx.expr(str(v));
      else custom.push({ property: k, value: ctx.expr(str(v)) });
    }
    if (custom.length) {
      extra.customPropertiesUi = { customPropertiesValues: custom };
      ctx.note(`Custom properties (${custom.map((c) => c.property).join(', ')}) are set by their internal names; check them in the node.`, true);
    }
    return {
      nodes: [n8nNode('hubspot', ctx.step.label, { authentication: 'appToken', resource: 'contact', operation: 'upsert', email: ctx.expr(str(p.email)), additionalFields: extra, options: {} })],
      status: empty || custom.length ? 'review' : 'converted', credential: { app: 'HubSpot', credentialType: 'hubspotAppToken' }, ref: appRef('HubSpot'),
    };
  },
});

/** HubSpot actions the n8n node has no operation for: the HubSpot API with the n8n HubSpot credential. */
const HUBSPOT_API: Record<string, [string, string, string]> = {
  create_associations: ['PUT', '/crm/v4/objects/REPLACE-ME_from_type/REPLACE-ME_from_id/associations/default/REPLACE-ME_to_type/REPLACE-ME_to_id', 'Create an association between two records'],
  find_associations: ['GET', '/crm/v4/objects/REPLACE-ME_type/REPLACE-ME_id/associations/REPLACE-ME_to_type', 'Find the associations of a record'],
  deal_crmSearch: ['POST', '/crm/v3/objects/deals/search', 'Search deals'],
  company_crmSearch: ['POST', '/crm/v3/objects/companies/search', 'Search companies'],
  contact_crmSearch: ['POST', '/crm/v3/objects/contacts/search', 'Search contacts'],
  update_crm_deal: ['PATCH', '/crm/v3/objects/deals/REPLACE-ME_deal_id', 'Update a deal'],
  _zap_raw_request: ['GET', '/REPLACE-ME', 'API request'],
};

for (const [action, [method, path, what]] of Object.entries(HUBSPOT_API)) {
  register({
    source: 'zapier', key: `HubSpotCLIAPI:${action}`, label: `HTTP Request (HubSpot API: ${what})`,
    build(ctx) {
      const url = `https://api.hubapi.com${path}`;
      const params: Record<string, unknown> = { method, url, authentication: 'predefinedCredentialType', nodeCredentialType: 'hubspotAppToken' };
      if (method !== 'GET') Object.assign(params, { sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: action.endsWith('crmSearch') ? '{\n  "filterGroups": [{ "filters": [{ "propertyName": "REPLACE-ME", "operator": "EQ", "value": "REPLACE-ME" }] }]\n}' : '{\n  "properties": {}\n}' });
      params.options = {};
      ctx.note(`"${what}" goes through the HubSpot API with your n8n HubSpot credential: fill in the REPLACE-ME parts${Object.keys(ctx.step.params).length ? ' from the Zapier settings' : ''}.`, true);
      return { nodes: [n8nNode('httpRequest', ctx.step.label, params)], status: 'review', credential: { app: 'HubSpot', credentialType: 'hubspotAppToken' }, placeholders: [{ field: 'url', value: url }], ref: appRef('HubSpot') };
    },
  });
}

// ---------- Airtable, Notion, Telegram, Todoist, S3 ----------

function airtableFields(p: Record<string, unknown>, ctx: MapCtx) {
  const value: Record<string, unknown> = {};
  let ids = false;
  for (const [k, v] of Object.entries(p)) {
    const m = /^fields__(.+)$/.exec(k);
    if (!m || v === '' || v === null) continue;
    if (/^fld[A-Za-z0-9]{14}$/.test(m[1])) ids = true;
    value[m[1]] = ctx.expr(typeof v === 'string' ? v : JSON.stringify(v));
  }
  if (ids) ctx.note('Zapier addressed Airtable fields by id (fld…); n8n maps fields by name: rename them after picking the table.', true);
  return { value, ids };
}

for (const [action, op] of [['createRecord', 'create'], ['create_or_update_record', 'upsert'], ['updateRecord', 'update']] as const) {
  register({
    source: 'zapier', key: `AirtableCLIAPI:${action}`, label: `Airtable: ${op[0].toUpperCase()}${op.slice(1)}`,
    build(ctx) {
      const p = ctx.step.params;
      const empty = needsSettings(ctx, ['applicationId', 'tableName']);
      const { value, ids } = airtableFields(p, ctx);
      if (op === 'update') value.id = ctx.expr(str(p.rowId));
      if (op === 'upsert') ctx.note('Pick the field(s) to match existing records on ("Columns to match on").', true);
      return {
        nodes: [n8nNode('airtable', ctx.step.label, { resource: 'record', operation: op, base: rl('id', ctx.expr(str(p.applicationId))), table: rl('id', ctx.expr(str(p.tableName))), columns: { mappingMode: 'defineBelow', value, matchingColumns: op === 'update' ? ['id'] : [], schema: [] }, options: {} })],
        status: empty || ids || op === 'upsert' ? 'review' : 'converted', credential: { app: 'Airtable', credentialType: 'airtableTokenApi' }, ref: appRef('Airtable'),
      };
    },
  });
}

register({
  source: 'zapier', key: 'AirtableCLIAPI:newRecordInView', label: 'Airtable Trigger',
  build(ctx) {
    const p = ctx.step.params;
    ctx.note('n8n watches a "Created time" or "Last modified time" field: set Trigger Field to that field of the table.', true);
    return {
      nodes: [n8nNode('airtableTrigger', ctx.step.label, { ...POLL, authentication: 'airtableTokenApi', baseId: rl('id', ctx.expr(str(p.applicationId))), tableId: rl('id', ctx.expr(str(p.tableName))), triggerField: '', additionalFields: {} })],
      status: 'review', credential: { app: 'Airtable', credentialType: 'airtableTokenApi' }, ref: appRef('Airtable Trigger'),
    };
  },
});

register({
  source: 'zapier', key: 'NotionCLIAPI:create_database_item', label: 'Notion: Create Database Page',
  build(ctx) {
    ctx.note('Pick the Notion database and add each property under "Properties".', true);
    return {
      nodes: [n8nNode('notion', ctx.step.label, { resource: 'databasePage', operation: 'create', databaseId: rl('id', ctx.expr(str(ctx.step.params.datasource ?? ctx.step.params.database))), title: '', simple: true, propertiesUi: {}, blockUi: {}, options: {} })],
      status: 'review', credential: { app: 'Notion', credentialType: 'notionApi' }, ref: appRef('Notion'),
    };
  },
});

register({
  source: 'zapier', key: 'TelegramCLIAPI:send_message', label: 'Telegram: Send Message',
  build(ctx) {
    const p = ctx.step.params;
    const empty = needsSettings(ctx, ['chat_id', 'text']);
    const extra: Record<string, unknown> = {};
    if (['Markdown', 'MarkdownV2', 'HTML'].includes(str(p.parse_mode))) extra.parse_mode = str(p.parse_mode);
    if (p.disable_notification === true || p.disable_notification === 'yes') extra.disable_notification = true;
    return {
      nodes: [n8nNode('telegram', ctx.step.label, { resource: 'message', operation: 'sendMessage', chatId: ctx.expr(str(p.chat_id)), text: ctx.expr(str(p.text)), additionalFields: extra })],
      status: empty ? 'review' : 'converted', credential: { app: 'Telegram', credentialType: 'telegramApi' }, ref: appRef('Telegram'),
    };
  },
});

register({
  source: 'zapier', key: 'TodoistV2DevAPI:new_task', label: 'Todoist: Create Task',
  build(ctx) {
    const p = ctx.step.params;
    const empty = needsSettings(ctx, ['content']);
    const options: Record<string, unknown> = {};
    if (num(p.priority)) options.priority = num(p.priority);
    if (str(p.note)) ctx.note('Zapier added a note to the task; add a Todoist "Comment" step for it in n8n.', true);
    return {
      nodes: [n8nNode('todoist', ctx.step.label, { authentication: 'apiKey', resource: 'task', operation: 'create', project: rl('id', String(p.project_id ?? '')), content: ctx.expr(str(p.content)), options })],
      status: empty || str(p.note) ? 'review' : 'converted', credential: { app: 'Todoist', credentialType: 'todoistApi' }, ref: appRef('Todoist'),
    };
  },
});

register({
  source: 'zapier', key: 'S3API:file', label: 'AWS S3: Upload',
  build(ctx) {
    const p = ctx.step.params;
    ctx.note('n8n uploads the binary file of the incoming item (field "data"); set the bucket and file name.', true);
    return {
      nodes: [n8nNode('awsS3', ctx.step.label, { resource: 'file', operation: 'upload', bucketName: ctx.expr(str(p.bucket)), fileName: ctx.expr(str(p.key ?? p.filename)), binaryData: true, binaryPropertyName: 'data', additionalFields: {} })],
      status: 'review', credential: { app: 'AWS', credentialType: 'aws' }, ref: appRef('AWS S3'),
    };
  },
});
