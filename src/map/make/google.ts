/** Make's Google modules: Sheets, Gmail, Drive, Docs, Calendar. */
import { nodeRef } from '../../util/names.ts';
import { conditionParameters, MAKE_OPS } from '../conditions.ts';
import { n8nNode, register, type MapCtx, type MapOutput } from '../registry.ts';
import { appRef, rl, str } from '../shared.ts';

// ---------- Sheets ----------

const SHEETS_CRED = { app: 'Google Sheets', credentialType: 'googleSheetsOAuth2Api' };

/** Make "/1AbC" (picked from Drive), a plain id, a URL or a formula → n8n resource locator. */
function documentId(v: unknown, ctx: MapCtx) {
  const s = str(v).trim();
  if (/^https?:\/\//.test(s)) return rl('url', s);
  if (s.includes('{{')) return rl('id', ctx.expr(s.replace(/^\//, '')));
  return rl('id', s.replace(/^\/+/, '').split('/').pop() ?? s);
}

const sheetName = (v: unknown, ctx: MapCtx) => rl('name', ctx.expr(str(v) || 'Sheet1'));

const letter = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : letter(Math.floor(i / 26) - 1) + letter(i % 26));
/** "Full name (A)" → "Full name" */
const header = (label: string) => label.replace(/\s*\([A-Z]{1,3}\)\s*$/, '').trim();

/** Make column keys → n8n header names. Positions (0, 1…) use Make's labels if the export kept them, else letters. */
function columns(values: unknown, ctx: MapCtx): { value: Record<string, unknown>; byPosition: boolean } {
  const labels = new Map((ctx.step.inputFields?.values ?? []).map((f) => [f.name, header(f.label)]));
  const value: Record<string, unknown> = {};
  let byPosition = false;
  for (const [k, v] of Object.entries(values && typeof values === 'object' ? (values as Record<string, unknown>) : {})) {
    if (v === '' || v === null || v === undefined) continue;
    let name = k;
    if (/^\d+$/.test(k)) {
      name = labels.get(k) || letter(Number(k));
      if (!labels.get(k)) byPosition = true;
    }
    value[name] = ctx.expr(typeof v === 'string' ? v : JSON.stringify(v));
  }
  if (byPosition) ctx.note('Make wrote these columns by position (A, B, C…); n8n writes by column header: open the node, pick the sheet and map each value to its header.', true);
  return { value, byPosition };
}

const resourceMapper = (value: Record<string, unknown>, matching: string[] = []) => ({ mappingMode: 'defineBelow', value, matchingColumns: matching, schema: [] });

/** Reading a row: `__ROW_NUMBER__` is n8n's `row_number`; Make's column positions become header names. */
function rowRef(ctx: MapCtx) {
  const labels = new Map((ctx.step.outputFields ?? []).map((f) => [f.name, header(f.label)]));
  return (out: string, first?: string): ReturnType<NonNullable<MapOutput['ref']>> => {
    const base = `${nodeRef(out)}.item.json`;
    if (first === '__ROW_NUMBER__') return { base: `${base}.row_number`, drop: 1 };
    if (first === '__IMTLENGTH__') return { base: `${nodeRef(out)}.all().length`, drop: 1 };
    if (first && /^\d+$/.test(first)) {
      const h = labels.get(first);
      if (h) return { base: `${base}[${JSON.stringify(h)}]`, drop: 1 };
      return { base: `${base}['${letter(Number(first))}']`, drop: 1, note: `Make read column ${letter(Number(first))} of "${ctx.step.label}" by position; n8n names columns by their header: replace ['${letter(Number(first))}'] with the header.` };
    }
    return undefined;
  };
}

const cellFormat = (v: unknown) => (v === 'RAW' || v === 'USER_ENTERED' ? { cellFormat: v } : {});

register({
  source: 'make', key: 'google-sheets:addRow', label: 'Google Sheets: Append Row',
  build(ctx) {
    const p = ctx.step.params;
    const { value } = columns(p.values, ctx);
    if (p.includesHeaders === false) ctx.note('The sheet has no header row in Make; n8n needs headers to map columns.', true);
    return {
      nodes: [n8nNode('googleSheets', ctx.step.label, {
        resource: 'sheet', operation: 'append', documentId: documentId(p.spreadsheetId, ctx), sheetName: sheetName(p.sheetId, ctx),
        columns: resourceMapper(value), options: cellFormat(p.valueInputOption),
      })],
      status: 'converted', credential: SHEETS_CRED, ref: appRef('Google Sheets'),
    };
  },
});

register({
  source: 'make', key: 'google-sheets:updateRow', label: 'Google Sheets: Update Row',
  build(ctx) {
    const p = ctx.step.params;
    const { value } = columns(p.values, ctx);
    return {
      nodes: [n8nNode('googleSheets', ctx.step.label, {
        resource: 'sheet', operation: 'update', documentId: documentId(p.spreadsheetId, ctx), sheetName: sheetName(p.sheetId, ctx),
        columns: resourceMapper({ row_number: ctx.expr(str(p.rowNumber)), ...value }, ['row_number']), options: cellFormat(p.valueInputOption),
      })],
      status: 'converted', credential: SHEETS_CRED, ref: appRef('Google Sheets'),
    };
  },
});

function readRows(key: string) {
  register({
    source: 'make', key, label: 'Google Sheets: Get Rows (+ Filter)',
    build(ctx) {
      const p = ctx.step.params;
      const filter = Array.isArray(p.filter) ? (p.filter as Array<Array<{ a?: unknown; o?: unknown; b?: unknown }>>) : [];
      // Make filters name a column by its letter: read it from the row the read step returns.
      const groups = filter.map((g) => (Array.isArray(g) ? g : []).filter((c) => c?.a !== undefined).map((c) => ({
        left: /^[A-Z]{1,3}$/.test(str(c.a)) ? `{{__row.${str(c.a)}}}` : str(c.a), op: str(c.o), right: c.b === undefined ? undefined : str(c.b),
      }))).filter((g) => g.length);
      const limit = str(p.limit).trim();
      const read = n8nNode('googleSheets', `${ctx.step.label} (read)`, {
        resource: 'sheet', operation: 'read', documentId: documentId(p.spreadsheetId, ctx), sheetName: sheetName(p.sheetId, ctx), options: {},
      });
      const nodes = [read];
      if (groups.length) {
        const letters = [...new Set(groups.flat().map((c) => /^\{\{__row\.([A-Z]+)\}\}$/.exec(c.left)?.[1]).filter(Boolean))];
        nodes.push(n8nNode('filter', `${ctx.step.label} (filter)`, conditionParameters(groups, MAKE_OPS, { ...ctx, expr: (v) => rowExpr(ctx.expr, v), js: (v) => rowJs(ctx.js, v) }, ctx.step.label)));
        if (letters.length) ctx.note(`Make filtered by column letter (${letters.join(', ')}); n8n rows are keyed by header: replace ['${letters[0]}'] in the Filter with the header name.`, true);
      }
      if (p.sortOrder === 'desc') ctx.note('Make returned the rows newest first; n8n reads top to bottom (add a Sort node if the order matters).', true);
      // Make returned at most `limit` rows (often 1, as a lookup); without it every match would flow on.
      if (limit && limit !== '0') {
        nodes.push(n8nNode('limit', ctx.step.label, { maxItems: /^\d+$/.test(limit) ? Number(limit) : ctx.expr(limit), keep: 'firstItems' }));
      }
      nodes[nodes.length - 1].wanted = ctx.step.label;
      return { nodes, status: 'converted', credential: SHEETS_CRED, ref: rowRef(ctx) };
    },
  });
}
readRows('google-sheets:filterRows');
readRows('google-sheets:searchRows');
readRows('google-sheets:searchRowsAdvanced');
readRows('google-sheets:getSheetContent');

/** `{{__row.E}}` → column E of the current item. */
const rowExpr = (expr: (v: unknown) => unknown, v: unknown) =>
  typeof v === 'string' && /^\{\{__row\.([A-Z]+)\}\}$/.test(v) ? `={{ $json['${v.slice(8, -2)}'] }}` : expr(v);
const rowJs = (js: (v: unknown) => string, v: unknown) =>
  typeof v === 'string' && /^\{\{__row\.([A-Z]+)\}\}$/.test(v) ? `$json['${v.slice(8, -2)}']` : js(v);

register({
  source: 'make', key: 'google-sheets:watchRows', label: 'Google Sheets Trigger (row added)',
  build(ctx) {
    const p = ctx.step.params;
    ctx.note('n8n checks the sheet for new rows every minute; change "Poll Times" if needed.');
    return {
      nodes: [n8nNode('googleSheetsTrigger', ctx.step.label, { pollTimes: { item: [{ mode: 'everyMinute' }] }, documentId: documentId(p.spreadsheetId, ctx), sheetName: sheetName(p.sheetId, ctx), event: 'rowAdded', options: {} })],
      status: 'converted', credential: { app: 'Google Sheets Trigger', credentialType: 'googleSheetsTriggerOAuth2Api' }, ref: rowRef(ctx),
    };
  },
});

function cellRequest(key: string, method: 'GET' | 'PUT') {
  register({
    source: 'make', key, label: `HTTP Request (Sheets API, ${method === 'GET' ? 'read' : 'write'} a cell)`,
    build(ctx) {
      const p = ctx.step.params;
      const id = documentId(p.spreadsheetId, ctx).value;
      const range = ctx.js(`${str(p.sheetId) || 'Sheet1'}!${str(p.cell)}`);
      const idJs = typeof id === 'string' && id.startsWith('=') ? id.replace(/^=\{\{ ?| ?\}\}$/g, '') : undefined;
      const prefix = idJs ? `'https://sheets.googleapis.com/v4/spreadsheets/' + ${idJs} + '/values/'` : `'https://sheets.googleapis.com/v4/spreadsheets/${String(id).replace(/'/g, '')}/values/'`;
      const url = `={{ ${prefix} + encodeURIComponent(${range})${method === 'PUT' ? " + '?valueInputOption=USER_ENTERED'" : ''} }}`;
      const params: Record<string, unknown> = { method, url, authentication: 'predefinedCredentialType', nodeCredentialType: 'googleSheetsOAuth2Api' };
      if (method === 'PUT') Object.assign(params, { sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: `={{ JSON.stringify({ values: [[${ctx.js(str(p.value))}]] }) }}` });
      params.options = {};
      return {
        nodes: [n8nNode('httpRequest', ctx.step.label, params)],
        status: 'converted', credential: SHEETS_CRED,
        ref: (out, first) => (first === 'value' ? { base: `${nodeRef(out)}.item.json.values?.[0]?.[0]`, drop: 1 } : undefined),
      };
    },
  });
}
cellRequest('google-sheets:updateCell', 'PUT');
cellRequest('google-sheets:getCell', 'GET');

register({
  source: 'make', key: 'google-sheets:deleteRow', label: 'Google Sheets: Delete Rows',
  build(ctx) {
    const p = ctx.step.params;
    return {
      nodes: [n8nNode('googleSheets', ctx.step.label, {
        resource: 'sheet', operation: 'delete', documentId: documentId(p.spreadsheetId, ctx), sheetName: sheetName(p.sheetId, ctx),
        toDelete: 'rows', startIndex: /^\d+$/.test(str(p.rowNumber)) ? Number(p.rowNumber) : ctx.expr(str(p.rowNumber)), numberToDelete: 1,
      })],
      status: 'converted', credential: SHEETS_CRED,
    };
  },
});

// ---------- Gmail ----------

const joinList = (v: unknown) => (Array.isArray(v) ? v.filter((x) => x !== '' && x !== null).map(String).join(', ') : str(v));

function gmailSend(key: string) {
  register({
    source: 'make', key, label: 'Gmail: Send',
    build(ctx) {
      const p = ctx.step.params;
      let message: unknown;
      let emailType = 'html';
      if (p.bodyType === 'collection' && Array.isArray(p.contents)) {
        message = ctx.expr((p.contents as Array<{ text?: unknown }>).map((c) => str(c?.text)).join('\n'));
        emailType = 'text';
      } else {
        message = ctx.expr(str(p.content ?? p.html ?? p.text ?? ''));
        if (p.text && !p.html && !p.content) emailType = 'text';
      }
      const options: Record<string, unknown> = {};
      if (joinList(p.cc)) options.ccList = ctx.expr(joinList(p.cc));
      if (joinList(p.bcc)) options.bccList = ctx.expr(joinList(p.bcc));
      if (str(p.replyTo)) options.replyTo = ctx.expr(str(p.replyTo));
      if (Array.isArray(p.attachments) && p.attachments.length) ctx.note('Attachments become n8n binary data: add them under Options → Attachments.', true);
      return {
        nodes: [n8nNode('gmail', ctx.step.label, { resource: 'message', operation: 'send', sendTo: ctx.expr(joinList(p.to)), subject: ctx.expr(str(p.subject)), emailType, message, options })],
        status: 'converted', credential: { app: 'Gmail', credentialType: 'gmailOAuth2' }, ref: appRef('Gmail'),
      };
    },
  });
}
gmailSend('google-email:sendAnEmail');
gmailSend('google-email:ActionSendEmail');

// ---------- Drive, Docs, Calendar ----------

register({
  source: 'make', key: 'google-drive:uploadAFile', label: 'Google Drive: Upload',
  build(ctx) {
    const p = ctx.step.params;
    ctx.note('n8n uploads the binary file of the incoming item (field "data"): make sure the step before passes the file as binary.', true);
    return {
      nodes: [n8nNode('googleDrive', ctx.step.label, {
        resource: 'file', operation: 'upload', name: ctx.expr(str(p.title ?? p.filename)), inputDataFieldName: 'data',
        driveId: rl('list', 'My Drive'), folderId: p.folderId ? rl('id', ctx.expr(str(p.folderId).replace(/^\/+/, '').split('/').pop() ?? '')) : rl('list', 'root'), options: {},
      })],
      status: 'review', credential: { app: 'Google Drive', credentialType: 'googleDriveOAuth2Api' }, ref: appRef('Google Drive'),
    };
  },
});

register({
  source: 'make', key: 'google-drive:getAFile', label: 'Google Drive: Download',
  build(ctx) {
    const p = ctx.step.params;
    const file = str(p.file ?? p.fileId).replace(/^\/+/, '');
    return {
      nodes: [n8nNode('googleDrive', ctx.step.label, { resource: 'file', operation: 'download', fileId: rl('id', ctx.expr(file.includes('{{') ? file : file.split('/').pop() ?? file)), options: {} })],
      status: 'converted', credential: { app: 'Google Drive', credentialType: 'googleDriveOAuth2Api' },
      ref: (out, first) => (first === 'data' ? { base: `${nodeRef(out)}.item.binary.data`, drop: 1, note: 'The file is binary data in n8n ($binary.data).' } : appRef('Google Drive')(out, first)),
    };
  },
});

register({
  source: 'make', key: 'google-docs:createADocument', label: 'Google Docs: Create',
  build(ctx) {
    const p = ctx.step.params;
    if (str(p.content)) ctx.note('n8n creates the document empty: add a Google Docs "Update" step to insert the text.', true);
    return {
      nodes: [n8nNode('googleDocs', ctx.step.label, { resource: 'document', operation: 'create', driveId: 'myDrive', folderId: str(p.folderId).replace(/^\/+/, '').split('/').pop() || 'default', title: ctx.expr(str(p.name ?? p.title)) })],
      status: str(p.content) ? 'review' : 'converted', credential: { app: 'Google Docs', credentialType: 'googleDocsOAuth2Api' }, ref: appRef('Google Docs'),
    };
  },
});

register({
  source: 'make', key: 'google-calendar:createAnEvent', label: 'Google Calendar: Create Event',
  build(ctx) {
    const p = ctx.step.params;
    const extra: Record<string, unknown> = {};
    for (const [from, to] of [['summary', 'summary'], ['description', 'description'], ['location', 'location']] as const) if (str(p[from])) extra[to] = ctx.expr(str(p[from]));
    if (p.allDayEvent === true) extra.allday = 'yes';
    if (Array.isArray(p.attendees) && p.attendees.length) ctx.note('Attendees: add them under Additional Fields → Attendees.', true);
    return {
      nodes: [n8nNode('googleCalendar', ctx.step.label, {
        resource: 'event', operation: 'create', calendar: rl('id', ctx.expr(str(p.calendar) || 'primary')),
        start: ctx.expr(str(p.start)), end: ctx.expr(str(p.end ?? p.start)), additionalFields: extra,
      })],
      status: 'converted', credential: { app: 'Google Calendar', credentialType: 'googleCalendarOAuth2Api' }, ref: appRef('Google Calendar'),
    };
  },
});
