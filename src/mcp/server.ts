/** The MCP server: the converter as tools for Claude, Cursor, VS Code and other MCP clients. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { checkWorkflow } from '../build/check.ts';
import { convertMake, convertZapier, defaultOutputDir, writeResult } from '../convert.ts';
import { readInput, readWorkflow, resolvePath } from '../io.ts';
import { N8N_APPS } from '../map/n8n-apps.ts';
import { allEntries } from '../map/registry.ts';
import { describeModule } from '../map/suggest.ts';
import { uploadConfig, uploadWorkflow } from '../n8n/upload.ts';
import { renderMarkdown } from '../report/render.ts';
import { InputError, type ConversionResult } from '../types.ts';
import { VERSION } from '../version.ts';
import { listZaps } from '../zapier/parse.ts';

type Text = { content: Array<{ type: 'text'; text: string }>; isError?: true };
const ok = (text: string): Text => ({ content: [{ type: 'text', text }] });
const fail = (text: string): Text => ({ content: [{ type: 'text', text }], isError: true });

/** Run a tool body; a problem with the input (or anything else) is a plain message, never a stack trace. */
async function guard(fn: () => Text | Promise<Text>): Promise<Text> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof InputError) return fail(e.message);
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EACCES' || err.code === 'EPERM') return fail(`No permission to write there: ${err.path ?? ''}. Choose another outputDir.`);
    return fail(`Something went wrong: ${err.message}. Please report it at https://github.com/kotiniiqq/migrate-to-n8n/issues`);
  }
}

const INSTRUCTIONS = [
  'migrate-to-n8n converts Make (Integromat) scenarios and Zapier zaps into n8n workflows.',
  'Make: the user exports the scenario as a blueprint (scenario → "..." → Export Blueprint). Zapier: Settings → Security and data → Download my Zap workflows.',
  'After converting, show the totals line and the next steps, then help the user finish the steps marked review or manual: each has a concrete suggestion.',
  'Never claim a step works if the report marks it review or manual.',
].join(' ');

function report(results: ConversionResult[], dir: string, canUpload: boolean): string {
  return results.map((res) => {
    const files = writeResult(res, dir);
    return [
      renderMarkdown(res.report),
      '## Files',
      '',
      `- Workflow: ${files.workflowPath}`,
      `- Report: ${files.reportPath}`,
      '',
      `Import in n8n: Workflows → Import from File → ${files.workflowPath}${canUpload ? ' (or upload it with upload_to_n8n).' : '.'}`,
    ].join('\n');
  }).join('\n\n---\n\n');
}

const source = { path: z.string().optional().describe('Path to the exported file on this computer'), json: z.string().optional().describe('The exported file contents, when the user pasted or attached it') };
const outputDir = z.string().optional().describe('Folder for the results (default: Documents/migrate-to-n8n)');

