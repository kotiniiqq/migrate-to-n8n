import assert from 'node:assert/strict';
import { test } from 'node:test';

import { oneMake } from './helpers/one.ts';

const p = (n: { parameters: Record<string, unknown> }) => n.parameters as Record<string, any>;
const W = "$('Webhook').item.json.body";

test('OpenAI chat completion → OpenAI node (Responses), messages, model, options; readers are flagged', () => {
  const r = oneMake('openai-gpt-3:CreateCompletion', { select: 'chat', model: 'gpt-4o-mini', max_tokens: '500', temperature: '0.2', response_format: 'json_object', messages: [{ role: 'system', content: 'Be brief' }, { role: 'user', content: '{{1.q}}' }] }, { reader: '{{2.choices[].message.content}}' });
  assert.equal(r.node.type, '@n8n/n8n-nodes-langchain.openAi');
  assert.equal(p(r.node).resource, 'text');
  assert.equal(p(r.node).operation, 'response');
  assert.deepEqual(p(r.node).modelId, { __rl: true, mode: 'id', value: 'gpt-4o-mini' });
  assert.deepEqual(p(r.node).responses.values[1], { type: 'text', role: 'user', content: `={{ ${W}.q }}` });
  assert.equal(p(r.node).options.maxTokens, 500);
  assert.equal(p(r.node).options.temperature, 0.2);
  assert.equal(r.readerStep!.status, 'review');
  assert.equal(r.result.report.credentials[0].credentialType, 'openAiApi');
});

test('Gemini and Claude → their n8n nodes', () => {
  const g = oneMake('gemini-ai:createACompletionGeminiPro', { model: 'gemini-1.5-flash', contents: [{ role: 'user', parts: [{ text: 'Hi {{1.name}}' }] }], system_instruction: { parts: [{ text: 'Sys' }] } });
  assert.equal(g.node.type, '@n8n/n8n-nodes-langchain.googleGemini');
  assert.deepEqual(p(g.node).modelId, { __rl: true, mode: 'id', value: 'models/gemini-1.5-flash' });
  assert.equal(p(g.node).messages.values[0].content, `=Hi {{ ${W}.name }}`);
  assert.equal(p(g.node).options.systemMessage, 'Sys');
  const c = oneMake('anthropic-claude:createAMessage', { model: 'claude-3-5-haiku-20241022', max_tokens: 500, system: 'S', messages: [{ role: 'user', content: 'Q' }] });
  assert.equal(c.node.type, '@n8n/n8n-nodes-langchain.anthropic');
  assert.equal(p(c.node).options.system, 'S');
});

test('Perplexity and Apify → ready HTTP requests to their APIs', () => {
  const px = oneMake('perplexity-ai:createAChatCompletion', { model: 'sonar', messages: [{ role: 'user', content: 'Q' }] });
  assert.equal(px.node.type, 'n8n-nodes-base.httpRequest');
  assert.equal(p(px.node).url, 'https://api.perplexity.ai/chat/completions');
  assert.equal(px.step.status, 'review');
  const ds = oneMake('apify:fetchDatasetItems', { datasetId: '{{1.ds}}', type: 'clean', format: 'json', limit: '100' });
  assert.match(String(p(ds.node).url), /api\.apify\.com\/v2\/datasets\/.*\/items/);
  const run = oneMake('apify:runActor', { actorId: 'abc', runSync: true, inputBody: '{"a": 1}' });
  assert.match(String(p(run.node).url), /acts\/abc\/run-sync-get-dataset-items/);
});

test('Email, Slack, Telegram, Discord', () => {
  const e = oneMake('email:ActionSendEmail', { to: ['{{1.email}}'], subject: 'S', contentType: 'html', html: '<p>Hi</p>', cc: [], from: '' });
  assert.equal(e.node.type, 'n8n-nodes-base.emailSend');
  assert.equal(p(e.node).toEmail, `={{ ${W}.email }}`);
  assert.equal(p(e.node).emailFormat, 'html');
  assert.equal(p(e.node).fromEmail, 'REPLACE-ME@example.com');
  const s = oneMake('slack:CreateMessage', { channel: 'C0123', channelType: 'public', channelWType: 'list', text: 'Hi {{1.name}}', mrkdwn: true });
  assert.equal(s.node.type, 'n8n-nodes-base.slack');
  assert.equal(p(s.node).select, 'channel');
  assert.deepEqual(p(s.node).channelId, { __rl: true, mode: 'id', value: 'C0123' });
  assert.equal(s.step.status, 'converted');
  const t = oneMake('telegram:SendReplyMessage', { chatId: '{{1.chat}}', text: 'Hi', parseMode: 'HTML', replyToMessageId: '' });
  assert.equal(t.node.type, 'n8n-nodes-base.telegram');
  assert.equal(p(t.node).operation, 'sendMessage');
  assert.equal(p(t.node).additionalFields.parse_mode, 'HTML');
  const tw = oneMake('telegram:WatchUpdates', {}, { first: true });
  assert.equal(tw.node.type, 'n8n-nodes-base.telegramTrigger');
  const d = oneMake('discord:createMessage', { select: 'channel', channelId: '128', content: 'Hey' });
  assert.equal(d.node.type, 'n8n-nodes-base.discord');
  assert.equal(p(d.node).operation, 'send');
  assert.equal(d.step.status, 'review'); // the server has to be picked
});

