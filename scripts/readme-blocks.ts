/** The generated parts of README.md: the supported-modules tables (from the mapping table) and the corpus numbers
 *  (from docs/corpus-stats.json, written by `npm run corpus -- stats`). A test checks they are up to date.
 *
 *   npm run readme
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import '../src/convert.ts';
import { allEntries } from '../src/map/registry.ts';

const esc = (s: string) => s.replace(/\|/g, '\\|');

export function supportedBlock(): string {
  const part = (source: 'make' | 'zapier', title: string) => {
    const rows = allEntries(source).sort((a, b) => a.key.localeCompare(b.key));
    return [
      `<details>`,
      `<summary><b>${title}</b>: ${rows.length} modules and steps convert automatically</summary>`,
      '',
      '| Module / step | Becomes in n8n |',
      '|---|---|',
      ...rows.map((e) => `| \`${esc(e.key)}\` | ${esc(e.label)} |`),
      '',
      '</details>',
    ].join('\n');
  };
  return [part('make', 'Make'), '', part('zapier', 'Zapier')].join('\n');
}

interface SourceStats { files: number; steps: number; share: { converted: number; review: number; manual: number }; convertedOrReview: number; filesWithCheckErrors: number; filesWithCatalogErrors: number; ms: { p50: number; max: number } }
interface Stats { date: string; make?: SourceStats; zapier?: SourceStats }

export function corpusBlock(stats: Stats): string {
  const row = (name: string, s?: SourceStats) =>
    s ? `| ${name} | ${s.files.toLocaleString('en')} | ${s.steps.toLocaleString('en')} | ${s.share.converted}% | ${s.share.review}% | ${s.share.manual}% | ${s.filesWithCheckErrors + s.filesWithCatalogErrors} | ${s.ms.p50.toFixed(1)} ms |` : '';
  const rows = [row('Make', stats.make), row('Zapier', stats.zapier)].filter(Boolean);
  return [
    `Measured on ${stats.date} on the public Make blueprints and Zapier exports found on GitHub:`,
    '',
    '| Source | Workflows | Steps | ✅ Converted | ⚠️ To review | 🛠 Manual | Broken outputs | Time (median) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...rows,
  ].join('\n');
}

export function replaceBlock(text: string, name: string, body: string): string {
  const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
  if (!re.test(text)) throw new Error(`README has no ${name} block`);
  return text.replace(re, `$1\n${body}\n$2`);
}

export function render(readme: string): string {
  const stats = JSON.parse(readFileSync('docs/corpus-stats.json', 'utf8')) as Stats;
  return replaceBlock(replaceBlock(readme, 'supported', supportedBlock()), 'corpus', corpusBlock(stats));
}

if (process.argv[1]?.endsWith('readme-blocks.ts')) {
  if (existsSync('.corpus/stats.json')) {
    const s = JSON.parse(readFileSync('.corpus/stats.json', 'utf8'));
    const keep = (x: SourceStats | undefined) => x && { files: x.files, steps: x.steps, share: x.share, convertedOrReview: x.convertedOrReview, filesWithCheckErrors: x.filesWithCheckErrors, filesWithCatalogErrors: x.filesWithCatalogErrors, ms: { p50: x.ms.p50, max: x.ms.max } };
    writeFileSync('docs/corpus-stats.json', JSON.stringify({ date: s.date, make: keep(s.make), zapier: keep(s.zapier) }, null, 2) + '\n');
  }
  writeFileSync('README.md', render(readFileSync('README.md', 'utf8')));
  console.log('README.md updated');
}