export function createServer(opts: { env?: Record<string, string | undefined> } = {}): McpServer {
  const env = opts.env ?? process.env;
  const upload = uploadConfig(env);
  const server = new McpServer({ name: 'migrate-to-n8n', version: VERSION }, { instructions: INSTRUCTIONS });
  const outDir = (dir?: string) => (dir?.trim() ? resolvePath(dir) : defaultOutputDir(env));

  server.registerTool('convert_make', {
    title: 'Convert a Make scenario to n8n',
    description: 'Convert a Make (Integromat) scenario blueprint into an n8n workflow. Writes <name>.n8n.json (import it in n8n) and a report, and returns the report: what converted, what to check, and a concrete suggestion for every step that needs finishing by hand. Pass the file path, or the JSON when the user attached the file.',
    inputSchema: { ...source, outputDir },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => guard(() => ok(report([convertMake(readInput(args))], outDir(args.outputDir), !!upload))));

  server.registerTool('convert_zapier', {
    title: 'Convert Zapier zaps to n8n',
    description: 'Convert zaps from a Zapier export (Settings → Security and data → Download my Zap workflows) into n8n workflows, one file and report per zap. Use list_zaps first when the export has many zaps, then pass their titles or ids in "zaps".',
    inputSchema: { ...source, zaps: z.array(z.string()).optional().describe('Zap titles or ids to convert (default: all)'), outputDir },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => guard(() => ok(report(convertZapier(readInput(args), { zaps: args.zaps }), outDir(args.outputDir), !!upload))));

  server.registerTool('list_zaps', {
    title: 'List the zaps in a Zapier export',
    description: 'List the zaps in a Zapier export with their id, title, number of steps, apps used and on/off state, so the user can choose what to convert.',
    inputSchema: source,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => guard(() => {
    const zaps = listZaps(readInput(args));
    return ok([`${zaps.length} zap${zaps.length === 1 ? '' : 's'}:`, '', ...zaps.map((z) => `- **${z.title}** (id ${z.id || '—'}): ${z.steps} steps, ${z.paused ? 'off' : 'on'}; apps: ${z.apps.join(', ')}`)].join('\n'));
  }));

  server.registerTool('suggest_replacement', {
    title: 'How to replace a Make module or Zapier step',
    description: 'Explain how one Make module key (e.g. "slack:CreateMessage") or Zapier step key (e.g. "SlackCLIAPI:channel_message") is handled: converted automatically, or which n8n node, API or Code node to use instead.',
    inputSchema: { source: z.enum(['make', 'zapier']), module: z.string().describe('The module or step key as it appears in the export or report') },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => guard(() => ok(describeModule(args.source, args.module.trim()))));

  server.registerTool('supported_modules', {
    title: 'What converts automatically',
    description: 'Search the modules and steps that convert automatically (optionally filtered by source and text). Everything else still gets a suggestion and a placed n8n node in the report.',
    inputSchema: { source: z.enum(['make', 'zapier']).optional(), query: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => guard(() => {
    const q = args.query?.trim().toLowerCase();
    const rows = allEntries(args.source).filter((e) => !q || `${e.key} ${e.label}`.toLowerCase().includes(q));
    const lines = rows.map((e) => `| ${e.source === 'make' ? 'Make' : 'Zapier'} | \`${e.key}\` | ${e.label} |`);
    return ok([`${rows.length} automatic conversion${rows.length === 1 ? '' : 's'}${q ? ` matching "${args.query}"` : ''}.`, '', '| Source | Module / step | Becomes in n8n |', '|---|---|---|', ...lines, '', `Anything else gets the closest of ${N8N_APPS.length} n8n app nodes, an HTTP Request, or a Code node, placed disabled with a suggestion.`].join('\n'));
  }));

  server.registerTool('check_n8n_workflow', {
    title: 'Check an n8n workflow file',
    description: 'Check an n8n workflow JSON (for example after finishing steps by hand): broken connections, duplicate names, disabled steps left, REPLACE-ME placeholders and credentials still to pick.',
    inputSchema: source,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => guard(() => {
    let wf: unknown;
    try {
      wf = JSON.parse(readInput(args).replace(/^﻿/, ''));
    } catch (e) {
      if (e instanceof InputError) throw e;
      throw new InputError('This is not JSON: pass an n8n workflow file.');
    }
    const issues = checkWorkflow(wf);
    if (!issues.length) return ok('No problems found.');
    const icon = { error: '❌', warning: '⚠️', info: 'ℹ️' } as const;
    return ok(issues.map((i) => `${icon[i.level]} ${i.message}`).join('\n'));
  }));

  if (upload) {
    server.registerTool('upload_to_n8n', {
      title: 'Upload a converted workflow to n8n',
      description: `Create a converted workflow (a .n8n.json file) in the user's n8n at ${upload.url}. It is created inactive with " (migrated)" in its name; nothing existing is changed. Returns the link.`,
      inputSchema: { path: z.string().describe('Path of the .n8n.json file written by convert_make or convert_zapier') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async (args) => guard(async () => {
      const wf = readWorkflow({ path: args.path });
      try {
        const r = await uploadWorkflow(wf, upload);
        return ok(`Created in n8n (inactive): ${r.url}\nOpen it, connect the credentials, finish the steps marked ⚠, test it, then activate it.`);
      } catch (e) {
        throw new InputError((e as Error).message);
      }
    }));
  }
  return server;
}
