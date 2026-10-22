import assert from 'node:assert/strict';
import { test } from 'node:test';

import { oneMake } from './helpers/one.ts';

const p = (n: { parameters: Record<string, unknown> }) => n.parameters as Record<string, any>;

test('Google: delete a calendar event, get a document, create a spreadsheet', () => {
  const c = oneMake('google-calendar:deleteAnEvent', { calendar: 'team@group.calendar.google.com', event: '{{1.id}}' });
  assert.equal(c.node.type, 'n8n-nodes-base.googleCalendar');
  assert.equal(p(c.node).operation, 'delete');
  assert.equal(p(c.node).calendar.value, 'team@group.calendar.google.com');
  assert.match(String(p(c.node).eventId), /\.id/);
  assert.equal(c.step.status, 'converted');

  const d = oneMake('google-docs:getADocument', { select: 'dropdown', document: '/1Folder/1DocId', includeTabsContent: false });
  assert.equal(p(d.node).operation, 'get');
  assert.equal(p(d.node).documentURL, '1DocId');

  const s = oneMake('google-sheets:createSpreadsheet', { properties: { title: '{{1.name}} sheet' }, sheets: [{ properties: { title: 'Leads' } }] });
  assert.equal(p(s.node).resource, 'spreadsheet');
  assert.equal(p(s.node).sheetsUi.sheetValues[0].title, 'Leads');
  assert.match(String(p(s.node).title), /name/);
});

test('Gmail draft (newer key) keeps cc and bcc; attachments ask for a check', () => {
  const g = oneMake('google-email:ActionCreateDraft', { to: ['a@x.com'], cc: ['b@x.com'], bcc: [], subject: 'Hi', html: '<p>Hello</p>', attachments: [] });
  assert.equal(p(g.node).resource, 'draft');
  assert.equal(p(g.node).emailType, 'html');
  assert.equal(p(g.node).options.sendTo, 'a@x.com');
  assert.equal(p(g.node).options.ccList, 'b@x.com');
  assert.equal(p(g.node).options.bccList, undefined);
  assert.equal(g.step.status, 'converted');
  const a = oneMake('google-email:ActionCreateDraft', { to: ['a@x.com'], subject: 'Hi', html: 'x', attachments: [{ data: '{{1.data}}', fileName: 'f.pdf' }] });
  assert.equal(a.step.status, 'review');
});

test('Notion update: named properties convert, ones keyed by internal id ask for a check', () => {
  const n = oneMake('notion:updateADatabaseItem', {
    select: 'map', page: '{{1.id}}',
    fields: [
      { key: 'Deal Name', type: 'title', value: '{{1.name}}' },
      { key: 'Amount', type: 'number', value: '{{1.amount}}' },
      { key: 'Stage', type: 'select', value: 'Won' },
      { key: 'Updated', type: 'date', date: { start: '{{1.updatedAt}}' } },
    ],
  });
  const values = p(n.node).propertiesUi.propertyValues;
  assert.deepEqual(values.map((v: any) => v.key), ['Deal Name|title', 'Amount|number', 'Stage|select', 'Updated|date']);
  assert.equal(values[2].selectValue, 'Won');
  assert.equal(n.step.status, 'converted');
  const byId = oneMake('notion:updateADatabaseItem', { select: 'map', page: '{{1.id}}', fields: { 'jFH%3F': 'Call Booked' } });
  assert.equal(byId.step.status, 'review');
  assert.match(byId.step.notes.join(' '), /internal id/);
});

test('data store delete and Sleep', () => {
  const d = oneMake('datastore:DeleteRecord', { key: '{{1.id}}' }, { parameters: { datastore: 1 } });
  assert.equal(p(d.node).operation, 'deleteRows');
  assert.equal(p(d.node).filters.conditions[0].keyName, 'key');
  const s = oneMake('util:Sleep', { delay: '30' });
  assert.equal(s.node.type, 'n8n-nodes-base.wait');
  assert.equal(p(s.node).amount, 30);
  assert.equal(s.step.status, 'converted');
});

