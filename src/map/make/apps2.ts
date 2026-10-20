/** More Make app modules: Claude prompts, images, tools, SMS/WhatsApp/RSS, Drive/Calendar search, Dropbox,
 *  data store updates, Supabase, Notion. */
import { randomUUID } from 'node:crypto';

import { n8nNode, register } from '../registry.ts';
import { appRef, rl, str } from '../shared.ts';

const num = (v: unknown): number | undefined => (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
const list = <T = Record<string, unknown>>(v: unknown): T[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as T[]) : []);
const AI_NOTE = 'n8n returns the answer in its own output shape: open the node once after a test run and adjust the fields later steps read.';
const DATA_TABLE_NOTE = 'Make data stores became an n8n Data Table (n8n ≥ 1.113): create the table with a "key" column and the same fields, then pick it here. The data itself is not migrated.';
const field = (name: string, value: unknown) => ({ id: randomUUID(), name, value, type: 'string' });

// ---------- AI ----------

register({
  source: 'make', key: 'anthropic-claude:simpleTextPrompt', label: 'Anthropic: Message a Model',
  build(ctx) {
    const p = ctx.step.params;
    const options: Record<string, unknown> = {};
    if (num(p.max_tokens) !== undefined) options.maxTokens = num(p.max_tokens);
    ctx.note(AI_NOTE);
    return {
      nodes: [n8nNode('anthropic', ctx.step.label, { resource: 'text', operation: 'message', modelId: rl('id', ctx.expr(str(p.model) || 'claude-3-5-haiku-latest')), messages: { values: [{ content: ctx.expr(str(p.textPrompt)), role: 'user' }] }, options })],
      status: 'converted', credential: { app: 'Anthropic', credentialType: 'anthropicApi' }, ref: appRef('Anthropic'),
    };
  },
});

register({
  source: 'make', key: 'openai-gpt-3:GenerateImage', label: 'OpenAI: Generate an Image',
  build(ctx) {
    const p = ctx.step.params;
    const model = ['dall-e-2', 'dall-e-3', 'gpt-image-1'].includes(str(p.model)) ? str(p.model) : 'dall-e-3';
    const options: Record<string, unknown> = {};
    if (str(p.size)) options.size = str(p.size);
    if (str(p.style)) options.style = str(p.style);
    if (p.response_format === 'url') options.returnImageUrls = true;
    if (str(p.quality) && model === 'dall-e-3') options.dalleQuality = str(p.quality) === 'hd' ? 'hd' : 'standard';
    ctx.note('Make returned the image URL (or file); n8n returns a binary image unless "Return Image URLs" is on.');
    return {
      nodes: [n8nNode('openAi', ctx.step.label, { resource: 'image', operation: 'generate', model, prompt: ctx.expr(str(p.prompt)), options })],
      status: 'converted', credential: { app: 'OpenAI', credentialType: 'openAiApi' }, ref: appRef('OpenAI'),
    };
  },
});

// ---------- tools ----------

register({
  source: 'make', key: 'util:ComposeTransformer', label: 'Edit Fields',
  build(ctx) {
    return { nodes: [n8nNode('set', ctx.step.label, { mode: 'manual', assignments: { assignments: [field('value', ctx.expr(str(ctx.step.params.value)))] }, includeOtherFields: true, options: {} })], status: 'converted' };
  },
});

register({
  source: 'make', key: 'markdown:Compile', label: 'Markdown → HTML',
  build(ctx) {
    return { nodes: [n8nNode('markdown', ctx.step.label, { mode: 'markdownToHtml', markdown: ctx.expr(str(ctx.step.params.data)), destinationKey: 'data', options: {} })], status: 'converted' };
  },
});

