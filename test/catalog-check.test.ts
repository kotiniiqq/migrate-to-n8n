import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nodeIssues } from './helpers/n8n-types.ts';

const http = (parameters: Record<string, unknown>) => ({ name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.3, parameters });

test('the catalog check accepts a valid node', () => {
  assert.deepEqual(nodeIssues('2.44.4', http({ method: 'POST', url: 'https://x', sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '={{ 1 }}', options: {} })), []);
});

test('the catalog check catches unknown parameters, wrong option values, hidden parameters and bad collection keys', () => {
  const issues = nodeIssues('2.44.4', http({ method: 'FETCH', url: 'https://x', bogus: 1, jsonBody: '{}', options: { nope: true } }));
  assert.equal(issues.length, 4, issues.join('\n'));
  assert.match(issues.join('\n'), /FETCH/);
  assert.match(issues.join('\n'), /unknown parameter "bogus"/);
  assert.match(issues.join('\n'), /"jsonBody" is hidden/);
  assert.match(issues.join('\n'), /options.nope/);
});

test('the catalog check reports a type version n8n does not have', () => {
  assert.match(nodeIssues('1.123.85', { ...http({}), typeVersion: 9 }).join(''), /not in n8n/);
});

test('display rules with a version range are understood', () => {
  const sheets = (typeVersion: number) => ({
    name: 'Sheets', type: 'n8n-nodes-base.googleSheets', typeVersion,
    parameters: { resource: 'sheet', operation: 'update', columns: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [] } },
  });
  assert.deepEqual(nodeIssues('2.44.4', sheets(4.5)), []);
});
