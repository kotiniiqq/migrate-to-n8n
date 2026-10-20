import assert from 'node:assert/strict';
import { test } from 'node:test';

import { oneMake } from './helpers/one.ts';

const p = (n: { parameters: Record<string, unknown> }) => n.parameters as Record<string, any>;

test('Sheets add row with column headers: append, ids from Make, converted', () => {
  const r = oneMake('google-sheets:addRow', { mode: 'select', from: 'drive', spreadsheetId: '/1AbC', sheetId: 'Leads', includesHeaders: true, useColumnHeaders: true, valueInputOption: 'USER_ENTERED', values: { Name: '{{1.name}}', Email: '{{1.email}}' } });
  assert.equal(r.node.type, 'n8n-nodes-base.googleSheets');
  assert.equal(p(r.node).operation, 'append');
  assert.deepEqual(p(r.node).documentId, { __rl: true, mode: 'id', value: '1AbC' });
  assert.deepEqual(p(r.node).sheetName, { __rl: true, mode: 'name', value: 'Leads' });
  assert.equal(p(r.node).columns.mappingMode, 'defineBelow');
  assert.equal(p(r.node).columns.value.Email, "={{ $('Webhook').item.json.body.email }}");
  assert.equal(p(r.node).options.cellFormat, 'USER_ENTERED');
  assert.equal(r.step.status, 'converted');
  assert.equal(r.result.report.credentials[0].credentialType, 'googleSheetsOAuth2Api');
});

test('Sheets add row by column position: letters, flagged for review', () => {
  const r = oneMake('google-sheets:addRow', { mode: 'select', spreadsheetId: '/1AbC', sheetId: 'Leads', values: { 0: '{{1.name}}', 2: 'x' } });
  assert.deepEqual(Object.keys(p(r.node).columns.value), ['A', 'C']);
  assert.equal(r.step.status, 'review');
  assert.match(r.step.notes.join(' '), /header/);
});

test('Sheets add row by position, with the column labels Make kept: header names, converted', () => {
  const r = oneMake('google-sheets:addRow', { mode: 'select', spreadsheetId: '/1AbC', sheetId: 'Leads', values: { 0: '{{1.name}}' } }, { metadata: { expect: [{ name: 'values', spec: [{ name: '0', label: 'Full name (A)' }] }] } });
  assert.deepEqual(Object.keys(p(r.node).columns.value), ['Full name']);
  assert.equal(r.step.status, 'converted');
});

test('Sheets update row: matched on row_number', () => {
  const r = oneMake('google-sheets:updateRow', { mode: 'select', spreadsheetId: '1AbC', sheetId: 'Leads', rowNumber: '{{1.row}}', useColumnHeaders: true, values: { Status: 'done' } });
  assert.equal(p(r.node).operation, 'update');
  assert.deepEqual(p(r.node).columns.matchingColumns, ['row_number']);
  assert.equal(p(r.node).columns.value.row_number, "={{ $('Webhook').item.json.body.row }}");
  assert.equal(p(r.node).columns.value.Status, 'done');
});

test('Sheets search rows: read, then a Filter for the Make conditions; later steps get row_number', () => {
  const r = oneMake('google-sheets:filterRows', { spreadsheetId: '1AbC', sheetId: 'Leads', includesHeaders: true, filter: [[{ a: 'E', o: 'text:notequal', b: '' }]], limit: 10 }, { reader: '{{2.`__ROW_NUMBER__`}} {{2.`4`}}' });
  assert.equal(r.nodes[0].type, 'n8n-nodes-base.googleSheets');
  assert.equal(p(r.nodes[0]).operation, 'read');
  assert.equal(r.nodes[1].type, 'n8n-nodes-base.filter');
  assert.equal(r.node.type, 'n8n-nodes-base.limit'); // Make returned at most 10 rows
  assert.equal(r.step.status, 'review');
  assert.match(String(r.readerNode && JSON.stringify(r.readerNode.parameters)), /\.item\.json\.row_number/);
  assert.match(JSON.stringify(r.readerNode!.parameters), /\.item\.json\['E'\]/);
  assert.equal(r.readerStep!.status, 'review');
});