register({
  source: 'make', key: 'code:ExecuteCode', label: 'Code',
  build(ctx) {
    const p = ctx.step.params;
    const inputs = list<{ name?: unknown; value?: unknown }>(p.input).filter((i) => str(i.name)).map((i) => field(str(i.name), ctx.expr(str(i.value))));
    const setInputs = n8nNode('set', `${ctx.step.label} (inputs)`, { mode: 'manual', assignments: { assignments: inputs }, options: {} });
    if (str(p.language).toLowerCase() === 'python' || p.codeEditorPython) {
      const suggestion = 'Python from Make: n8n runs Python in the Code node but reads inputs differently. Replace `input` with the item (`_item["json"]` in n8n 2.x, `_input.item.json` in 1.x), return a dict, then enable it.';
      return {
        nodes: [setInputs, n8nNode('code', ctx.step.label, { mode: 'runOnceForEachItem', language: 'pythonNative', pythonCode: `# Make code (Python), copied as is.\ninput = {}\n${str(p.codeEditorPython)}` }, { disabled: true, note: suggestion })],
        status: 'manual', suggestion,
      };
    }
    const code = str(p.codeEditorJavascript);
    const jsCode = [
      '// Make code, wrapped: `input` holds the input fields; the returned object becomes the item.',
      'const input = $json;',
      'const result = await (async () => {',
      code.split('\n').map((l) => `  ${l}`).join('\n'),
      '})();',
      "return { json: result && typeof result === 'object' && !Array.isArray(result) ? result : { result } };",
    ].join('\n');
    if (list(p.dependencies).length) ctx.note('Make installed npm packages for this code; n8n allows external modules only when the instance enables them (NODE_FUNCTION_ALLOW_EXTERNAL).', true);
    ctx.note('Check the code once in n8n: the Make code sandbox and the n8n Code node differ in small ways.', true);
    return { nodes: [setInputs, n8nNode('code', ctx.step.label, { mode: 'runOnceForEachItem', language: 'javaScript', jsCode })], status: 'review' };
  },
});

register({
  source: 'make', key: 'scenario-service:ReturnData', label: 'Edit Fields (sub-workflow output)',
  build(ctx) {
    const fields = Object.entries(ctx.step.params).map(([name, v]) => field(name, ctx.expr(typeof v === 'string' ? v : JSON.stringify(v))));
    ctx.note('Make returned these values to the scenario that called this one. In n8n, call this workflow as a sub-workflow with "Execute Workflow"; the output of its last node is what the caller gets.');
    return { nodes: [n8nNode('set', ctx.step.label, { mode: 'manual', assignments: { assignments: fields }, options: {} })], status: 'converted' };
  },
});

// ---------- SMS, WhatsApp, RSS ----------

register({
  source: 'make', key: 'twilio:SendSMS', label: 'Twilio: Send SMS',
  build(ctx) {
    const p = ctx.step.params;
    if (p.fromType === 'messagingService' || p.messageService) ctx.note('Make sent through a Twilio Messaging Service; n8n needs the sender phone number.', true);
    return {
      nodes: [n8nNode('twilio', ctx.step.label, { resource: 'sms', operation: 'send', from: ctx.expr(str(p.from)), to: ctx.expr(str(p.to)), message: ctx.expr(str(p.body ?? p.messageBody)), options: {} })],
      status: p.from ? 'converted' : 'review', credential: { app: 'Twilio', credentialType: 'twilioApi' }, ref: appRef('Twilio'),
    };
  },
});

register({
  source: 'make', key: 'whatsapp-business-cloud:sendMessage', label: 'WhatsApp: Send Message',
  build(ctx) {
    const p = ctx.step.params;
    if (p.type && p.type !== 'text') ctx.note(`Make sent a "${str(p.type)}" message; set the same Message Type in n8n.`, true);
    ctx.note('Pick the sender phone number in the node.', true);
    const body = str((p.text as { body?: unknown })?.body ?? p.text);
    return {
      nodes: [n8nNode('whatsApp', ctx.step.label, { resource: 'message', operation: 'send', phoneNumberId: ctx.expr(str(p.fromId ?? p.phoneNumberId)), recipientPhoneNumber: ctx.expr(str(p.to)), messageType: 'text', textBody: ctx.expr(body), additionalFields: {} })],
      status: 'review', credential: { app: 'WhatsApp', credentialType: 'whatsAppApi' }, ref: appRef('WhatsApp'),
    };
  },
});

