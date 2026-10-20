/** Make modules, third batch: app triggers, repeater, HTML to text, structured AI, Gmail drafts, Drive
 *  share/move, Docs templates, downloads, Slack invites, LinkedIn, Resend, Apify webhooks. */
import { randomUUID } from 'node:crypto';

import { findEntry, n8nNode, register } from '../registry.ts';
import { appRef, rl, str } from '../shared.ts';

const num = (v: unknown): number | undefined => (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
const id = (v: unknown) => str(v).replace(/^\/+/, '').split('/').pop() ?? '';
const POLL = { pollTimes: { item: [{ mode: 'everyMinute' }] } };
const DRIVE = { app: 'Google Drive', credentialType: 'googleDriveOAuth2Api' };

/** Same mapping as another key (old app slugs, aliases). */
function alias(key: string, target: string) {
  register({ source: 'make', key, label: findEntry('make', target)?.label ?? target, build: (ctx) => findEntry('make', target)!.build(ctx) });
}

// ---------- triggers ----------

for (const key of ['google-email:TriggerNewEmail', 'google-email:triggerWatchNewEmails', 'google-email:TriggerWatchEmails', 'gmail:TriggerNewEmail']) {
  register({
    source: 'make', key, label: 'Gmail Trigger',
    build(ctx) {
      const p = ctx.step.params;
      const filters: Record<string, unknown> = {};
      if (str(p.query ?? p.q)) filters.q = ctx.expr(str(p.query ?? p.q));
      if (str(p.sender ?? p.from)) filters.sender = ctx.expr(str(p.sender ?? p.from));
      if (p.markSeen === true) ctx.note('Make marked the emails as read; add a Gmail "Mark as Read" step.', true);
      return {
        nodes: [n8nNode('gmailTrigger', ctx.step.label, { ...POLL, event: 'messageReceived', simple: true, filters })],
        status: 'converted', credential: { app: 'Gmail', credentialType: 'gmailOAuth2' }, ref: appRef('Gmail Trigger'),
      };
    },
  });
}

register({
  source: 'make', key: 'google-drive:watchFilesInAFolder', label: 'Google Drive Trigger',
  build(ctx) {
    const p = ctx.step.params;
    const event = /modif|updat/i.test(str(p.watch)) ? 'fileUpdated' : 'fileCreated';
    return {
      nodes: [n8nNode('googleDriveTrigger', ctx.step.label, { ...POLL, triggerOn: 'specificFolder', folderToWatch: rl('id', ctx.expr(id(p.folder ?? p.folderId))), event, options: {} })],
      status: 'converted', credential: DRIVE, ref: appRef('Google Drive Trigger'),
    };
  },
});

register({
  source: 'make', key: 'airtable:TriggerWatchRecords', label: 'Airtable Trigger',
  build(ctx) {
    const p = ctx.step.params;
    ctx.note('n8n watches a "Created time" or "Last modified time" field: set Trigger Field to that field of the table.', true);
    return {
      nodes: [n8nNode('airtableTrigger', ctx.step.label, { ...POLL, authentication: 'airtableTokenApi', baseId: rl('id', ctx.expr(str(p.base))), tableId: rl('id', ctx.expr(str(p.table))), triggerField: '', additionalFields: {} })],
      status: 'review', credential: { app: 'Airtable', credentialType: 'airtableTokenApi' }, ref: appRef('Airtable Trigger'),
    };
  },
});

register({
  source: 'make', key: 'typeform:WatchEventsWithResponses', label: 'Typeform Trigger',
  build(ctx) {
    return {
      nodes: [n8nNode('typeformTrigger', ctx.step.label, { formId: ctx.expr(str(ctx.step.params.formId)), simplifyAnswers: true, onlyAnswers: true }, { webhookId: randomUUID() })],
      status: 'converted', credential: { app: 'Typeform', credentialType: 'typeformApi' }, ref: appRef('Typeform Trigger'),
    };
  },
});

register({
  source: 'make', key: 'apify:finishedActorRuns', label: 'Webhook (Apify)',
  build(ctx) {
    const path = `${ctx.slug || 'make'}-apify`;
    ctx.note('Make subscribed to finished Apify runs; in Apify add a webhook (Actor → Integrations → Webhook) pointing to this n8n URL.', true);
    return { nodes: [n8nNode('webhook', ctx.step.label, { httpMethod: 'POST', path, responseMode: 'onReceived', options: {} }, { webhookId: randomUUID() })], status: 'review', webhookPath: path, ref: appRef('Webhook') };
  },
});

// ---------- flow tools ----------

register({
  source: 'make', key: 'builtin:BasicRepeater', label: 'Code (repeat)',
  build(ctx) {
    const p = ctx.step.params;
    const jsCode = [
      '// Make "Repeater": one item per repetition, with i = start, start + step, ...',
      `const start = Number(${ctx.js(str(p.start ?? '1'))});`,
      `const repeats = Number(${ctx.js(str(p.repeats ?? '1'))});`,
      `const step = Number(${ctx.js(str(p.step ?? '1'))});`,
      'return Array.from({ length: repeats }, (_, k) => ({ json: { i: start + k * step } }));',
    ].join('\n');
    return { nodes: [n8nNode('code', ctx.step.label, { mode: 'runOnceForAllItems', language: 'javaScript', jsCode })], status: 'converted' };
  },
});

register({
  source: 'make', key: 'builtin:BasicFilter', label: 'No Operation',
  build(ctx) {
    return { nodes: [n8nNode('noOp', ctx.step.label, {})], status: 'converted' };
  },
});

register({
  source: 'make', key: 'regexp:HTMLToText', label: 'Edit Fields',
  build(ctx) {
    const value = `={{ String(${ctx.js(str(ctx.step.params.html))}).removeTags() }}`;
    return { nodes: [n8nNode('set', ctx.step.label, { mode: 'manual', assignments: { assignments: [{ id: randomUUID(), name: 'text', value, type: 'string' }] }, includeOtherFields: true, options: {} })], status: 'converted' };
  },
});

// ---------- AI ----------

register({
  source: 'make', key: 'openai-gpt-3:transformTextToStructuredData', label: 'OpenAI: Message a Model (JSON)',
  build(ctx) {
    const p = ctx.step.params;
    const fields = (Array.isArray(p.parameters) ? (p.parameters as Array<{ name?: unknown; description?: unknown }>) : []).map((f) => `- ${str(f.name)}: ${str(f.description)}`).join('\n');
    const prompt = `${str(p.prompt) || 'Extract the following fields'} Answer with a JSON object with these fields:\n${fields}\n\nText:\n${str(p.text)}`;
    ctx.note('Make returned the fields as structured data; here the model answers with JSON: parse it (Edit Fields → JSON) or turn on Options → Text Format → JSON Schema.', true);
    return {
      nodes: [n8nNode('openAi', ctx.step.label, { resource: 'text', operation: 'response', modelId: rl('id', ctx.expr(str(p.model) || 'gpt-4o-mini')), responses: { values: [{ type: 'text', role: 'user', content: ctx.expr(prompt) }] }, simplify: true, options: {} })],
      status: 'review', credential: { app: 'OpenAI', credentialType: 'openAiApi' }, ref: appRef('OpenAI'),
    };
  },
});

register({
  source: 'make', key: 'openai-gpt-3:createModelResponse', label: 'OpenAI: Message a Model',
  build(ctx) {
    const p = ctx.step.params;
    const input = Array.isArray(p.input) ? (p.input as Array<{ role?: unknown; content?: unknown }>) : [{ role: 'user', content: p.input }];
    const values = input.map((m) => ({ type: 'text', role: ['system', 'assistant', 'user'].includes(str(m.role)) ? str(m.role) : 'user', content: ctx.expr(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')) }));
    const options: Record<string, unknown> = {};
    if (str(p.instructions)) options.instructions = ctx.expr(str(p.instructions));
    if (num(p.max_output_tokens) !== undefined) options.maxTokens = num(p.max_output_tokens);
    ctx.note('n8n returns the answer in its own output shape: open the node once after a test run and adjust the fields later steps read.');
    return {
      nodes: [n8nNode('openAi', ctx.step.label, { resource: 'text', operation: 'response', modelId: rl('id', ctx.expr(str(p.model) || 'gpt-4o-mini')), responses: { values }, simplify: true, options })],
      status: 'converted', credential: { app: 'OpenAI', credentialType: 'openAiApi' }, ref: appRef('OpenAI'),
    };
  },
});

// ---------- Gmail draft, old Gmail app, Drive, Docs ----------

register({
  source: 'make', key: 'google-email:createADraft', label: 'Gmail: Create Draft',
  build(ctx) {
    const p = ctx.step.params;
    const html = p.bodyType !== 'collection' && !!str(p.content ?? p.html);
    const message = p.bodyType === 'collection' && Array.isArray(p.contents) ? (p.contents as Array<{ text?: unknown }>).map((c) => str(c?.text)).join('\n') : str(p.content ?? p.html ?? p.text);
    const to = Array.isArray(p.to) ? p.to.map(String).join(', ') : str(p.to);
    const options: Record<string, unknown> = {};
    if (to) options.sendTo = ctx.expr(to);
    return {
      nodes: [n8nNode('gmail', ctx.step.label, { resource: 'draft', operation: 'create', subject: ctx.expr(str(p.subject)), emailType: html ? 'html' : 'text', message: ctx.expr(message), options })],
      status: 'converted', credential: { app: 'Gmail', credentialType: 'gmailOAuth2' }, ref: appRef('Gmail'),
    };
  },
});

alias('gmail:ActionSendEmail', 'google-email:ActionSendEmail');
alias('gmail:sendAnEmail', 'google-email:sendAnEmail');

register({
  source: 'make', key: 'google-drive:shareAFileFolder', label: 'Google Drive: Share',
  build(ctx) {
    const p = ctx.step.params;
    const perm: Record<string, unknown> = { role: str(p.role) || 'reader', type: str(p.type) || 'anyone' };
    if (str(p.email ?? p.emailAddress)) perm.emailAddress = ctx.expr(str(p.email ?? p.emailAddress));
    if (str(p.domain)) perm.domain = ctx.expr(str(p.domain));
    return {
      nodes: [n8nNode('googleDrive', ctx.step.label, { resource: 'file', operation: 'share', fileId: rl('id', ctx.expr(id(p.fileId ?? p.file))), permissionsUi: { permissionsValues: perm }, options: {} })],
      status: 'converted', credential: DRIVE, ref: appRef('Google Drive'),
    };
  },
});

register({
  source: 'make', key: 'google-drive:moveAFileIntoAFolder', label: 'Google Drive: Move',
  build(ctx) {
    const p = ctx.step.params;
    return {
      nodes: [n8nNode('googleDrive', ctx.step.label, { resource: 'file', operation: 'move', fileId: rl('id', ctx.expr(id(p.file ?? p.fileId))), driveId: rl('list', 'My Drive'), folderId: rl('id', ctx.expr(id(p.folderId ?? p.folder))) })],
      status: 'converted', credential: DRIVE, ref: appRef('Google Drive'),
    };
  },
});

register({
  source: 'make', key: 'google-docs:createADocumentFromTemplate', label: 'Google Drive: Copy (template)',
  build(ctx) {
    const p = ctx.step.params;
    const tags = Object.keys(p.requests && typeof p.requests === 'object' ? (p.requests as Record<string, unknown>) : {});
    ctx.note(`Make copied the template and replaced its {{tags}}${tags.length ? ` (${tags.join(', ')})` : ''}; n8n copies it here: add a Google Docs "Update" step with "Replace Text" for each tag.`, true);
    return {
      nodes: [n8nNode('googleDrive', ctx.step.label, { resource: 'file', operation: 'copy', fileId: rl('id', ctx.expr(id(p.document ?? p.documentId))), name: ctx.expr(str(p.title ?? p.name)), sameFolder: true, options: {} })],
      status: 'review', credential: DRIVE, ref: appRef('Google Drive'),
    };
  },
});

// ---------- Supabase, data store, downloads, Slack, LinkedIn, Resend ----------

register({
  source: 'make', key: 'supabase:createARow', label: 'Supabase: Create Row',
  build(ctx) {
    const p = ctx.step.params;
    const fields = Object.entries(p).filter(([k, v]) => !['table', 'tableId', 'accountId'].includes(k) && v !== '' && v !== null)
      .map(([fieldId, v]) => ({ fieldId, fieldValue: ctx.expr(typeof v === 'string' ? v : JSON.stringify(v)) }));
    return {
      nodes: [n8nNode('supabase', ctx.step.label, { resource: 'row', operation: 'create', tableId: str(p.table ?? p.tableId), dataToSend: 'defineBelow', fieldsUi: { fieldValues: fields } })],
      status: 'converted', credential: { app: 'Supabase', credentialType: 'supabaseApi' }, ref: appRef('Supabase'),
    };
  },
});

register({
  source: 'make', key: 'datastore:ExistRecord', label: 'Data Table: If Row Exists',
  build(ctx) {
    ctx.note('Make data stores became an n8n Data Table (n8n ≥ 1.113): create the table with a "key" column, then pick it here. Make returned "exists: true/false"; n8n passes the item on only when the row exists (use "If Row Does Not Exist" for the other branch).', true);
    return {
      nodes: [n8nNode('dataTable', ctx.step.label, { resource: 'row', operation: 'rowExists', dataTableId: rl('list', ''), matchType: 'allConditions', filters: { conditions: [{ keyName: 'key', condition: 'eq', keyValue: ctx.expr(str(ctx.step.params.key)) }] } })],
      status: 'review',
    };
  },
});

register({
  source: 'make', key: 'http:DownloadFile', label: 'HTTP Request (file)',
  build(ctx) {
    return {
      nodes: [n8nNode('httpRequest', ctx.step.label, { method: 'GET', url: ctx.expr(str(ctx.step.params.url)), options: { response: { response: { responseFormat: 'file' } } } })],
      status: 'converted', ref: appRef('HTTP Request'),
    };
  },
});

register({
  source: 'make', key: 'telegram:DownloadFile', label: 'Telegram: Get File',
  build(ctx) {
    return {
      nodes: [n8nNode('telegram', ctx.step.label, { resource: 'file', operation: 'get', fileId: ctx.expr(str(ctx.step.params.fileId)), download: true, additionalFields: {} })],
      status: 'converted', credential: { app: 'Telegram', credentialType: 'telegramApi' }, ref: appRef('Telegram'),
    };
  },
});

register({
  source: 'make', key: 'slack:InviteUsers', label: 'Slack: Invite to Channel',
  build(ctx) {
    const p = ctx.step.params;
    const users = Array.isArray(p.users) ? p.users.map((u) => ctx.expr(String(u))) : [ctx.expr(str(p.users))];
    return {
      nodes: [n8nNode('slack', ctx.step.label, { resource: 'channel', operation: 'invite', channelId: rl('id', ctx.expr(str(p.channel))), userIds: users })],
      status: 'converted', credential: { app: 'Slack', credentialType: 'slackApi' }, ref: appRef('Slack'),
    };
  },
});

for (const [key, org, image] of [['linkedin:CreatePost', false, false], ['linkedin:ShareImage', false, true], ['linkedin:CreateCompanyImagePost', true, true], ['linkedin:CreateCompanyPost', true, false]] as const) {
  register({
    source: 'make', key, label: 'LinkedIn: Create Post',
    build(ctx) {
      const p = ctx.step.params;
      const params: Record<string, unknown> = { resource: 'post', operation: 'create', postAs: org ? 'organization' : 'person', text: ctx.expr(str(p.content ?? p.text ?? p.commentary)), shareMediaCategory: image ? 'IMAGE' : 'NONE' };
      if (org) params.organization = ctx.expr(str(p.organization ?? p.organizationId));
      else params.person = '';
      if (image) {
        params.binaryPropertyName = 'data';
        ctx.note('The image must arrive as binary data (field "data") from the step before.', true);
      }
      params.additionalFields = str(p.visibility) ? { visibility: str(p.visibility) === 'CONNECTIONS' ? 'CONNECTIONS' : 'PUBLIC' } : {};
      if (!org) ctx.note('Pick the LinkedIn person (your profile) in the node.', true);
      return { nodes: [n8nNode('linkedIn', ctx.step.label, params)], status: 'review', credential: { app: 'LinkedIn', credentialType: 'linkedInOAuth2Api' }, ref: appRef('LinkedIn') };
    },
  });
}

register({
  source: 'make', key: 'resend:sendAnEmail', label: 'HTTP Request (Resend API)',
  build(ctx) {
    const p = ctx.step.params;
    const to = Array.isArray(p.to) ? `[${p.to.map((x) => ctx.js(String(x))).join(', ')}]` : `[${ctx.js(str(p.to))}]`;
    const body = `={{ JSON.stringify({ from: ${ctx.js(str(p.from))}, to: ${to}, subject: ${ctx.js(str(p.subject))}, ${str(p.html) ? `html: ${ctx.js(str(p.html))}` : `text: ${ctx.js(str(p.text))}`} }) }}`;
    ctx.note('Add the Resend API key as an n8n "Header Auth" credential (Authorization: Bearer <key>).', true);
    return {
      nodes: [n8nNode('httpRequest', ctx.step.label, { method: 'POST', url: 'https://api.resend.com/emails', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: body, options: {} })],
      status: 'review', credential: { app: 'Resend', credentialType: 'httpHeaderAuth' }, ref: appRef('Resend'),
    };
  },
});
