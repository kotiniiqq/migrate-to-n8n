/** The public corpus: Make blueprints and Zapier exports that people committed to GitHub.
 *  Used only locally to measure the converter; the files are never committed (they have no license).
 *
 *   npm run corpus -- download     # needs the GitHub CLI (gh), signed in
 *   npm run corpus -- stats        # converts everything in .corpus/ and prints the numbers
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkWorkflow } from '../src/build/check.ts';
import * as convert from '../src/convert.ts';
import { InputError, type ConversionResult } from '../src/types.ts';
import { catalogIssues } from '../test/helpers/n8n-types.ts';
import { computeStats, type CorpusRun } from './corpus-stats.ts';

const ROOT = '.corpus';
const QUERIES = {
  make: ['"orphans" "roundtrips" extension:json'],
  zapier: ['"selected_api" "root_id" extension:json', '"selected_api" "zaps" extension:json'],
};
// GitHub code search returns at most 1,000 results per query, so each query is split by file size.
const SIZES = ['<1500', '1500..3000', '3000..6000', '6000..12000', '12000..25000', '25000..60000', '>60000'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function search(q: string, page: number): { total: number; items: Array<{ html_url: string }> } {
  const out = execFileSync('gh', ['api', '-X', 'GET', 'search/code', '-f', `q=${q}`, '-f', 'per_page=100', '-f', `page=${page}`], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const json = JSON.parse(out);
  return { total: json.total_count, items: json.items ?? [] };
}

async function download(): Promise<void> {
  for (const [kind, queries] of Object.entries(QUERIES)) {
    const dir = join(ROOT, kind);
    mkdirSync(dir, { recursive: true });
    const seen = new Set<string>();
    for (const base of queries) {
      for (const size of SIZES) {
        for (let page = 1; page <= 10; page++) {
          let res;
          try {
            res = search(`${base} size:${size}`, page);
          } catch (e) {
            console.warn(`search failed (${(e as Error).message.split('\n')[0]}), waiting a minute`);
            await sleep(60_000);
            page--;
            continue;
          }
          await sleep(7_000); // code search allows about 10 requests a minute
          for (const item of res.items) {
            if (seen.has(item.html_url)) continue;
            seen.add(item.html_url);
            const raw = item.html_url.replace('https://github.com/', 'https://raw.githubusercontent.com/').replace('/blob/', '/');
            const r = await fetch(raw);
            if (!r.ok) continue;
            const text = await r.text();
            const file = join(dir, `${createHash('sha1').update(text).digest('hex').slice(0, 16)}.json`);
            if (!existsSync(file)) writeFileSync(file, text);
          }
          console.log(`${kind} ${size} page ${page}: ${res.items.length} (total ${res.total}); files: ${readdirSync(dir).length}`);
          if (res.items.length < 100 || page * 100 >= res.total) break;
        }
      }
    }
  }
}

function run(kind: 'make' | 'zapier'): { runs: CorpusRun[]; rejected: number } {
  const dir = join(ROOT, kind);
  const runs: CorpusRun[] = [];
  let rejected = 0;
  if (!existsSync(dir)) return { runs, rejected };
  const fn = kind === 'make' ? convert.convertMake : (convert as Record<string, unknown>).convertZapier as ((i: unknown) => ConversionResult[]) | undefined;
  if (!fn) return { runs, rejected };
  for (const f of readdirSync(dir)) {
    const text = readFileSync(join(dir, f), 'utf8');
    const t0 = performance.now();
    let results: ConversionResult[];
    try {
      const r = (fn as (i: unknown) => ConversionResult | ConversionResult[])(text);
      results = Array.isArray(r) ? r : [r];
    } catch (e) {
      if (e instanceof InputError) { rejected++; continue; }
      console.error(`${kind}/${f}: ${(e as Error).stack}`);
      rejected++;
      continue;
    }
    const ms = (performance.now() - t0) / Math.max(1, results.length);
    for (const res of results) {
      const checkErrors = checkWorkflow(res.workflow).filter((i) => i.level === 'error').length;
      const catalog = catalogIssues(res.workflow);
      if (checkErrors || catalog.length) console.warn(`${kind}/${f}: ${checkErrors} check errors; ${catalog.slice(0, 3).join(' | ')}`);
      runs.push({ report: res.report, ms, checkErrors, catalogErrors: catalog.length });
    }
  }
  return { runs, rejected };
}

function stats(): void {
  const all: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10) };
  for (const kind of ['make', 'zapier'] as const) {
    const { runs, rejected } = run(kind);
    if (!runs.length && !rejected) continue;
    const s = computeStats(runs, rejected);
    all[kind] = s;
    console.log(`\n== ${kind}: ${s.files} workflows (${s.rejected} files rejected), ${s.steps} steps`);
    console.log(`converted ${s.share.converted}% · review ${s.share.review}% · manual ${s.share.manual}% → converted or review: ${s.convertedOrReview}%`);
    console.log(`check errors in ${s.filesWithCheckErrors} files, catalog errors in ${s.filesWithCatalogErrors} files; ms p50 ${s.ms.p50.toFixed(1)} p95 ${s.ms.p95.toFixed(1)} max ${s.ms.max.toFixed(1)}`);
    console.log('top unmapped:', s.topUnmapped.slice(0, 40).map(([k, n]) => `${k} ${n}`).join(', '));
    console.log('top review:', s.topReview.map(([k, n]) => `${k} ${n}`).join(', '));
  }
  writeFileSync(join(ROOT, 'stats.json'), JSON.stringify(all, null, 2) + '\n');
}

const cmd = process.argv[2];
if (cmd === 'download') await download();
else if (cmd === 'stats') stats();
else console.log('usage: npm run corpus -- download | stats');
