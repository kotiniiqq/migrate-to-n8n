#!/usr/bin/env node
/** Command line: convert without any AI client, or `serve` for MCP clients (the default when run by one). */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { checkWorkflow } from './build/check.ts';
import { convertMake, convertZapier, defaultOutputDir, writeResult } from './convert.ts';
import { readInput, readWorkflow, resolvePath } from './io.ts';
import { allEntries } from './map/registry.ts';
import { createServer } from './mcp/server.ts';
import { uploadConfig, uploadWorkflow } from './n8n/upload.ts';
import { totalsLine } from './report/render.ts';
import { InputError, type ConversionResult } from './types.ts';
import { VERSION } from './version.ts';
import { listZaps } from './zapier/parse.ts';

const HELP = `migrate-to-n8n ${VERSION}: convert Make and Zapier automations into n8n workflows

Usage:
  migrate-to-n8n convert <file> [-o <folder>] [--zap <id or title>]...
                                     Make blueprint or Zapier export → .n8n.json + report
  migrate-to-n8n list-zaps <file>    the zaps in a Zapier export
  migrate-to-n8n supported [text] [--source make|zapier]
                                     what converts automatically
  migrate-to-n8n check <workflow.json>
                                     problems left in an n8n workflow file
  migrate-to-n8n upload <workflow.json>
                                     create it (inactive) in your n8n: needs N8N_URL and N8N_API_KEY
  migrate-to-n8n serve               run as an MCP server over stdio (what MCP clients start)

Results go to Documents/migrate-to-n8n unless -o or MIGRATE_OUTPUT_DIR says otherwise.
Help and feedback: https://github.com/kotiniiqq/migrate-to-n8n`;

class UploadFailure extends Error {}

function option(args: string[], ...names: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) {
      if (i + 1 >= args.length) throw new InputError(`${args[i]} needs a value.`);
      values.push(args[i + 1]);
      args.splice(i, 2);
      i--;
    }
  }
  return values;
}

function detect(text: string): 'make' | 'zapier' {
  let v: unknown;
  try {
    v = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new InputError('The file is not JSON: it is neither a Make blueprint nor a Zapier export.');
  }
  const o = (Array.isArray(v) && v.length === 1 ? v[0] : v) as Record<string, unknown>;
  // Make's API answers {response: {blueprint}}, which parseMake accepts too.
  const resp = o && typeof o === 'object' ? (o.response as Record<string, unknown> | undefined) : undefined;
  if (resp && typeof resp === 'object' && resp.blueprint && typeof resp.blueprint === 'object') return 'make';
  if (o && typeof o === 'object' && (Array.isArray(o.flow) || (o.blueprint && typeof o.blueprint === 'object'))) return 'make';
  if (Array.isArray(v) || (o && typeof o === 'object' && (Array.isArray(o.zaps) || 'nodes' in o))) return 'zapier';
  throw new InputError('The file is neither a Make blueprint nor a Zapier export.');
}

function print(results: ConversionResult[], dir: string): void {
  for (const res of results) {
    const files = writeResult(res, dir);
    const r = res.report;
    console.log(`\n${r.source === 'make' ? 'Make' : 'Zapier'} → n8n: ${r.workflowName}`);
    console.log(totalsLine(r));
    console.log('\nNext steps:');
    r.nextSteps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    console.log(`\nWorkflow: ${files.workflowPath}\nReport:   ${files.reportPath}`);
  }
}

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  if (args.includes('--version') || args.includes('-v')) { console.log(VERSION); return 0; }
  const cmd = args.shift();
  if (!cmd) {
    if (!process.stdin.isTTY) return serve();
    console.log(HELP);
    return 0;
  }
  switch (cmd) {
    case 'serve':
      return serve();
    case 'convert': {
      const out = option(args, '-o', '--out')[0];
      const zaps = option(args, '--zap');
      const file = args[0];
      if (!file) throw new InputError('Which file? migrate-to-n8n convert <file>');
      const text = readInput({ path: file });
      const results = detect(text) === 'make' ? [convertMake(text)] : convertZapier(text, { zaps });
      print(results, out ? resolvePath(out) : defaultOutputDir());
      return 0;
    }
    case 'list-zaps': {
      if (!args[0]) throw new InputError('Which file? migrate-to-n8n list-zaps <file>');
      for (const z of listZaps(readInput({ path: args[0] }))) console.log(`${z.title}  (id ${z.id || '—'}): ${z.steps} steps, ${z.paused ? 'off' : 'on'}; ${z.apps.join(', ')}`);
      return 0;
    }
    case 'supported': {
      const src = option(args, '--source')[0];
      if (src && src !== 'make' && src !== 'zapier') throw new InputError('--source is make or zapier.');
      const q = args.join(' ').trim().toLowerCase();
      const rows = allEntries(src as 'make' | 'zapier' | undefined).filter((e) => !q || `${e.key} ${e.label}`.toLowerCase().includes(q));
      for (const e of rows) console.log(`${e.source.padEnd(6)}  ${e.key.padEnd(44)}  → ${e.label}`);
      console.log(`\n${rows.length} automatic conversions. Anything else gets a suggestion and a placed node.`);
      return 0;
    }
    case 'check': {
      if (!args[0]) throw new InputError('Which file? migrate-to-n8n check <workflow.json>');
      let wf: unknown;
      try {
        wf = JSON.parse(readInput({ path: args[0] }).replace(/^﻿/, ''));
      } catch (e) {
        if (e instanceof InputError) throw e;
        throw new InputError('The file is not JSON.');
      }
      const issues = checkWorkflow(wf);
      for (const i of issues) console.log(`${i.level.padEnd(7)}  ${i.message}`);
      if (!issues.length) console.log('No problems found.');
      return issues.some((i) => i.level === 'error') ? 1 : 0;
    }
    case 'upload': {
      if (!args[0]) throw new InputError('Which file? migrate-to-n8n upload <workflow.json>');
      const cfg = uploadConfig();
      if (!cfg) throw new InputError('Set N8N_URL and N8N_API_KEY (n8n → Settings → n8n API) to upload.');
      const wf = readWorkflow({ path: args[0] });
      try {
        const r = await uploadWorkflow(wf, cfg);
        console.log(`Created in n8n (inactive): ${r.url}`);
        return 0;
      } catch (e) {
        throw new UploadFailure((e as Error).message);
      }
    }
    default:
      throw new InputError(`Unknown command "${cmd}". Run migrate-to-n8n --help.`);
  }
}

async function serve(): Promise<number> {
  await createServer().connect(new StdioServerTransport());
  return new Promise<number>(() => {}); // runs until the client closes stdin
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e) => {
    if (e instanceof InputError) { console.error(e.message); process.exitCode = 1; return; }
    if (e instanceof UploadFailure) { console.error(e.message); process.exitCode = 2; return; }
    console.error(`Something went wrong: ${(e as Error).message}\nPlease report it at https://github.com/kotiniiqq/migrate-to-n8n/issues`);
    process.exitCode = 1;
  },
);
