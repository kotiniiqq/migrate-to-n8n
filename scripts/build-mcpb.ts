/** Build the Claude Desktop extension: migrate-to-n8n.mcpb (a stable name for releases/latest/download).
 *
 *  The bundle holds the compiled server (dist/), its production dependencies and a manifest whose tool list and
 *  version come from the code, so they cannot drift. Run `npm run build` first.
 *
 *   npm run mcpb
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/mcp/server.ts';
import { VERSION } from '../src/version.ts';

/** Tool names and first sentences, from a server that has the upload tool enabled. */
export async function tools(): Promise<Array<{ name: string; description: string }>> {
  const server = createServer({ env: { N8N_URL: 'https://n8n.example.com', N8N_API_KEY: 'x' } });
  const client = new Client({ name: 'build', version: VERSION });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const list = (await client.listTools()).tools;
  await client.close();
  return list
    .map((t) => ({ name: t.name, description: `${(t.description ?? '').split('. ')[0].replace(/\.$/, '')}.` }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

export async function manifest(): Promise<Record<string, unknown>> {
  return {
    manifest_version: '0.3',
    name: 'migrate-to-n8n',
    display_name: 'Migrate to n8n',
    version: VERSION,
    description: 'Convert Make scenarios and Zapier zaps into n8n workflows, with a report of what to check and how to finish the rest.',
    long_description: [
      'Attach a Make blueprint or a Zapier export and ask Claude to convert it to n8n. You get a workflow file to import',
      'and a report: what converted, what to check, and a concrete suggestion for every step that needs finishing by hand.',
      '\n\nNothing leaves your computer: the conversion runs locally. Optionally add your n8n address and API key to',
      'upload the result straight into your n8n (created inactive; nothing existing is changed).',
    ].join(' '),
    author: { name: 'Kyrylo Kalashnyk', email: 'kotiniiqq@gmail.com', url: 'https://github.com/kotiniiqq' },
    repository: { type: 'git', url: 'https://github.com/kotiniiqq/migrate-to-n8n' },
    homepage: 'https://github.com/kotiniiqq/migrate-to-n8n',
    documentation: 'https://github.com/kotiniiqq/migrate-to-n8n#readme',
    support: 'https://github.com/kotiniiqq/migrate-to-n8n/issues',
    icon: 'icon.png',
    server: {
      type: 'node',
      entry_point: 'dist/cli.js',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/dist/cli.js', 'serve'],
        env: { MIGRATE_OUTPUT_DIR: '${user_config.output_dir}', N8N_URL: '${user_config.n8n_url}', N8N_API_KEY: '${user_config.n8n_api_key}' },
      },
    },
    tools: await tools(),
    keywords: ['n8n', 'make', 'zapier', 'migration', 'automation', 'workflow'],
    license: 'MIT',
    compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=22.0.0' } },
    user_config: {
      output_dir: { type: 'directory', title: 'Output folder', description: 'Where converted workflows and reports are saved.', required: false, default: '${HOME}/Documents/migrate-to-n8n' },
      n8n_url: { type: 'string', title: 'n8n address (optional)', description: 'For uploading results to your n8n, e.g. https://n8n.example.com. Leave empty to only write files.', required: false },
      n8n_api_key: { type: 'string', title: 'n8n API key (optional)', description: 'n8n → Settings → n8n API → Create an API key.', required: false, sensitive: true },
    },
  };
}

async function build(): Promise<void> {
  if (!existsSync('dist/cli.js')) throw new Error('dist/cli.js is missing: run `npm run build` first');
  const dir = mkdtempSync(join(tmpdir(), 'mcpb-'));
  try {
    cpSync('dist', join(dir, 'dist'), { recursive: true });
    cpSync('mcpb/icon.png', join(dir, 'icon.png'));
    cpSync('LICENSE', join(dir, 'LICENSE'));
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', dependencies: pkg.dependencies }, null, 2));
    execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(await manifest(), null, 2) + '\n');
    mkdirSync('out', { recursive: true });
    const target = join('out', 'migrate-to-n8n.mcpb');
    rmSync(target, { force: true });
    execFileSync('npx', ['-y', '@anthropic-ai/mcpb@2.1.2', 'pack', dir, target], { stdio: 'inherit', shell: process.platform === 'win32' });
    console.log(`built ${target}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('build-mcpb.ts')) await build();
