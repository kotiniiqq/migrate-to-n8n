/** The MCP server: the converter as tools for Claude, Cursor, VS Code and other MCP clients. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { checkWorkflow } from '../build/check.ts';
import { convertMake, convertZapier, defaultOutputDir, homePath, writeResult } from '../convert.ts';
import { readInput, readWorkflow } from '../io.ts';
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

const source = {
  path: z.string().optional().describe('Absolute path of the exported file on this computer (~ is the home folder). Give either path or json, not both.'),
  json: z.string().optional().describe('The full contents of the exported file, when the user pasted or attached it instead of giving a path. Give either path or json, not both.'),
};
const outputDir = z.string().optional().describe('Folder to write the results to; created if missing; existing files are kept and the new ones get " (2)", " (3)"… in their name. Default: Documents/migrate-to-n8n in the home folder.');
const sourceKind = z.enum(['make', 'zapier']);

export function createServer(opts: { env?: Record<string, string | undefined> } = {}): McpServer {
  const env = opts.env ?? process.env;
  const upload = uploadConfig(env);
  const server = new McpServer({ name: 'migrate-to-n8n', version: VERSION }, { instructions: INSTRUCTIONS });
  const outDir = (dir?: string) => (dir?.trim() ? homePath(dir) : defaultOutputDir(env));

  server.registerTool('convert_make', {
    title: 'Convert a Make scenario to n8n',
    description: [
      'Convert one Make (Integromat) scenario blueprint (the .json from Export Blueprint) into an n8n workflow. Runs locally; nothing is sent anywhere.',
      'Writes <scenario name>.n8n.json (import it in n8n), plus the report as Markdown and JSON, to outputDir.',
      'Returns the report: totals (converted / to review / manual), every step with its n8n node and status, a concrete suggestion for each step to finish by hand, the credentials and webhook URLs to set up, and the paths of the files.',
      'For Zapier exports use convert_zapier instead. Afterwards, upload_to_n8n (when configured) creates the workflow in n8n, and check_n8n_workflow re-checks a file after manual edits.',
    ].join(' '),
    inputSchema: { ...source, outputDir },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => guard(() => ok(report([convertMake(readInput(args))], outDir(args.outputDir), !!upload))));

  server.registerTool('convert_zapier', {
    title: 'Convert Zapier zaps to n8n',
    description: [
      'Convert zaps from a Zapier export (Settings → Security and data → Download my Zap workflows; one JSON file holds all zaps) into n8n workflows. Runs locally; nothing is sent anywhere.',
      'Writes one <zap title>.n8n.json plus a Markdown and JSON report per zap to outputDir, and returns the reports: totals, every step with its n8n node and status, suggestions for the steps to finish by hand, and the file paths.',
      'When the export holds many zaps, call list_zaps first and pass the chosen titles or ids in "zaps". For Make blueprints use convert_make instead.',
    ].join(' '),
    inputSchema: { ...source, zaps: z.array(z.string()).optional().describe('Titles or ids of the zaps to convert, as list_zaps shows them; titles match without regard to case. Leave out to convert every zap in the export.'), outputDir },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => guard(() => ok(report(convertZapier(readInput(args), { zaps: args.zaps }), outDir(args.outputDir), !!upload))));

  server.registerTool('list_zaps', {
    title: 'List the zaps in a Zapier export',
    description: 'List the zaps in a Zapier export without converting anything: id, title, number of steps, apps used and on/off state of each. Use it before convert_zapier when the export holds more than a few zaps, so the user can choose which ones to convert. Reads the file only; writes nothing.',
    inputSchema: source,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => guard(() => {
    const zaps = listZaps(readInput(args));
    return ok([`${zaps.length} zap${zaps.length === 1 ? '' : 's'}:`, '', ...zaps.map((z) => `- **${z.title}** (id ${z.id || '—'}): ${z.steps} steps, ${z.paused ? 'off' : 'on'}; apps: ${z.apps.join(', ')}`)].join('\n'));
  }));

  server.registerTool('suggest_replacement', {
    title: 'How to replace a Make module or Zapier step',
    description: 'Explain how one Make module or Zapier step is handled, without converting a file: whether it converts automatically and to which n8n node, or which n8n app node, HTTP request to the app\'s API, or Code node to use instead, with the steps to set it up. Use it when the user asks about a single module, or to explain a step a report marked review or manual.',
    inputSchema: {
      source: sourceKind.describe('Where the module comes from: "make" or "zapier".'),
      module: z.string().describe('The module or step key exactly as the export or the report shows it, e.g. "slack:CreateMessage" for Make or "SlackCLIAPI:channel_message" for Zapier.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => guard(() => ok(describeModule(args.source, args.module.trim()))));

  server.registerTool('supported_modules', {
    title: 'What converts automatically',
    description: 'List the Make modules and Zapier steps that convert automatically, as a table of module key and the n8n node it becomes. Use it to answer "does X convert?" before the user exports anything; for one known key, suggest_replacement gives more detail. Modules not listed still convert to a placed, disabled n8n node with a suggestion.',
    inputSchema: {
      source: sourceKind.optional().describe('Only "make" or only "zapier". Leave out for both.'),
      query: z.string().optional().describe('Text to look for in the module key or the n8n node name, without regard to case, e.g. "sheets" or "slack". Leave out to list everything.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => guard(() => {
    const q = args.query?.trim().toLowerCase();
    const rows = allEntries(args.source).filter((e) => !q || `${e.key} ${e.label}`.toLowerCase().includes(q));
    const lines = rows.map((e) => `| ${e.source === 'make' ? 'Make' : 'Zapier'} | \`${e.key}\` | ${e.label} |`);
    return ok([`${rows.length} automatic conversion${rows.length === 1 ? '' : 's'}${q ? ` matching "${args.query}"` : ''}.`, '', '| Source | Module / step | Becomes in n8n |', '|---|---|---|', ...lines, '', `Anything else gets the closest of ${N8N_APPS.length} n8n app nodes, an HTTP Request, or a Code node, placed disabled with a suggestion.`].join('\n'));
  }));

  server.registerTool('check_n8n_workflow', {
    title: 'Check an n8n workflow file',
    description: 'Check an n8n workflow JSON file for problems that stop it from importing or running: broken connections, duplicate node names, disabled steps left, REPLACE-ME placeholders and credentials still to pick. Use it after the user finished steps by hand, or on any n8n workflow. Returns one line per problem (error, warning or info), or "No problems found". Reads the file only; writes nothing.',
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
      description: `Create a converted workflow (a .n8n.json file) as a new workflow in the user's n8n at ${upload.url}, through the n8n API. It is created inactive with " (migrated)" in its name; existing workflows are never changed, and calling it twice creates two copies. Returns the link to open it. Use it after convert_make or convert_zapier when the user wants the result in n8n without importing it by hand.`,
      inputSchema: { path: z.string().describe('Path of the .n8n.json file that convert_make or convert_zapier wrote (shown under "Files" in their result).') },
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
