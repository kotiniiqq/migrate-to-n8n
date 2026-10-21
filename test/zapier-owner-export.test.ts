import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { checkWorkflow } from '../src/build/check.ts';
import { convertZapier } from '../src/convert.ts';
import type { ConversionResult } from '../src/types.ts';
import { catalogIssues } from './helpers/n8n-types.ts';

// A real export (2026-10-21) of a draft Zap built with Zapier Copilot: several steps were left unfinished.
const exportFile = () => JSON.parse(readFileSync(new URL('./fixtures/zapier/owner-hard-cases.json', import.meta.url), 'utf8'));
const convert = () => convertZapier(exportFile())[0];
const step = (r: ConversionResult, id: string) => r.report.steps.find((s) => s.sourceId === id)!;
const byName = (r: ConversionResult, name: string) => {
  const n = r.workflow.nodes.find((x) => x.name === name);
  assert.ok(n, `no node "${name}" in ${r.workflow.nodes.map((x) => x.name).join(', ')}`);
  return n;
};

test('real Zapier export: imports cleanly and matches n8n node descriptions', () => {
  const r = convert();
  assert.deepEqual(checkWorkflow(r.workflow).filter((i) => i.level === 'error'), []);
  assert.deepEqual(catalogIssues(r.workflow), []);
  for (const s of r.report.steps) if (s.status === 'manual') assert.ok(s.suggestion);
});

test('Code steps named by a UUID action get a readable name', () => {
  const r = convert();
  assert.equal(step(r, '384210041').sourceLabel, 'Code: run JavaScript');
});

test('a Code step with no code in the export is manual and asks for the code', () => {
  const r = convert();
  const s = step(r, '384210041');
  assert.equal(s.status, 'manual');
  assert.match(s.suggestion ?? '', /no code/i);
  assert.equal(byName(r, 'Code: run JavaScript').disabled, true);
});

test('a Formatter step with no transform chosen says so', () => {
  const s = step(convert(), '384210030');
  assert.equal(s.status, 'manual');
  assert.match(s.suggestion ?? '', /no transform/i);
  assert.doesNotMatch(s.suggestion ?? '', /no automatic translation/);
});

test('a filter with no conditions is review, not converted', () => {
  const s = step(convert(), '384209934');
  assert.equal(s.status, 'review');
});

test('paths with no conditions are named on the Paths step, which is review', () => {
  const s = step(convert(), '384210039');
  assert.equal(s.status, 'review');
  assert.ok(s.notes.some((n) => /Path A/.test(n) && /Path B/.test(n) && /no conditions/.test(n)), s.notes.join(' | '));
});

test('a path Zapier marked isAlwaysRun is not flagged', () => {
  const custom = exportFile();
  for (const id of ['384210040', '384210042']) custom.zaps[0].nodes[id].params.isAlwaysRun = true;
  const s = convertZapier(custom)[0].report.steps.find((x) => x.sourceId === '384210039')!;
  assert.equal(s.status, 'converted');
  assert.ok(!s.notes.some((n) => /no conditions/.test(n)));
});

test('Zapier "Z" is a +0000 offset (Luxon ZZZ), unlike Make where it is +00:00', () => {
  const r = convert();
  const p = JSON.stringify(byName(r, 'Formatter: datetime line item').parameters);
  assert.match(p, /ss'?ZZZ/);
  const custom = exportFile();
  custom.zaps[0].nodes['384210074'].params.to_format = 'YYYY-MM-DD HH:mm ZZ';
  const p2 = JSON.stringify(convertZapier(custom)[0].workflow.nodes.find((n) => n.name === 'Formatter: datetime line item')!.parameters);
  assert.match(p2, /HH:mm ZZ'?\)/);
  assert.doesNotMatch(p2, /ZZZ/);
});
