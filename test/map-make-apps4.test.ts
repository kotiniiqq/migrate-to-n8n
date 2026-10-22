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

test('Numeric aggregator: sum, average, min, max and count of a value over the items', () => {
  const run = (fn: string, rows: unknown[]) => {
    const a = oneMake('util:FunctionAggregator2', { value: '{{1.amount}}' }, { parameters: { fn, feeder: 1 } });
    assert.deepEqual(a.nodes.map((n) => n.type), ['n8n-nodes-base.set', 'n8n-nodes-base.aggregate', 'n8n-nodes-base.set']);
    const value = String(p(a.node).assignments.assignments[0].value);
    return { result: new Function('$json', `return ${value.slice(4, -3)}`)({ rows }), status: a.step.status };
  };
  assert.deepEqual(run('sum', ['1', 2.5, '', null, 'x']), { result: 3.5, status: 'converted' });
  assert.equal(run('avg', [1, 2, 3]).result, 2);
  assert.equal(run('min', [4, '2', 9]).result, 2);
  assert.equal(run('max', [4, '2', 9]).result, 9);
  assert.equal(run('count', [4, '', 9]).result, 3);
  assert.equal(run('median', [1]).status, 'review');
});

test('Facebook page posts and Instagram photo and reel posts go through the Graph API', () => {
  const post = oneMake('facebook-pages:CreatePost', { page_id: '117', message: '{{1.text}}', link: '{{1.url}}' });
  assert.equal(post.node.type, 'n8n-nodes-base.facebookGraphApi');
  assert.equal(p(post.node).edge, 'feed');
  assert.deepEqual(p(post.node).options.queryParameters.parameter.map((q: any) => q.name), ['message', 'link']);
  assert.ok(post.node.credentials?.facebookGraphApi);

  const photo = oneMake('facebook-pages:CreatePostWithPhotos', { page_id: '117', message: 'Hi', photos: [{ url: '{{1.img}}', type: 'url' }, { url: 'b', type: 'url' }] });
  assert.equal(p(photo.node).edge, 'photos');
  assert.match(photo.step.notes.join(' '), /posts the first/);

  const ig = oneMake('instagram-business:CreatePostPhoto', { accountId: '1784', image_url: '{{1.img}}', caption: '{{1.text}}' });
  assert.deepEqual(ig.nodes.map((n) => p(n).edge), ['media', 'media_publish']);
  assert.equal(p(ig.nodes[1]).node, '1784');
  assert.equal(p(ig.nodes[1]).options.queryParameters.parameter[0].value, '={{ $json.id }}');
  for (const n of ig.nodes) assert.ok(n.credentials?.facebookGraphApi, `${n.name} has the credential`);
  assert.equal(ig.result.report.credentials[0].nodes.length, 2);

  const reel = oneMake('instagram-business:CreateAReelPost', { accountId: '1784', video_url: '{{1.video}}', caption: 'c', share_to_feed: true });
  assert.deepEqual(reel.nodes.map((n) => n.type), ['n8n-nodes-base.facebookGraphApi', 'n8n-nodes-base.wait', 'n8n-nodes-base.facebookGraphApi']);
  assert.equal(reel.nodes[1].credentials, undefined);
  assert.ok(p(reel.nodes[0]).options.queryParameters.parameter.some((q: any) => q.name === 'media_type' && q.value === 'REELS'));
});

test('Email trigger (IMAP): the start of the workflow, with Make\'s filters as IMAP search rules', () => {
  const e = oneMake('email:TriggerNewEmail', {}, { first: true, parameters: { folder: 'INBOX', criteria: 'ALL', from: 'nick@example.com', subject: 'New lead', to: '', text: '', markSeen: false, maxResults: 1 } });
  assert.equal(e.node.type, 'n8n-nodes-base.emailReadImap');
  assert.deepEqual(JSON.parse(p(e.node).options.customEmailConfig), ['ALL', ['FROM', 'nick@example.com'], ['SUBJECT', 'New lead']]);
  assert.equal(p(e.node).postProcessAction, 'nothing');
  assert.equal(e.result.workflow.nodes.filter((n) => /scheduleTrigger|manualTrigger/.test(n.type)).length, 0, 'no extra trigger in front of it');
  assert.equal(e.step.status, 'review'); // "ALL" may read older emails on the first run
  const unseen = oneMake('email:TriggerNewEmail', {}, { first: true, parameters: { folder: 'INBOX', criteria: 'UNSEEN', from: 'a@b.c' } });
  assert.equal(unseen.step.status, 'converted');
  const dyn = oneMake('email:TriggerNewEmail', {}, { first: true, parameters: { folder: 'INBOX', criteria: 'UNSEEN', from: '{{1.x}}', markSeen: true } });
  assert.equal(p(dyn.node).postProcessAction, 'read');
  assert.equal(dyn.step.status, 'review');
});

test('Webflow item update and publish, ManyChat custom field', () => {
  const w = oneMake('webflow:updateItem', { site_id: 's1', collection_id: 'c1', item_id: '{{1.id}}', select: 'list', fields: { name: '{{1.name}}', 'logo-url': '{{1.logo}}', empty: '' } });
  assert.equal(w.node.type, 'n8n-nodes-base.webflow');
  assert.deepEqual(p(w.node).fieldsUi.fieldValues.map((f: any) => f.fieldId), ['name', 'logo-url']);
  assert.equal(w.step.status, 'converted');
  const pub = oneMake('webflow:publishAnItem', { site_id: 's1', collection_id: 'c1', itemIds: '{{1.id}}' });
  assert.equal(p(pub.node).url, 'https://api.webflow.com/v2/collections/c1/items/publish');
  assert.match(String(p(pub.node).jsonBody), /itemIds: \[\]\.concat\(/);
  const m = oneMake('manychat:SetSubscriberCustomField', { cFieldId: 12587098, cFieldValue: '{{1.v}}', subscriberId: '{{1.sub}}' });
  assert.equal(p(m.node).url, 'https://api.manychat.com/fb/subscriber/setCustomField');
  assert.match(String(p(m.node).jsonBody), /field_id: Number\("12587098"\)/);
});
