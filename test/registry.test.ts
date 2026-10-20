import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NODE } from '../src/map/registry.ts';
import { commonVersion } from './helpers/n8n-types.ts';

const EXPECTED = ['httpRequest', 'webhook', 'respondToWebhook', 'scheduleTrigger', 'manualTrigger', 'set', 'code', 'if',
  'filter', 'switch', 'splitOut', 'aggregate', 'merge', 'wait', 'noOp', 'stickyNote', 'dataTable', 'dateTime',
  'googleSheets', 'gmail', 'emailSend', 'slack', 'airtable', 'notion', 'telegram', 'hubspot', 'googleCalendar',
  'microsoftExcel', 'rssFeedRead', 'openAi'];

test('the node catalog covers the nodes the converter builds on', () => {
  for (const short of EXPECTED) assert.ok(NODE[short], `NODE.${short} missing`);
});

test('every NODE entry exists in both n8n catalogs at the common max version', () => {
  for (const [short, n] of Object.entries(NODE)) assert.equal(n.typeVersion, commonVersion(n.type), short);
});
