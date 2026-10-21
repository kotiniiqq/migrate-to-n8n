import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { convertMake, defaultOutputDir, writeResult } from '../src/convert.ts';
import { renderMarkdown } from '../src/report/render.ts';
import type { ConversionReport } from '../src/types.ts';
import { stableText } from './helpers/golden.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/make/${name}.json`, import.meta.url), 'utf8'));

const REPORT: ConversionReport = {
  source: 'make',
  workflowName: 'Leads | form',
  totals: { converted: 1, review: 1, manual: 1 },
  steps: [
    { sourceId: '1', sourceLabel: 'Webhook', sourceKey: 'gateway:CustomWebHook', n8nNodes: ['Webhook'], status: 'converted', notes: ['New URL.'] },
    { sourceId: '2', sourceLabel: 'Set | x', sourceKey: 'util:SetVariable2', n8nNodes: ['Filter', 'Set | x'], status: 'review', notes: ['Check\nthis.'] },
    { sourceId: '3', sourceLabel: 'Trello', sourceKey: 'trello:createCard', n8nNodes: ['Trello'], status: 'manual', notes: [], suggestion: 'Use the Trello node.' },
  ],
  credentials: [{ app: 'Trello', credentialType: 'trelloApi', nodes: ['Trello'] }],
  webhooks: [{ node: 'Webhook', path: 'leads' }],
  placeholders: [{ node: 'Trello', field: 'url', value: 'https://REPLACE-ME.example' }],
  nextSteps: ['Do this.', 'Then that.'],
};

test('the Markdown report has the totals line and every section in order', () => {
  const md = renderMarkdown(REPORT);
  assert.match(md, /^# Make → n8n: Leads \\\| form\n/);
  assert.match(md, /✅ 1 converted · ⚠️ 1 to review · 🛠 1 manual/);
  const order = ['## Next steps', '## Credentials to reconnect', '## Webhook URLs that changed', '## Steps', '## Placeholders to fill'].map((h) => md.indexOf(h));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), String(order));
  assert.match(md, /1\. Do this\.\n2\. Then that\./);
  assert.match(md, /\| Trello \| `trelloApi` \| Trello \|/);
  assert.match(md, /`\/webhook\/leads`/);
});

test('table cells escape pipes and line breaks', () => {
  const md = renderMarkdown(REPORT);
  assert.match(md, /Set \\\| x/);
  assert.match(md, /Check<br>this\./);
  const rows = md.split('## Steps')[1].split('\n').filter((l) => l.startsWith('| 2 '));
  assert.equal(rows.length, 1); // the line break stayed inside the row
});

test('manual steps show the suggestion, converted steps their notes', () => {
  const md = renderMarkdown(REPORT);
  assert.match(md, /🛠 manual \| Use the Trello node\. \|/);
  assert.match(md, /✅ converted \| New URL\. \|/);
});

test('empty sections are left out', () => {
  const md = renderMarkdown({ ...REPORT, credentials: [], webhooks: [], placeholders: [] });
  assert.doesNotMatch(md, /Credentials to reconnect|Webhook URLs|Placeholders/);
});

test('writeResult writes three files and never overwrites', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'mtn-')), 'тест папка');
  try {
    const res = convertMake(fixture('basic-webhook-sheets'));
    const a = writeResult(res, dir);
    const b = writeResult(res, dir);
    assert.equal(a.workflowPath, join(dir, 'Leads from the website form.n8n.json'));
    assert.equal(b.workflowPath, join(dir, 'Leads from the website form (2).n8n.json'));
    for (const p of [a.workflowPath, a.reportPath, a.reportJsonPath, b.reportPath]) assert.ok(existsSync(p), p);
    assert.equal(JSON.parse(readFileSync(a.workflowPath, 'utf8')).name, 'Leads from the website form');
    assert.equal(JSON.parse(readFileSync(a.reportJsonPath, 'utf8')).workflowName, 'Leads from the website form');
    assert.match(readFileSync(a.reportPath, 'utf8'), /^# Make → n8n/);
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

test('the default output folder is Documents/migrate-to-n8n unless MIGRATE_OUTPUT_DIR is set', () => {
  const saved = process.env.MIGRATE_OUTPUT_DIR;
  try {
    delete process.env.MIGRATE_OUTPUT_DIR;
    assert.match(defaultOutputDir(), /Documents[\\/]migrate-to-n8n$/);
    process.env.MIGRATE_OUTPUT_DIR = '/tmp/x';
    assert.equal(defaultOutputDir(), join('/tmp/x'));
    process.env.MIGRATE_OUTPUT_DIR = '${user_config.output_dir}'; // an unfilled Claude Desktop setting
    assert.match(defaultOutputDir(), /Documents[\\/]migrate-to-n8n$/);
  } finally {
    if (saved === undefined) delete process.env.MIGRATE_OUTPUT_DIR;
    else process.env.MIGRATE_OUTPUT_DIR = saved;
  }
});

test('the Markdown report of a real conversion matches the reviewed golden text', () => {
  const md = stableText(renderMarkdown(convertMake(fixture('basic-webhook-sheets')).report));
  const file = new URL('./golden/make/basic-webhook-sheets.report.md', import.meta.url);
  if (process.env.UPDATE_GOLDEN || !existsSync(file)) writeFileSync(file, md);
  assert.equal(md, readFileSync(file, 'utf8'));
});
