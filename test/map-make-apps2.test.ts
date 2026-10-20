import assert from 'node:assert/strict';
import { test } from 'node:test';

import { oneMake } from './helpers/one.ts';

const p = (n: { parameters: Record<string, unknown> }) => n.parameters as Record<string, any>;
const W = "$('Webhook').item.json.body";

test('Claude simple prompt, OpenAI image', () => {
  const c = oneMake('anthropic-claude:simpleTextPrompt', { model: 'claude-opus-4-6', max_tokens: '1000', textPrompt: 'Hi {{1.n}}' });
  assert.equal(c.node.type, '@n8n/n8n-nodes-langchain.anthropic');
  assert.equal(p(c.node).messages.values[0].content, `=Hi {{ ${W}.n }}`);
  const i = oneMake('openai-gpt-3:GenerateImage', { model: 'dall-e-3', prompt: 'A cat', size: '1024x1024', quality: 'standard', style: 'vivid', response_format: 'url' });
  assert.equal(p(i.node).resource, 'image');
  assert.equal(p(i.node).operation, 'generate');
  assert.equal(p(i.node).prompt, 'A cat');
});

test('Tools: compose a string, Markdown to HTML, Make code, return data to a calling scenario', () => {
  const s = oneMake('util:ComposeTransformer', { value: 'Hi {{1.n}}' });
  assert.equal(s.node.type, 'n8n-nodes-base.set');
  assert.equal(s.step.status, 'converted');
  const m = oneMake('markdown:Compile', { data: '{{1.md}}', gfm: true, sanitize: false });
  assert.equal(m.node.type, 'n8n-nodes-base.markdown');
  assert.equal(p(m.node).mode, 'markdownToHtml');
  assert.equal(p(m.node).markdown, `={{ ${W}.md }}`);
  const code = oneMake('code:ExecuteCode', { language: 'javascript', inputFormat: 'list', input: [{ name: 'a', value: '{{1.a}}' }], codeEditorJavascript: 'return { b: input.a + 1 };' });
  assert.equal(code.node.type, 'n8n-nodes-base.code');
  assert.match(String(p(code.node).jsCode), /const input = \$json;/);
  assert.match(String(p(code.node).jsCode), /return \{ b: input\.a \+ 1 \};/);
  assert.equal(code.step.status, 'review');
  const ret = oneMake('scenario-service:ReturnData', { echo: '{{1.echo}}' });
  assert.equal(ret.node.type, 'n8n-nodes-base.set');
  assert.match(ret.step.notes.join(' '), /sub-workflow/i);
});

test('Twilio SMS, WhatsApp text', () => {
  const t = oneMake('twilio:SendSMS', { to: '{{1.phone}}', body: 'Hello', from: '+1555', fromType: 'phone' });
  assert.equal(t.node.type, 'n8n-nodes-base.twilio');
  assert.equal(p(t.node).message, 'Hello');
  const w = oneMake('whatsapp-business-cloud:sendMessage', { to: '{{1.phone}}', type: 'text', text: { body: 'Hola' }, fromId: '123' });
  assert.equal(w.node.type, 'n8n-nodes-base.whatsApp');
  assert.equal(p(w.node).operation, 'send');
  assert.equal(p(w.node).textBody, 'Hola');
});

test('RSS read and RSS trigger', () => {
  const r = oneMake('rss:ActionReadArticles', { url: '{{1.feed}}', maxResults: '10' });
  assert.equal(r.node.type, 'n8n-nodes-base.rssFeedRead');
  const t = oneMake('rss:TriggerNewArticle', { url: 'https://x.io/rss' }, { first: true });
  assert.equal(t.node.type, 'n8n-nodes-base.rssFeedReadTrigger');
  assert.equal(p(t.node).feedUrl, 'https://x.io/rss');
});

test('Drive search and new folder, Calendar search', () => {
  const s = oneMake('google-drive:searchForFilesFolders', { query: 'movements', searchType: 'title', limit: '10', select: 'list', folderId: '/' });
  assert.equal(p(s.node).resource, 'fileFolder');
  assert.equal(p(s.node).queryString, 'movements');
  const f = oneMake('google-drive:createAFolder', { name: 'New {{1.n}}', folderId: '1abc' });
  assert.equal(p(f.node).resource, 'folder');
  const c = oneMake('google-calendar:searchEvents', { calendar: 'primary', timeMin: '{{1.from}}', timeMax: '{{1.to}}', limit: '1' });
  assert.equal(p(c.node).operation, 'getAll');
  assert.equal(p(c.node).limit, 1);
});

test('Dropbox upload and share link', () => {
  const u = oneMake('dropbox:uploadLargeFile', { data: '{{1.file}}', path: '/Apps/x', filename: 'a.mp3', overwrite: false });
  assert.equal(u.node.type, 'n8n-nodes-base.dropbox');
  assert.equal(p(u.node).path, '/Apps/x/a.mp3');
  assert.equal(p(u.node).binaryData, true);
  const l = oneMake('dropbox:createShareLink', { path: '{{1.path}}', select: 'map', settings: { access: 'max' } });
  assert.equal(l.node.type, 'n8n-nodes-base.httpRequest');
  assert.equal(p(l.node).nodeCredentialType, 'dropboxApi');
});

test('Data store update and search, Supabase upsert and search, Notion page', () => {
  const u = oneMake('datastore:UpdateRecord', { key: '{{1.k}}', data: { n: '1' }, upsert: true }, { parameters: { datastore: 1 } });
  assert.equal(p(u.node).operation, 'upsert');
  const s = oneMake('datastore:SearchRecord', { filter: [[{ a: 'app', b: '{{1.app}}', o: 'text:equal' }]] }, { parameters: { datastore: 1 } });
  assert.equal(p(s.node).operation, 'get');
  assert.equal(p(s.node).filters.conditions[0].keyName, 'app');
  const su = oneMake('supabase:upsertARecord', { table: 'Final', status: 'DONE', request_id: '{{1.id}}' });
  assert.equal(su.node.type, 'n8n-nodes-base.supabase');
  assert.equal(p(su.node).tableId, 'Final');
  assert.equal(p(su.node).fieldsUi.fieldValues.length, 2);
  const ss = oneMake('supabase:searchRows', { table: 'Final', limit: '10', search: [[{ a: 'request_id', b: '{{1.id}}', o: 'text:eq.' }]] });
  assert.equal(p(ss.node).operation, 'getAll');
  assert.equal(p(ss.node).filters.conditions[0].condition, 'eq');
  const n = oneMake('notion:createAPage', { database: '1e4e', select: 'map', fields: '{{1.x}}' });
  assert.equal(n.node.type, 'n8n-nodes-base.notion');
  assert.equal(n.step.status, 'review');
});
