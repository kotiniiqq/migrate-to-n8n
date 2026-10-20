import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeStats } from '../scripts/corpus-stats.ts';
import type { ConversionReport, Status } from '../src/types.ts';

const report = (steps: Array<[string, Status]>): ConversionReport => ({
  source: 'make', workflowName: 'x',
  totals: { converted: steps.filter((s) => s[1] === 'converted').length, review: steps.filter((s) => s[1] === 'review').length, manual: steps.filter((s) => s[1] === 'manual').length },
  steps: steps.map(([key, status], i) => ({ sourceId: String(i), sourceLabel: key, sourceKey: key, n8nNodes: [key], status, notes: [] })),
  credentials: [], webhooks: [], placeholders: [], nextSteps: [],
});

test('computeStats: shares, unmapped keys by frequency, failures and timing', () => {
  const s = computeStats([
    { report: report([['a:x', 'converted'], ['b:y', 'manual'], ['c:z', 'review']]), ms: 2, checkErrors: 0, catalogErrors: 0 },
    { report: report([['a:x', 'converted'], ['b:y', 'manual']]), ms: 4, checkErrors: 1, catalogErrors: 2 },
    { report: report([['d:w', 'manual']]), ms: 10, checkErrors: 0, catalogErrors: 0 },
  ], 2);
  assert.equal(s.files, 3);
  assert.equal(s.rejected, 2);
  assert.equal(s.steps, 6);
  assert.deepEqual(s.share, { converted: 33.3, review: 16.7, manual: 50 });
  assert.equal(s.convertedOrReview, 50);
  assert.deepEqual(s.topUnmapped.slice(0, 2), [['b:y', 2], ['d:w', 1]]);
  assert.equal(s.filesWithCheckErrors, 1);
  assert.equal(s.filesWithCatalogErrors, 1);
  assert.deepEqual(s.ms, { p50: 4, p95: 10, max: 10 });
});