register({
  source: 'make', key: 'rss:ActionReadArticles', label: 'RSS Read',
  build(ctx) {
    const p = ctx.step.params;
    if (num(p.maxResults)) ctx.note(`Make read at most ${num(p.maxResults)} articles; add a Limit node if that matters.`);
    return { nodes: [n8nNode('rssFeedRead', ctx.step.label, { url: ctx.expr(str(p.url)), options: {} })], status: 'converted', ref: appRef('RSS Read') };
  },
});

register({
  source: 'make', key: 'rss:TriggerNewArticle', label: 'RSS Feed Trigger',
  build(ctx) {
    return { nodes: [n8nNode('rssFeedReadTrigger', ctx.step.label, { pollTimes: { item: [{ mode: 'everyMinute' }] }, feedUrl: ctx.expr(str(ctx.step.params.url)) })], status: 'converted', ref: appRef('RSS Feed Trigger') };
  },
});

// ---------- Drive search/folder, Calendar search ----------

const DRIVE = { app: 'Google Drive', credentialType: 'googleDriveOAuth2Api' };

register({
  source: 'make', key: 'google-drive:searchForFilesFolders', label: 'Google Drive: Search',
  build(ctx) {
    const p = ctx.step.params;
    const byQuery = p.searchType === 'query' || p.searchType === 'custom';
    const params: Record<string, unknown> = { resource: 'fileFolder', operation: 'search', searchMethod: byQuery ? 'query' : 'name', queryString: ctx.expr(str(p.query)) };
    if (num(p.limit)) Object.assign(params, { returnAll: false, limit: num(p.limit) });
    params.filter = {};
    params.options = {};
    if (str(p.folderId) && str(p.folderId) !== '/') ctx.note('Make searched inside one folder; set Filter → Folder in n8n.', true);
    return { nodes: [n8nNode('googleDrive', ctx.step.label, params)], status: 'converted', credential: DRIVE, ref: appRef('Google Drive') };
  },
});

register({
  source: 'make', key: 'google-drive:createAFolder', label: 'Google Drive: Create Folder',
  build(ctx) {
    const p = ctx.step.params;
    if (p.shared === true) ctx.note('Make also shared the folder; add a Google Drive "Share" step.', true);
    const parent = str(p.folderId).replace(/^\/+/, '');
    return {
      nodes: [n8nNode('googleDrive', ctx.step.label, { resource: 'folder', operation: 'create', name: ctx.expr(str(p.name)), driveId: rl('list', 'My Drive'), folderId: parent ? rl('id', ctx.expr(parent)) : rl('list', 'root'), options: {} })],
      status: 'converted', credential: DRIVE, ref: appRef('Google Drive'),
    };
  },
});

register({
  source: 'make', key: 'google-calendar:searchEvents', label: 'Google Calendar: Get Many Events',
  build(ctx) {
    const p = ctx.step.params;
    const params: Record<string, unknown> = { resource: 'event', operation: 'getAll', calendar: rl('id', ctx.expr(str(p.calendar) || 'primary')) };
    if (num(p.limit)) Object.assign(params, { returnAll: false, limit: num(p.limit) });
    if (str(p.timeMin)) params.timeMin = ctx.expr(str(p.timeMin));
    if (str(p.timeMax)) params.timeMax = ctx.expr(str(p.timeMax));
    params.options = p.singleEvents === true ? { singleEvents: true } : {};
    return { nodes: [n8nNode('googleCalendar', ctx.step.label, params)], status: 'converted', credential: { app: 'Google Calendar', credentialType: 'googleCalendarOAuth2Api' }, ref: appRef('Google Calendar') };
  },
});

