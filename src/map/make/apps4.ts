/** Make modules, fourth batch (0.2): the most used ones the corpus still left manual. Calendar delete, Docs get,
 *  Sheets create, Notion update, data store delete, Sleep, XML and CSV parsing, X posts, and newer keys of
 *  modules we already convert (Apify, Supabase, Gmail drafts). */
import { randomUUID } from 'node:crypto';

import { nodeRef } from '../../util/names.ts';
import { findEntry, n8nNode, register, type MapCtx } from '../registry.ts';
import { appRef, rl, str } from '../shared.ts';

const num = (v: unknown): number | undefined => (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
const id = (v: unknown) => str(v).replace(/^\/+/, '').split('/').pop() ?? '';
const numberOr = (v: unknown, ctx: MapCtx): unknown => (/^\s*-?\d+(\.\d+)?\s*$/.test(str(v)) ? Number(v) : ctx.expr(str(v)));
const DATA_TABLE_NOTE = 'Make data stores became an n8n Data Table (n8n ≥ 1.113): create the table with a "key" column and the same fields, then pick it here. The data itself is not migrated.';

/** Build with another entry's mapping, after renaming the parameters this key stores differently. */
function via(target: string, ctx: MapCtx, params: Record<string, unknown>) {
  return findEntry('make', target)!.build({ ...ctx, step: { ...ctx.step, params } });
}

// ---------- Google ----------

register({
  source: 'make', key: 'google-calendar:deleteAnEvent', label: 'Google Calendar: Delete Event',
  build(ctx) {
    const p = ctx.step.params;
    return {
      nodes: [n8nNode('googleCalendar', ctx.step.label, { resource: 'event', operation: 'delete', calendar: rl('id', ctx.expr(str(p.calendar) || 'primary')), eventId: ctx.expr(str(p.event ?? p.eventId)), options: {} })],
      status: 'converted', credential: { app: 'Google Calendar', credentialType: 'googleCalendarOAuth2Api' },
    };
  },
});

register({
  source: 'make', key: 'google-docs:getADocument', label: 'Google Docs: Get',
  build(ctx) {
    const doc = str(ctx.step.params.document ?? ctx.step.params.documentId);
    return {
      nodes: [n8nNode('googleDocs', ctx.step.label, { resource: 'document', operation: 'get', documentURL: ctx.expr(doc.includes('{{') ? doc : id(doc)), simple: true })],
      status: 'converted', credential: { app: 'Google Docs', credentialType: 'googleDocsOAuth2Api' }, ref: appRef('Google Docs'),
    };
  },
});

register({
  source: 'make', key: 'google-sheets:createSpreadsheet', label: 'Google Sheets: Create Spreadsheet',
  build(ctx) {
    const p = ctx.step.params;
    const props = (p.properties && typeof p.properties === 'object' ? p.properties : {}) as Record<string, unknown>;
    const sheets = (Array.isArray(p.sheets) ? p.sheets : []).map((s) => str((s as { properties?: { title?: unknown } })?.properties?.title)).filter(Boolean);
    const params: Record<string, unknown> = { resource: 'spreadsheet', operation: 'create', title: ctx.expr(str(props.title ?? p.title)) };
    if (sheets.length) params.sheetsUi = { sheetValues: sheets.map((t) => ({ title: ctx.expr(t) })) };
    params.options = str(props.locale ?? p.locale) ? { locale: str(props.locale ?? p.locale) } : {};
    return {
      nodes: [n8nNode('googleSheets', ctx.step.label, params)],
      status: 'converted', credential: { app: 'Google Sheets', credentialType: 'googleSheetsOAuth2Api' }, ref: appRef('Google Sheets'),
    };
  },
});

register({
  source: 'make', key: 'google-email:ActionCreateDraft', label: 'Gmail: Create Draft',
  build(ctx) {
    const p = ctx.step.params;
    const out = via('google-email:createADraft', ctx, { ...p, content: p.content ?? p.html });
    const options = out.nodes[0].parameters.options as Record<string, unknown>;
    const joined = (v: unknown) => (Array.isArray(v) ? v.filter((x) => x !== '' && x !== null).map(String).join(', ') : str(v));
    if (joined(p.cc)) options.ccList = ctx.expr(joined(p.cc));
    if (joined(p.bcc)) options.bccList = ctx.expr(joined(p.bcc));
    if (str(p.threadId)) options.threadId = ctx.expr(str(p.threadId));
    if (Array.isArray(p.attachments) && p.attachments.length) {
      ctx.note('Attachments become n8n binary data: add them under Options → Attachments.', true);
      return { ...out, status: 'review' };
    }
    return out;
  },
});

// ---------- Notion ----------

const NOTION_TYPES: Record<string, (v: unknown, ctx: MapCtx) => Record<string, unknown>> = {
  title: (v, ctx) => ({ title: ctx.expr(str(v)) }),
  rich_text: (v, ctx) => ({ textContent: ctx.expr(str(v)) }),
  number: (v, ctx) => ({ numberValue: numberOr(v, ctx) }),
  select: (v, ctx) => ({ selectValue: ctx.expr(str(v)) }),
  status: (v, ctx) => ({ statusValue: ctx.expr(str(v)) }),
  url: (v, ctx) => ({ urlValue: ctx.expr(str(v)) }),
  email: (v, ctx) => ({ emailValue: ctx.expr(str(v)) }),
  phone_number: (v, ctx) => ({ phoneValue: ctx.expr(str(v)) }),
  checkbox: (v, ctx) => ({ checkboxValue: typeof v === 'boolean' ? v : ctx.expr(str(v)) }),
};

register({
  source: 'make', key: 'notion:updateADatabaseItem', label: 'Notion: Update Database Page',
  build(ctx) {
    const p = ctx.step.params;
    const values: Array<Record<string, unknown>> = [];
    let unread = 0;
    if (Array.isArray(p.fields)) {
      for (const f of p.fields as Array<Record<string, unknown>>) {
        const type = str(f?.type);
        const date = (f?.date ?? {}) as Record<string, unknown>;
        if (type === 'date' && str(date.start)) values.push({ key: `${str(f.key)}|date`, date: ctx.expr(str(date.start)) });
        else if (NOTION_TYPES[type] && str(f.key)) values.push({ key: `${str(f.key)}|${type}`, ...NOTION_TYPES[type](f.value, ctx) });
        else unread++;
      }
    } else if (p.fields && typeof p.fields === 'object') unread = Object.keys(p.fields).length;
    if (unread) ctx.note(`Make set ${unread} Notion propert${unread === 1 ? 'y' : 'ies'} by its internal id: add ${unread === 1 ? 'it' : 'them'} under "Properties" after picking the page.`, true);
    return {
      nodes: [n8nNode('notion', ctx.step.label, { resource: 'databasePage', operation: 'update', pageId: rl('id', ctx.expr(str(p.page))), simple: true, propertiesUi: { propertyValues: values }, options: {} })],
      status: unread ? 'review' : 'converted', credential: { app: 'Notion', credentialType: 'notionApi' }, ref: appRef('Notion'),
    };
  },
});

// ---------- data store, Sleep ----------

register({
  source: 'make', key: 'datastore:DeleteRecord', label: 'Data Table: Delete Rows',
  build(ctx) {
    ctx.note(DATA_TABLE_NOTE, true);
    return {
      nodes: [n8nNode('dataTable', ctx.step.label, { resource: 'row', operation: 'deleteRows', dataTableId: rl('list', ''), matchType: 'allConditions', filters: { conditions: [{ keyName: 'key', condition: 'eq', keyValue: ctx.expr(str(ctx.step.params.key)) }] }, options: {} })],
      status: 'review',
    };
  },
});

register({
  source: 'make', key: 'util:Sleep', label: 'Wait',
  build(ctx) {
    const p = ctx.step.params;
    return { nodes: [n8nNode('wait', ctx.step.label, { amount: numberOr(p.delay ?? p.duration ?? p.timeout ?? 1, ctx), unit: 'seconds' })], status: 'converted' };
  },
});

// ---------- XML and CSV ----------

register({
  source: 'make', key: 'xml:ParseXML', label: 'XML (to JSON)',
  build(ctx) {
    ctx.note('n8n parses XML with its own conventions (attributes merged into the element, text in "_"): check the fields later steps read once after a test run.', true);
    return {
      nodes: [
        n8nNode('set', `${ctx.step.label} (text)`, { mode: 'manual', assignments: { assignments: [{ id: randomUUID(), name: 'xml', value: ctx.expr(str(ctx.step.params.xml)), type: 'string' }] }, options: {} }),
        n8nNode('xml', ctx.step.label, { mode: 'xmlToJson', dataPropertyName: 'xml', options: {} }),
      ],
      status: 'review',
    };
  },
});

register({
  source: 'make', key: 'csv:ParseCSV', label: 'Code (parse CSV) + Split Out',
  build(ctx) {
    const p = ctx.step.params;
    const delimiter = p.delimiterType === 'tab' ? '\t' : p.delimiterType === 'other' && str(p.delimiter) ? str(p.delimiter) : ',';
    const headers = p.csvContainsHeaders !== false;
    const jsCode = [
      '// Make "Parse CSV": one item per row. Quoted fields may hold the delimiter, quotes ("") and line breaks.',
      `const text = String(${ctx.js(str(p.csv ?? p.data))} ?? '');`,
      `const d = ${JSON.stringify(delimiter)};`,
      'const rows = [];',
      "let row = [], field = '', quoted = false;",
      'for (let i = 0; i < text.length; i++) {',
      '  const c = text[i];',
      "  if (quoted) { if (c !== '\"') field += c; else if (text[i + 1] === '\"') { field += '\"'; i++; } else quoted = false; }",
      "  else if (c === '\"') quoted = true;",
      "  else if (c === d) { row.push(field); field = ''; }",
      "  else if (c === '\\n' || c === '\\r') { if (c === '\\r' && text[i + 1] === '\\n') i++; row.push(field); rows.push(row); row = []; field = ''; }",
      '  else field += c;',
      '}',
      "if (field !== '' || row.length) { row.push(field); rows.push(row); }",
      `const header = ${headers ? 'rows.shift() ?? []' : '[]'};`,
      "const objects = rows.filter((r) => r.some((v) => v !== '')).map((r) => Object.fromEntries(r.map((v, k) => [header[k] || String(k + 1), v])));",
      'return { json: { rows: objects } };',
    ].join('\n');
    if (!headers) ctx.note('The CSV has no header row: the columns are named "1", "2", "3"… Check that later steps read them by these names.', true);
    return {
      nodes: [
        n8nNode('code', `${ctx.step.label} (rows)`, { mode: 'runOnceForEachItem', language: 'javaScript', jsCode }),
        n8nNode('splitOut', ctx.step.label, { fieldToSplitOut: 'rows', include: 'noOtherFields', options: {} }),
      ],
      status: headers ? 'converted' : 'review',
      ref: (out, first) => (first === '__IMTINDEX__' ? { base: '($itemIndex + 1)', drop: 1 } : first === '__IMTLENGTH__' ? { base: `${nodeRef(out)}.all().length`, drop: 1 } : undefined),
    };
  },
});

// ---------- X (Twitter) ----------

register({
  source: 'make', key: 'twitter:createATweet', label: 'X (Twitter): Create Tweet',
  build(ctx) {
    const p = ctx.step.params;
    const media = Array.isArray(p.media_ids) ? p.media_ids : p.media;
    if (Array.isArray(media) ? media.length : str(media)) ctx.note('Make attached media; upload it to X first and put the media id under Additional Fields → Attachments.', true);
    return {
      nodes: [n8nNode('twitter', ctx.step.label, { resource: 'tweet', operation: 'create', text: ctx.expr(str(p.text)), additionalFields: {} })],
      status: (Array.isArray(media) ? media.length : str(media)) ? 'review' : 'converted', credential: { app: 'X (Twitter)', credentialType: 'twitterOAuth2Api' }, ref: appRef('X (Twitter)'),
    };
  },
});

// ---------- newer keys of modules we already convert ----------

register({
  source: 'make', key: 'apify:runActorNew', label: 'HTTP Request (Apify API)',
  build(ctx) {
    const p = ctx.step.params;
    return via('apify:runActor', ctx, { ...p, inputBody: p[`inputBody${str(p.actorId)}`] ?? p.inputBody });
  },
});

register({
  source: 'make', key: 'supabase:ActionCreateARecord', label: 'Supabase: Create Row',
  build(ctx) {
    const p = ctx.step.params;
    const data = p.data && typeof p.data === 'object' ? (p.data as Record<string, unknown>) : {};
    return via('supabase:createARow', ctx, { table: p.table, ...data });
  },
});

// ---------- Facebook Pages and Instagram (Graph API) ----------

const GRAPH = { app: 'Facebook Graph API', credentialType: 'facebookGraphApi' };
const PAGE_TOKEN_NOTE = 'Use a Page access token (not a user token) in the Facebook Graph API credential: Make used the Page connection.';

/** One Graph API POST: `node`/`edge` with query parameters (empty values left out). */
function graphPost(name: string, node: unknown, edge: string, query: Array<[string, unknown]>, ctx: MapCtx) {
  const parameter = query.filter(([, v]) => str(v) !== '').map(([k, v]) => ({ name: k, value: typeof v === 'boolean' ? String(v) : ctx.expr(str(v)) }));
  return n8nNode('facebookGraphApi', name, { hostUrl: 'graph.facebook.com', httpRequestMethod: 'POST', graphApiVersion: '', node: ctx.expr(str(node)), edge, options: { queryParameters: { parameter } } });
}

register({
  source: 'make', key: 'facebook-pages:CreatePost', label: 'Facebook Graph API: Page Post',
  build(ctx) {
    const p = ctx.step.params;
    ctx.note(PAGE_TOKEN_NOTE, true);
    if (str(p.date)) ctx.note('Make scheduled the post: add "published" = false and "scheduled_publish_time" (a Unix time) to the query parameters.', true);
    return { nodes: [graphPost(ctx.step.label, p.page_id, 'feed', [['message', p.message], ['link', p.link]], ctx)], status: 'review', credential: GRAPH };
  },
});

register({
  source: 'make', key: 'facebook-pages:CreatePostWithPhotos', label: 'Facebook Graph API: Page Photo Post',
  build(ctx) {
    const p = ctx.step.params;
    const photos = (Array.isArray(p.photos) ? p.photos : []) as Array<Record<string, unknown>>;
    ctx.note(PAGE_TOKEN_NOTE, true);
    if (photos.length > 1) ctx.note(`Make posted ${photos.length} photos in one post; this step posts the first. For all of them, upload each with "published" = false and attach their ids to a feed post ("attached_media").`, true);
    if (photos[0] && photos[0].type !== 'url') ctx.note('Make uploaded the photo as a file; the Graph API step here sends its URL: switch on "Send Binary File" for a file.', true);
    if (str(p.date)) ctx.note('Make scheduled the post: add "published" = false and "scheduled_publish_time" (a Unix time) to the query parameters.', true);
    return { nodes: [graphPost(ctx.step.label, p.page_id, 'photos', [['url', photos[0]?.url], ['message', p.message]], ctx)], status: 'review', credential: GRAPH };
  },
});

/** Publish the media container the step before created (its id arrives as $json.id; Wait passes it on). */
function publishMedia(name: string, account: unknown, ctx: MapCtx) {
  return n8nNode('facebookGraphApi', name, {
    hostUrl: 'graph.facebook.com', httpRequestMethod: 'POST', graphApiVersion: '', node: ctx.expr(str(account)), edge: 'media_publish',
    options: { queryParameters: { parameter: [{ name: 'creation_id', value: '={{ $json.id }}' }] } },
  });
}

register({
  source: 'make', key: 'instagram-business:CreatePostPhoto', label: 'Facebook Graph API: Instagram media + publish',
  build(ctx) {
    const p = ctx.step.params;
    const account = p.accountId ?? p.account;
    ctx.note('Instagram publishes in two calls (create the media, then publish it); the Facebook Graph API credential needs the instagram_content_publish permission.', true);
    return {
      nodes: [
        graphPost(`${ctx.step.label} (media)`, account, 'media', [['image_url', p.image_url], ['caption', p.caption], ['location_id', p.location_id]], ctx),
        publishMedia(ctx.step.label, account, ctx),
      ],
      status: 'review', credential: GRAPH,
    };
  },
});

register({
  source: 'make', key: 'instagram-business:CreateAReelPost', label: 'Facebook Graph API: Instagram reel + publish',
  build(ctx) {
    const p = ctx.step.params;
    const account = p.accountId ?? p.account;
    ctx.note('Instagram has to process the video before it can be published: this waits 60 seconds. If publishing fails with "media is not ready", wait longer, or check the media status_code first.', true);
    const media = graphPost(`${ctx.step.label} (media)`, account, 'media', [['media_type', 'REELS'], ['video_url', p.video_url], ['caption', p.caption], ['share_to_feed', p.share_to_feed], ['thumb_offset', p.thumb_offset], ['location_id', p.location_id]], ctx);
    return { nodes: [media, n8nNode('wait', `${ctx.step.label} (processing)`, { amount: 60, unit: 'seconds' }), publishMedia(ctx.step.label, account, ctx)], status: 'review', credential: GRAPH };
  },
});
