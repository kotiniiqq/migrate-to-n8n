import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findApp } from '../src/map/apps.ts';
import { N8N_APPS } from '../src/map/n8n-apps.ts';
import { commonVersion, loadCatalog } from './helpers/n8n-types.ts';

test('the generated app list matches both n8n catalogs', () => {
  assert.ok(N8N_APPS.length > 300);
  for (const [name, , version] of N8N_APPS) assert.equal(version, commonVersion(`n8n-nodes-base.${name}`), name);
});

const CASES: Array<[string, string, string]> = [
  ['make', 'google-sheets', 'n8n-nodes-base.googleSheets'],
  ['make', 'google-email', 'n8n-nodes-base.gmail'],
  ['make', 'slack', 'n8n-nodes-base.slack'],
  ['make', 'hubspotcrm', 'n8n-nodes-base.hubspot'],
  ['make', 'microsoft-365-email', 'n8n-nodes-base.microsoftOutlook'],
  ['make', 'monday', 'n8n-nodes-base.mondayCom'],
  ['make', 'openai-gpt-3', '@n8n/n8n-nodes-langchain.openAi'],
  ['make', 'email', 'n8n-nodes-base.emailSend'],
  ['make', 'rss', 'n8n-nodes-base.rssFeedRead'],
  ['make', 'woocommerce', 'n8n-nodes-base.wooCommerce'],
  ['zapier', 'GoogleSheetsV2CLIAPI', 'n8n-nodes-base.googleSheets'],
  ['zapier', 'GoogleMailV2CLIAPI', 'n8n-nodes-base.gmail'],
  ['zapier', 'SlackCLIAPI', 'n8n-nodes-base.slack'],
  ['zapier', 'HubSpotCLIAPI', 'n8n-nodes-base.hubspot'],
  ['zapier', 'OpenAiCLIAPI', '@n8n/n8n-nodes-langchain.openAi'],
  ['zapier', 'ExcelCLIAPI', 'n8n-nodes-base.microsoftExcel'],
];

for (const [source, app, type] of CASES) {
  test(`${source} app "${app}" maps to ${type}`, () => {
    assert.equal(findApp(source as 'make' | 'zapier', app, false)?.type, type);
  });
}

test('a trigger step prefers the app trigger node', () => {
  assert.equal(findApp('make', 'google-sheets', true)?.type, 'n8n-nodes-base.googleSheetsTrigger');
  assert.equal(findApp('make', 'typeform', true)?.type, 'n8n-nodes-base.typeformTrigger');
  assert.equal(findApp('make', 'typeform', false)?.type, 'n8n-nodes-base.typeformTrigger'); // the only Typeform node
});

test('apps without an n8n node may have a known API base', () => {
  const apify = findApp('make', 'apify', false);
  assert.equal(apify?.type, undefined);
  assert.equal(apify?.apiBase, 'https://api.apify.com/v2');
  assert.equal(findApp('make', 'app#custom-app-oonbtb', false), undefined);
});

test('every node type an alias points to exists in both catalogs', () => {
  for (const [source, app] of CASES) {
    const hit = findApp(source as 'make' | 'zapier', app, false)!;
    for (const v of ['2.44.4', '1.123.85'] as const) assert.ok(loadCatalog(v).get(hit.type!)?.versions.includes(hit.typeVersion!), `${hit.type}@${hit.typeVersion}`);
  }
});
