import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { manifest, tools } from '../scripts/build-mcpb.ts';
import { VERSION } from '../src/version.ts';

const json = (f: string) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));

test('one version everywhere: package.json, src/version.ts, server.json, the extension manifest', async () => {
  const pkg = json('package.json');
  const server = json('server.json');
  assert.equal(VERSION, pkg.version);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].version, pkg.version);
  assert.equal((await manifest()).version, pkg.version);
});

test('registry names agree: mcpName in package.json is the server.json name', () => {
  assert.equal(json('package.json').mcpName, json('server.json').name);
  assert.equal(json('server.json').packages[0].identifier, json('package.json').name);
});

test('the extension lists exactly the server tools, and its settings feed the server env', async () => {
  const m = await manifest();
  assert.deepEqual((m.tools as Array<{ name: string }>).map((t) => t.name), (await tools()).map((t) => t.name));
  assert.equal((m.tools as unknown[]).length, 7);
  const env = ((m.server as Record<string, any>).mcp_config.env) as Record<string, string>;
  assert.deepEqual(Object.keys(env).sort(), ['MIGRATE_OUTPUT_DIR', 'N8N_API_KEY', 'N8N_URL']);
  assert.equal((m.user_config as Record<string, any>).n8n_api_key.sensitive, true);
  assert.ok(existsSync(new URL('../mcpb/icon.png', import.meta.url)));
});

test('the npm package ships the compiled server and nothing from n8n', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', shell: process.platform === 'win32', cwd: new URL('..', import.meta.url) });
  const files = (JSON.parse(out)[0].files as Array<{ path: string }>).map((f) => f.path);
  assert.ok(files.includes('dist/cli.js'), 'run npm run build first');
  assert.ok(!files.some((f) => /n8n-nodes|workflow-sdk|\.cache|\.corpus|test\//.test(f)), files.join(', '));
});