test('XML parse: the text goes to a field, the XML node parses it', () => {
  const x = oneMake('xml:ParseXML', { xml: '{{1.body}}' }, { parameters: { type: '', preserveNumbersAsText: false } });
  assert.deepEqual(x.nodes.map((n) => n.type), ['n8n-nodes-base.set', 'n8n-nodes-base.xml']);
  assert.equal(p(x.node).dataPropertyName, 'xml');
  assert.equal(x.step.status, 'review');
});

test('CSV parse: one item per row, quotes and line breaks inside fields, own delimiter, no header row', () => {
  const run = (code: string) => new Function(code)().json.rows;
  const c = oneMake('csv:ParseCSV', { csv: 'name,city\n"Doe, Jane","Kyiv"\n"Say ""hi""","Line 1\nLine 2"\n\n' }, { parameters: { csvContainsHeaders: true, delimiterType: 'comma' } });
  assert.deepEqual(c.nodes.map((n) => n.type), ['n8n-nodes-base.code', 'n8n-nodes-base.splitOut']);
  assert.deepEqual(run(p(c.nodes[0]).jsCode), [{ name: 'Doe, Jane', city: 'Kyiv' }, { name: 'Say "hi"', city: 'Line 1\nLine 2' }]);
  assert.equal(c.step.status, 'converted');

  const semi = oneMake('csv:ParseCSV', { csv: 'a;b\r\n1;2' }, { parameters: { csvContainsHeaders: true, delimiterType: 'other', delimiter: ';' } });
  assert.deepEqual(run(p(semi.nodes[0]).jsCode), [{ a: '1', b: '2' }]);

  const bare = oneMake('csv:ParseCSV', { csv: 'x,y' }, { parameters: { csvContainsHeaders: false, delimiterType: 'comma' } });
  assert.deepEqual(run(p(bare.nodes[0]).jsCode), [{ 1: 'x', 2: 'y' }]);
  assert.equal(bare.step.status, 'review');
});

test('X post, Apify actor (newer key), Supabase record (newer key)', () => {
  const t = oneMake('twitter:createATweet', { text: '{{1.title}}', for_super_followers_only: false });
  assert.equal(t.node.type, 'n8n-nodes-base.twitter');
  assert.equal(t.node.typeVersion, 2);
  assert.equal(t.step.status, 'converted');

  const a = oneMake('apify:runActorNew', { actorId: 'Abc123', runSync: false, actor_search_type: 'user', inputBodyAbc123: '{"q": "{{1.q}}"}' });
  assert.match(String(p(a.node).url), /acts\/Abc123\/runs/);
  assert.match(String(p(a.node).jsonBody), /"q"/);

  const s = oneMake('supabase:ActionCreateARecord', { table: 'clients', data: { first_name: '{{1.first}}', status: 'Active' } });
  assert.equal(p(s.node).tableId, 'clients');
  assert.deepEqual(p(s.node).fieldsUi.fieldValues.map((f: any) => f.fieldId), ['first_name', 'status']);
});

test('OpenAI "ask anything", OpenRouter, Typeform responses, Sellsy API calls', () => {
  const o = oneMake('openai-gpt-3:askAnything', { model: 'gpt-5', textPrompt: 'Summarize {{1.text}}' }, { reader: '{{2.result}}' });
  assert.equal(o.node.type, '@n8n/n8n-nodes-langchain.openAi');
  assert.match(JSON.stringify(o.readerNode!.parameters), /output\[0\]\.content\[0\]\.text/);

  const r = oneMake('open-router:createAChatCompletion', { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'Hi {{1.name}}' }], temperature: '0.2', json_mode: true });
  assert.equal(p(r.node).url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.match(String(p(r.node).jsonBody), /temperature: 0\.2/);
  assert.match(String(p(r.node).jsonBody), /json_object/);

  const f = oneMake('typeform:ListResponses', { formId: 'VWG9z2uR', limit: '1', completed: true });
  assert.equal(p(f.node).url, 'https://api.typeform.com/forms/VWG9z2uR/responses?page_size=1&completed=true');

  const s = oneMake('sellsy:makeApiCall', { url: '/v2/contacts', method: 'GET' });
  assert.match(String(p(s.node).url), /^https:\/\/api\.sellsy\.com\/v2\/contacts/);
  assert.equal(s.step.status, 'review');
});
