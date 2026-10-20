import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const p = (u: URL) => decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1');
const CLI = p(new URL('../src/cli.ts', import.meta.url));
const MAKE = p(new URL('./fixtures/make/basic-webhook-sheets.json', import.meta.url));
const ZAPIER = p(new URL('./fixtures/zapier/export-basic.json', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'mtn-cli-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], { encoding: 'utf8', env: { ...process.env, N8N_URL: '', N8N_API_KEY: '', ...env }, input: '' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('--help and --version', () => {
  const h = run(['--help']);
  assert.equal(h.code, 0);
  for (const cmd of ['convert', 'list-zaps', 'supported', 'check', 'upload', 'serve']) assert.match(h.out, new RegExp(cmd));
  assert.match(run(['--version']).out.trim(), /^\d+\.\d+\.\d+$/);
});

test('convert a Make blueprint: summary, next steps and file paths', () => {
  const out = join(dir, 'make');
  const r = run(['convert', MAKE, '-o', out]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Make → n8n: Leads from the website form/);
  assert.match(r.out, /✅ \d+ converted · ⚠️ \d+ to review · 🛠 \d+ manual/);
  assert.match(r.out, /Next steps/);
  assert.ok(existsSync(join(out, 'Leads from the website form.n8n.json')));
  assert.ok(r.out.includes(join(out, 'Leads from the website form.report.md')));
});

test('convert detects a Zapier export and can pick zaps', () => {
  const out = join(dir, 'zap');
  const r = run(['convert', ZAPIER, '-o', out, '--zap', 'Daily totals']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Zapier → n8n: Daily totals/);
  assert.doesNotMatch(r.out, /Lead routing/);
});

test('list-zaps and supported', () => {
  assert.match(run(['list-zaps', ZAPIER]).out, /Lead routing.*8 steps/);
  const s = run(['supported', 'webhook', '--source', 'zapier']);
  assert.match(s.out, /WebHookCLIAPI:hook_v2/);
  assert.doesNotMatch(s.out, /gateway:CustomWebHook/);
});

test('check: exit 1 when the workflow has errors', () => {
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ name: 'x', nodes: [{ name: 'A' }, { name: 'A' }], connections: {} }));
  const r = run(['check', bad]);
  assert.equal(r.code, 1);
  assert.match(r.out, /unique/i);
});

test('bad input: exit 1 with one line, no stack trace', () => {
  for (const args of [['convert', join(dir, 'missing.json')], ['convert'], ['nope']]) {
    const r = run(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.doesNotMatch(r.err, /\n\s+at /);
  }
  const notJson = join(dir, 'x.json');
  writeFileSync(notJson, '{"hello": 1}');
  assert.match(run(['convert', notJson]).err, /neither a Make blueprint nor a Zapier export/);
});

test('upload without settings explains what to set (exit 1); a failed upload exits 2', () => {
  const wf = join(dir, 'make', 'Leads from the website form.n8n.json');
  if (!existsSync(wf)) run(['convert', MAKE, '-o', join(dir, 'make')]);
  const none = run(['upload', wf]);
  assert.equal(none.code, 1);
  assert.match(none.err, /N8N_URL and N8N_API_KEY/);
  const down = run(['upload', wf], { N8N_URL: 'http://127.0.0.1:9', N8N_API_KEY: 'x' });
  assert.equal(down.code, 2);
  assert.match(down.err, /Could not reach/);
});
