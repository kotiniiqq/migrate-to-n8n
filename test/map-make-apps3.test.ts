import assert from 'node:assert/strict';
import { test } from 'node:test';

import { oneMake } from './helpers/one.ts';

const p = (n: { parameters: Record<string, unknown> }) => n.parameters as Record<string, any>;

test('app triggers: Gmail, Drive folder, Airtable, Typeform', () => {
  for (const key of ['google-email:TriggerNewEmail', 'google-email:triggerWatchNewEmails']) {
    const g = oneMake(key, { maxResults: 5, searchType: 'gmail', query: 'from:boss' }, { first: true });
    assert.equal(g.node.type, 'n8n-nodes-base.gmailTrigger');
    assert.equal(p(g.node).filters.q, 'from:boss');
  }
  const d = oneMake('google-drive:watchFilesInAFolder', { folder: '/1Folder', watch: 'created' }, { first: true });
  assert.equal(d.node.type, 'n8n-nodes-base.googleDriveTrigger');
  assert.equal(p(d.node).event, 'fileCreated');
  const a = oneMake('airtable:TriggerWatchRecords', { base: 'appX', table: 'tblY', config: { trigger: 'Created' } }, { first: true });
  assert.equal(a.node.type, 'n8n-nodes-base.airtableTrigger');
  assert.equal(a.step.status, 'review'); // the trigger field has to be picked
  const t = oneMake('typeform:WatchEventsWithResponses', { formId: 'abc' }, { first: true });
  assert.equal(t.node.type, 'n8n-nodes-base.typeformTrigger');
  assert.equal(p(t.node).formId, 'abc');
});

test('flow tools: repeater, filter module, HTML to text', () => {
  const r = oneMake('builtin:BasicRepeater', { start: '1', repeats: '{{1.n}}', step: '1' });
  assert.equal(r.node.type, 'n8n-nodes-base.code');
  assert.match(String(p(r.node).jsCode), /i: start \+ k \* step/);
  const h = oneMake('regexp:HTMLToText', { html: '{{1.body}}' });
  assert.equal(h.node.type, 'n8n-nodes-base.set');
  assert.match(JSON.stringify(h.node.parameters), /removeTags\(\)/);
});

test('OpenAI structured data and model response', () => {
  const s = oneMake('openai-gpt-3:transformTextToStructuredData', { model: 'gpt-4o', text: '{{1.t}}', prompt: 'Extract', parameters: [{ name: 'city', type: 'text', description: 'City' }] });
  assert.equal(s.node.type, '@n8n/n8n-nodes-langchain.openAi');
  assert.equal(s.step.status, 'review');
  const m = oneMake('openai-gpt-3:createModelResponse', { model: 'gpt-4.1', input: [{ role: 'user', content: 'Hi' }] });
  assert.equal(p(m.node).operation, 'response');
});

test('Gmail draft, old Gmail app, Drive share/move, Docs from template', () => {
  const dr = oneMake('google-email:createADraft', { to: ['a@b.c'], subject: 'S', content: 'Body', bodyType: 'rawHtml' });
  assert.equal(p(dr.node).resource, 'draft');
  const old = oneMake('gmail:ActionSendEmail', { to: ['a@b.c'], subject: 'S', html: 'B' });
  assert.equal(old.node.type, 'n8n-nodes-base.gmail');
  const sh = oneMake('google-drive:shareAFileFolder', { fileId: '/1f', role: 'reader', type: 'anyone' });
  assert.equal(p(sh.node).operation, 'share');
  assert.equal(p(sh.node).permissionsUi.permissionsValues.role, 'reader');
  const mv = oneMake('google-drive:moveAFileIntoAFolder', { file: '{{1.id}}', folderId: '/1F' });
  assert.equal(p(mv.node).operation, 'move');
  const tpl = oneMake('google-docs:createADocumentFromTemplate', { document: '/1Tpl', title: 'Copy', requests: { name: '{{1.n}}' } });
  assert.equal(tpl.step.status, 'review');
});

test('Supabase create, data store exists, downloads, Slack invite, LinkedIn, Resend, Apify finished run', () => {
  const sc = oneMake('supabase:createARow', { table: 'T', a: '1' });
  assert.equal(p(sc.node).operation, 'create');
  assert.equal(sc.step.status, 'converted');
  const ex = oneMake('datastore:ExistRecord', { key: '{{1.k}}' }, { parameters: { datastore: 1 } });
  assert.equal(p(ex.node).operation, 'rowExists');
  const dl = oneMake('http:DownloadFile', { url: '{{1.url}}' });
  assert.equal(p(dl.node).options.response.response.responseFormat, 'file');
  const tg = oneMake('telegram:DownloadFile', { fileId: '{{1.f}}' });
  assert.equal(p(tg.node).resource, 'file');
  const inv = oneMake('slack:InviteUsers', { channel: 'C1', users: ['U1', 'U2'] });
  assert.equal(p(inv.node).operation, 'invite');
  const li = oneMake('linkedin:CreatePost', { content: 'Hello', visibility: 'PUBLIC' });
  assert.equal(li.node.type, 'n8n-nodes-base.linkedIn');
  assert.equal(p(li.node).text, 'Hello');
  const rs = oneMake('resend:sendAnEmail', { from: 'a@b.c', to: ['x@y.z'], subject: 'S', html: 'B' });
  assert.equal(p(rs.node).url, 'https://api.resend.com/emails');
  const ap = oneMake('apify:finishedActorRuns', {}, { first: true });
  assert.equal(ap.node.type, 'n8n-nodes-base.webhook');
});