test('Sheets watch rows (first step) becomes the Google Sheets Trigger for new rows', () => {
  const r = oneMake('google-sheets:watchRows', { spreadsheetId: '1AbC', sheetId: 'Leads', includesHeaders: true, limit: 2 }, { first: true });
  assert.equal(r.node.type, 'n8n-nodes-base.googleSheetsTrigger');
  assert.equal(p(r.node).event, 'rowAdded');
  assert.equal(r.result.workflow.nodes[0].name, r.node.name); // nothing in front of a trigger
});

test('Sheets update one cell', () => {
  const r = oneMake('google-sheets:updateCell', { spreadsheetId: '1AbC', sheetId: 'Leads', cell: 'B{{1.row}}', value: '{{1.v}}' });
  assert.equal(r.node.type, 'n8n-nodes-base.httpRequest');
  assert.match(String(p(r.node).url), /sheets\.googleapis\.com\/v4\/spreadsheets\/1AbC\/values\//);
  assert.equal(p(r.node).nodeCredentialType, 'googleSheetsOAuth2Api');
});

test('Gmail send (new and old modules) → Gmail send', () => {
  const a = oneMake('google-email:sendAnEmail', { to: ['{{1.email}}', 'x@y.z'], subject: 'Hi', bodyType: 'rawHtml', content: '<b>{{1.name}}</b>' });
  assert.equal(a.node.type, 'n8n-nodes-base.gmail');
  assert.equal(p(a.node).operation, 'send');
  assert.equal(p(a.node).sendTo, "={{ $('Webhook').item.json.body.email }}, x@y.z");
  assert.equal(p(a.node).emailType, 'html');
  const b = oneMake('google-email:ActionSendEmail', { to: ['a@b.c'], subject: 'S', html: 'Body', cc: ['c@d.e'] });
  assert.equal(p(b.node).message, 'Body');
  assert.equal(p(b.node).options.ccList, 'c@d.e');
  const c = oneMake('google-email:sendAnEmail', { to: ['a@b.c'], subject: 'S', bodyType: 'collection', contents: [{ text: 'Line {{1.x}}' }] });
  assert.equal(p(c.node).emailType, 'text');
  assert.match(String(p(c.node).message), /Line/);
});

test('Drive upload and download, Docs create, Calendar create', () => {
  const up = oneMake('google-drive:uploadAFile', { select: 'value', title: '{{1.name}}.pdf', data: '{{1.data}}', folderId: '/1Folder' });
  assert.equal(up.node.type, 'n8n-nodes-base.googleDrive');
  assert.equal(p(up.node).operation, 'upload');
  assert.equal(up.step.status, 'review'); // binary data needs a check
  const get = oneMake('google-drive:getAFile', { select: 'map', file: '{{1.fileId}}' });
  assert.equal(p(get.node).operation, 'download');
  const doc = oneMake('google-docs:createADocument', { name: 'Report {{1.date}}', content: 'Text', folderId: '/1F' });
  assert.equal(doc.node.type, 'n8n-nodes-base.googleDocs');
  assert.equal(p(doc.node).title, "=Report {{ $('Webhook').item.json.body.date }}");
  const cal = oneMake('google-calendar:createAnEvent', { calendar: 'primary', summary: 'Call', start: '{{1.start}}', end: '{{1.end}}', description: 'D' });
  assert.equal(cal.node.type, 'n8n-nodes-base.googleCalendar');
  assert.equal(p(cal.node).operation, 'create');
  assert.equal(p(cal.node).start, "={{ $('Webhook').item.json.body.start }}");
  assert.equal(p(cal.node).additionalFields.summary, 'Call');
});