// ---------- Dropbox ----------

register({
  source: 'make', key: 'dropbox:uploadLargeFile', label: 'Dropbox: Upload',
  build(ctx) {
    const p = ctx.step.params;
    const folder = str(p.path).replace(/\/+$/, '');
    ctx.note('n8n uploads the binary file of the incoming item (field "data"): make sure the step before passes the file as binary.', true);
    if (p.overwrite === true) ctx.note('Make overwrote an existing file; the n8n Dropbox upload adds a new file.', true);
    return {
      nodes: [n8nNode('dropbox', ctx.step.label, { authentication: 'accessToken', resource: 'file', operation: 'upload', path: ctx.expr(`${folder}/${str(p.filename)}`), binaryData: true, binaryPropertyName: 'data' })],
      status: 'review', credential: { app: 'Dropbox', credentialType: 'dropboxApi' }, ref: appRef('Dropbox'),
    };
  },
});

register({
  source: 'make', key: 'dropbox:createShareLink', label: 'HTTP Request (Dropbox API)',
  build(ctx) {
    const p = ctx.step.params;
    return {
      nodes: [n8nNode('httpRequest', ctx.step.label, {
        method: 'POST', url: 'https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', authentication: 'predefinedCredentialType', nodeCredentialType: 'dropboxApi',
        sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: `={{ JSON.stringify({ path: ${ctx.js(str(p.path))} }) }}`, options: {},
      })],
      status: 'converted', credential: { app: 'Dropbox', credentialType: 'dropboxApi' }, ref: appRef('Dropbox'),
    };
  },
});

// ---------- data store update/search, Supabase, Notion ----------

const TABLE_OPS: Record<string, string> = { 'text:equal': 'eq', 'number:equal': 'eq', 'text:notequal': 'neq', 'number:notequal': 'neq', 'number:greater': 'gt', 'number:less': 'lt', 'number:greaterorequal': 'gte', 'number:lessorequal': 'lte' };

register({
  source: 'make', key: 'datastore:UpdateRecord', label: 'Data Table: Update / Upsert',
  build(ctx) {
    const p = ctx.step.params;
    const value: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p.data && typeof p.data === 'object' ? (p.data as Record<string, unknown>) : {})) if (v !== '' && v !== null) value[k] = ctx.expr(typeof v === 'string' ? v : JSON.stringify(v));
    ctx.note(DATA_TABLE_NOTE, true);
    const upsert = p.upsert === true;
    return {
      nodes: [n8nNode('dataTable', ctx.step.label, {
        resource: 'row', operation: upsert ? 'upsert' : 'update', dataTableId: rl('list', ''), matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'key', condition: 'eq', keyValue: ctx.expr(str(p.key)) }] },
        columns: { mappingMode: 'defineBelow', value: upsert ? { key: ctx.expr(str(p.key)), ...value } : value, matchingColumns: [], schema: [] }, options: {},
      })],
      status: 'review',
    };
  },
});

register({
  source: 'make', key: 'datastore:SearchRecord', label: 'Data Table: Get Rows',
  build(ctx) {
    const p = ctx.step.params;
    const groups = Array.isArray(p.filter) ? (p.filter as Array<Array<{ a?: unknown; o?: unknown; b?: unknown }>>) : [];
    const conditions = groups.flat().filter((c) => c?.a !== undefined).map((c) => {
      const op = TABLE_OPS[str(c.o).replace(/:ci$/, '')];
      if (!op) ctx.note(`Condition "${str(c.o)}" on "${str(c.a)}" has no Data Table equivalent; it is set to "equals": check it.`, true);
      if (str(c.o).endsWith(':ci')) ctx.note(`Make compared "${str(c.a)}" ignoring case; Data Table filters are case-sensitive.`, true);
      return { keyName: str(c.a), condition: op ?? 'eq', keyValue: ctx.expr(str(c.b)) };
    });
    if (groups.length > 1) ctx.note('Make combined the filter groups with OR; this Data Table filter matches all conditions: split it if needed.', true);
    ctx.note(DATA_TABLE_NOTE, true);
    const params: Record<string, unknown> = { resource: 'row', operation: 'get', dataTableId: rl('list', ''), matchType: 'allConditions', filters: { conditions } };
    if (num(p.limit)) Object.assign(params, { returnAll: false, limit: num(p.limit) });
    else params.returnAll = true;
    return { nodes: [n8nNode('dataTable', ctx.step.label, params)], status: 'review' };
  },
});