test('Airtable: create with field names converted, field ids flagged; update; search; get', () => {
  const byName = oneMake('airtable:ActionCreateRecord', { base: 'appX', table: 'tblY', record: { Name: '{{1.name}}' }, typecast: true });
  assert.equal(byName.node.type, 'n8n-nodes-base.airtable');
  assert.equal(p(byName.node).operation, 'create');
  assert.deepEqual(p(byName.node).base, { __rl: true, mode: 'id', value: 'appX' });
  assert.equal(p(byName.node).columns.value.Name, `={{ ${W}.name }}`);
  assert.equal(p(byName.node).options.typecast, true);
  assert.equal(byName.step.status, 'converted');
  const byId = oneMake('airtable:ActionCreateRecord', { base: 'appX', table: 'tblY', record: { fldAbc12345678901: 'x' } });
  assert.equal(byId.step.status, 'review');
  const upd = oneMake('airtable:ActionUpdateRecords', { base: 'appX', table: 'tblY', id: '{{1.rid}}', record: { Status: 'ok' } });
  assert.equal(p(upd.node).operation, 'update');
  assert.deepEqual(p(upd.node).columns.matchingColumns, ['id']);
  const s = oneMake('airtable:ActionSearchRecords', { base: 'appX', table: 'tblY', formula: '{Email} = "{{1.email}}"', maxRecords: '1' });
  assert.equal(p(s.node).operation, 'search');
  assert.match(String(p(s.node).filterByFormula), /\{Email\} = "\{\{ \$\('Webhook'\)/);
  const g = oneMake('airtable:ActionGetRecord', { base: 'appX', table: 'tblY', id: 'rec1' });
  assert.equal(p(g.node).operation, 'get');
  assert.equal(p(g.node).id, 'rec1');
});

test('HTTP: the new "Make a request" module and API-key requests', () => {
  const r = oneMake('http:MakeRequest', { url: 'https://x.io/a', method: 'post', headers: [{ name: 'A', value: '1' }], queryParameters: [{ name: 'q', value: '{{1.q}}' }], contentType: 'json', inputMethod: 'jsonString', jsonStringBodyContent: '{"a": "{{1.a}}"}' }, { parameters: { authenticationType: 'noAuth' }, reader: '{{2.data.id}}' });
  assert.equal(r.node.type, 'n8n-nodes-base.httpRequest');
  assert.equal(p(r.node).method, 'POST');
  assert.equal(p(r.node).specifyBody, 'json');
  assert.equal(p(r.node).queryParameters.parameters[0].value, `={{ ${W}.q }}`);
  assert.match(JSON.stringify(r.readerNode!.parameters), /\$\('HTTP request'\)\.item\.json\.id/);
  const k = oneMake('http:ActionSendDataAPIKeyAuth', { url: 'https://x.io', method: 'get', qs: [], headers: [] }, { parameters: { auth: 123 } });
  assert.equal(p(k.node).genericAuthType, 'httpHeaderAuth');
  assert.equal(k.result.report.credentials[0].credentialType, 'httpHeaderAuth');
});

test('"Make an API call" modules of any app → HTTP Request with the method, path, headers and body', () => {
  const known = oneMake('airtable:makeApiCall', { url: '/v0/appX/tblY', method: 'GET', headers: [{ key: 'X', value: '1' }] });
  assert.equal(known.node.type, 'n8n-nodes-base.httpRequest');
  assert.equal(p(known.node).url, 'https://api.airtable.com/v0/appX/tblY');
  assert.equal(known.step.status, 'review');
  const unknown = oneMake('sellsy:makeApiCall', { url: '/v2/contacts/search', method: 'POST', body: '{"a": 1}', headers: [] });
  assert.equal(unknown.node.disabled, true);
  assert.equal(p(unknown.node).url, 'https://REPLACE-ME.example/v2/contacts/search');
  assert.equal(unknown.step.status, 'manual');
  assert.match(unknown.step.suggestion!, /base URL/);
});

test('Data store and increment', () => {
  const add = oneMake('datastore:AddRecord', { key: '{{1.id}}', data: { Name: '{{1.name}}' }, overwrite: false }, { parameters: { datastore: 1 } });
  assert.equal(add.node.type, 'n8n-nodes-base.dataTable');
  assert.equal(p(add.node).operation, 'insert');
  assert.equal(p(add.node).columns.value.key, `={{ ${W}.id }}`);
  assert.equal(add.step.status, 'review');
  const get = oneMake('datastore:GetRecord', { key: '{{1.id}}' }, { parameters: { datastore: 1 } });
  assert.equal(p(get.node).operation, 'get');
  const inc = oneMake('util:FunctionIncrement', {}, { parameters: { reset: 'never' } });
  assert.equal(inc.node.type, 'n8n-nodes-base.code');
  assert.match(String(p(inc.node).jsCode), /getWorkflowStaticData/);
});

test('an HTTP method given by a formula stays an expression; an unknown method falls back to GET with a note', () => {
  const f = oneMake('onedrive:makeApiCall', { url: '/me', method: '{{1.METHOD}}' });
  assert.equal(p(f.node).method, `={{ String(${W}.METHOD).toUpperCase() }}`);
  const odd = oneMake('http:ActionSendData', { url: 'https://x.io', method: 'fetch' });
  assert.equal(p(odd.node).method, 'GET');
  assert.match(odd.step.notes.join(' '), /FETCH/);
});
