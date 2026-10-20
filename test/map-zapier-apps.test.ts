import assert from 'node:assert/strict';
import { test } from 'node:test';

import { oneZap } from './helpers/one.ts';

const p = (n: { parameters: Record<string, unknown> }) => n.parameters as Record<string, any>;
const W = "$('Webhook').item.json.body";

test('Gmail: send, and a first step becomes the Gmail trigger', () => {
  const s = oneZap('GoogleMailV2CLIAPI', 'message', { to: ['{{1__email}}'], subject: 'Hi', body: 'Hello {{1__name}}', body_type: 'plain', cc: ['a@b.c'] });
  assert.equal(s.node.type, 'n8n-nodes-base.gmail');
  assert.equal(p(s.node).sendTo, `={{ ${W}.email }}`);
  assert.equal(p(s.node).emailType, 'text');
  assert.equal(p(s.node).options.ccList, 'a@b.c');
  assert.equal(s.step.status, 'converted');
  const t = oneZap('GoogleMailV2CLIAPI', 'message', { label_ids: ['INBOX'] }, { first: true });
  assert.equal(t.node.type, 'n8n-nodes-base.gmailTrigger');
  const empty = oneZap('GoogleMailV2CLIAPI', 'message', {});
  assert.equal(empty.step.status, 'review');
  assert.match(empty.step.notes.join(' '), /no settings/);
});

test('Slack: channel message, direct message, and the Slack trigger first', () => {
  const c = oneZap('SlackCLIAPI', 'channel_message', { channel: 'C08', text: '{{1__text}}', thread_ts: '{{1__ts}}' });
  assert.equal(c.node.type, 'n8n-nodes-base.slack');
  assert.deepEqual(p(c.node).channelId, { __rl: true, mode: 'id', value: 'C08' });
  const d = oneZap('SlackAPI', 'direct_message', { channel: 'UR89', text: 'Hi' });
  assert.equal(p(d.node).select, 'user');
  const t = oneZap('SlackAPI', 'channel_message', { channel: 'C1' }, { first: true });
  assert.equal(t.node.type, 'n8n-nodes-base.slackTrigger');
});

test('Google Sheets add row: columns by letter, flagged; worksheet by id', () => {
  const s = oneZap('GoogleSheetsV2CLIAPI', 'add_row', { spreadsheet: '1yf', worksheet: '0', 'COL$A': '{{1__a}}', 'COL$C': 'x' });
  assert.equal(p(s.node).operation, 'append');
  assert.deepEqual(Object.keys(p(s.node).columns.value), ['A', 'C']);
  assert.deepEqual(p(s.node).sheetName, { __rl: true, mode: 'id', value: '0' });
  assert.equal(s.step.status, 'review');
});

test('AI: OpenAI prompt, AI by Zapier, ChatGPT with memory', () => {
  const o = oneZap('OpenAiCLIAPI', 'send_prompt', { model: 'gpt-3.5-turbo-instruct', prompt: 'Q {{1__q}}', temperature: '0.7' });
  assert.equal(o.node.type, '@n8n/n8n-nodes-langchain.openAi');
  assert.equal(p(o.node).responses.values[0].content, `=Q {{ ${W}.q }}`);
  const a = oneZap('AICLIAPI', 'get_completion', { model_id: 'openai/gpt-4.1', instructions: 'Do it' });
  assert.deepEqual(p(a.node).modelId, { __rl: true, mode: 'id', value: 'gpt-4.1' });
  const c = oneZap('ChatGPTCLIAPI', 'chat_completion_memory', { model: 'gpt-3.5-turbo', system_message: 'Be nice', user_message: '{{1__m}}', memory_key: 'k' });
  assert.equal(p(c.node).responses.values[0].role, 'system');
  assert.equal(c.step.status, 'review');
});

test('Zapier Tables → Data Table; Tally → webhook; Webhooks (other spelling) → HTTP', () => {
  const t = oneZap('TableCLIAPI', 'create_record', { table_id: 'T1', new__data__f1: '{{1__a}}' });
  assert.equal(t.node.type, 'n8n-nodes-base.dataTable');
  assert.equal(p(t.node).columns.value.f1, `={{ ${W}.a }}`);
  const tally = oneZap('TallyCLIAPI', 'response', {}, { first: true });
  assert.equal(tally.node.type, 'n8n-nodes-base.webhook');
  const w = oneZap('WebhooksCLIAPI', 'custom_request', { method: 'POST', url: 'https://x.io', headers: 'Content-Type: application/json\nX-Key: 1', payload_type: 'json', data: '{"a": 1}' });
  assert.equal(w.node.type, 'n8n-nodes-base.httpRequest');
  assert.deepEqual(p(w.node).headerParameters.parameters.map((h: any) => h.name), ['Content-Type', 'X-Key']);
});

test('Excel add row, HubSpot, Airtable, Notion, Telegram, Todoist, S3', () => {
  const x = oneZap('ExcelCLIAPI', 'add_row', { workbook_id: 'W1', worksheet_id: '{0000}', 'COL$A': '{{1__a}}' });
  assert.equal(x.node.type, 'n8n-nodes-base.microsoftExcel');
  const hc = oneZap('HubSpotCLIAPI', 'upsert_contact', { email: '{{1__email}}', firstname: 'A', city: 'Kyiv' });
  assert.equal(p(hc.node).operation, 'upsert');
  assert.equal(p(hc.node).additionalFields.firstName, 'A');
  const ha = oneZap('HubSpotCLIAPI', 'create_associations', {});
  assert.equal(ha.node.type, 'n8n-nodes-base.httpRequest');
  assert.equal(p(ha.node).nodeCredentialType, 'hubspotAppToken');
  const ac = oneZap('AirtableCLIAPI', 'createRecord', { applicationId: 'appX', tableName: 'tblY', fields__Name: '{{1__n}}' });
  assert.equal(p(ac.node).operation, 'create');
  assert.equal(p(ac.node).columns.value.Name, `={{ ${W}.n }}`);
  const n = oneZap('NotionCLIAPI', 'create_database_item', {});
  assert.equal(n.node.type, 'n8n-nodes-base.notion');
  const tg = oneZap('TelegramCLIAPI', 'send_message', { chat_id: '1', text: 'Hi', parse_mode: 'Markdown' });
  assert.equal(p(tg.node).additionalFields.parse_mode, 'Markdown');
  const td = oneZap('TodoistV2DevAPI', 'new_task', { content: 'Do {{1__x}}', project_id: 377, priority: '1' });
  assert.equal(td.node.type, 'n8n-nodes-base.todoist');
  const s3 = oneZap('S3API', 'file', {});
  assert.equal(s3.node.type, 'n8n-nodes-base.awsS3');
});