const SUPABASE = { app: 'Supabase', credentialType: 'supabaseApi' };

register({
  source: 'make', key: 'supabase:upsertARecord', label: 'Supabase: Create Row',
  build(ctx) {
    const p = ctx.step.params;
    const fields = Object.entries(p).filter(([k, v]) => !['table', 'tableId', 'accountId'].includes(k) && v !== '' && v !== null)
      .map(([fieldId, v]) => ({ fieldId, fieldValue: ctx.expr(typeof v === 'string' ? v : JSON.stringify(v)) }));
    ctx.note('Make upserted (inserted or updated by the primary key); the n8n Supabase node creates rows: use "Update" for existing rows, or an HTTP Request with "Prefer: resolution=merge-duplicates".', true);
    return {
      nodes: [n8nNode('supabase', ctx.step.label, { resource: 'row', operation: 'create', tableId: str(p.table ?? p.tableId), dataToSend: 'defineBelow', fieldsUi: { fieldValues: fields } })],
      status: 'review', credential: SUPABASE, ref: appRef('Supabase'),
    };
  },
});

const SUPA_OPS: Record<string, string> = { eq: 'eq', neq: 'neq', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte', like: 'like', ilike: 'ilike', is: 'is' };

register({
  source: 'make', key: 'supabase:searchRows', label: 'Supabase: Get Many Rows',
  build(ctx) {
    const p = ctx.step.params;
    const raw = p.search ?? p.filter;
    const groups = Array.isArray(raw) ? (raw as Array<Array<{ a?: unknown; o?: unknown; b?: unknown }>>) : [];
    const conditions = groups.flat().filter((c) => c?.a !== undefined).map((c) => {
      const op = SUPA_OPS[str(c.o).replace(/^\w+:/, '').replace(/\.$/, '')];
      if (!op) ctx.note(`Supabase condition "${str(c.o)}" is set to "eq": check it.`, true);
      return { keyName: str(c.a), condition: op ?? 'eq', keyValue: ctx.expr(str(c.b)) };
    });
    if (groups.length > 1) ctx.note('Make combined filter groups with OR; set "Must Match" to "Any Filter" if each group has one condition.', true);
    const params: Record<string, unknown> = { resource: 'row', operation: 'getAll', tableId: str(p.table ?? p.tableId), filterType: conditions.length ? 'manual' : 'none' };
    if (conditions.length) Object.assign(params, { matchType: 'allFilters', filters: { conditions } });
    if (num(p.limit)) Object.assign(params, { returnAll: false, limit: num(p.limit) });
    return { nodes: [n8nNode('supabase', ctx.step.label, params)], status: 'converted', credential: SUPABASE, ref: appRef('Supabase') };
  },
});

register({
  source: 'make', key: 'notion:createAPage', label: 'Notion: Create Database Page',
  build(ctx) {
    const p = ctx.step.params;
    ctx.note('Make mapped the Notion properties with its own editor; in n8n add each property under "Properties" after picking the database.', true);
    return {
      nodes: [n8nNode('notion', ctx.step.label, { resource: 'databasePage', operation: 'create', databaseId: rl('id', ctx.expr(str(p.database ?? p.data_source))), title: '', simple: true, propertiesUi: {}, blockUi: {}, options: {} })],
      status: 'review', credential: { app: 'Notion', credentialType: 'notionApi' }, ref: appRef('Notion'),
    };
  },
});
