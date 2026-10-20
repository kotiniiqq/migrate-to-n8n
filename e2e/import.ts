/** Every conversion must import into real n8n: all fixtures and a corpus sample, into n8n 2.x and 1.x.
 *
 *   docker compose -f docker-compose.e2e.yml up -d && npm run e2e
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { convertMake, convertZapier } from '../src/convert.ts';
import { uploadWorkflow } from '../src/n8n/upload.ts';
import type { ConversionResult } from '../src/types.ts';
import { api, apiKey, INSTANCES, waitReady } from './n8n.ts';

const SAMPLE = Number(process.env.E2E_CORPUS_SAMPLE ?? 200);

function inputs(): Array<{ name: string; results: ConversionResult[] }> {
  const out: Array<{ name: string; results: ConversionResult[] }> = [];
  for (const f of readdirSync('test/fixtures/make')) out.push({ name: `make/${f}`, results: [convertMake(readFileSync(join('test/fixtures/make', f), 'utf8'))] });
  for (const f of readdirSync('test/fixtures/zapier')) out.push({ name: `zapier/${f}`, results: convertZapier(readFileSync(join('test/fixtures/zapier', f), 'utf8')) });
  for (const kind of ['make', 'zapier'] as const) {
    const dir = join('.corpus', kind);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).sort().slice(0, SAMPLE);
    for (const f of files) {
      try {
        const text = readFileSync(join(dir, f), 'utf8');
        out.push({ name: `corpus/${kind}/${f}`, results: kind === 'make' ? [convertMake(text)] : convertZapier(text) });
      } catch {
        // not a blueprint/export: the corpus run counts those
      }
    }
  }
  return out;
}

let failures = 0;
const all = inputs();
const total = all.reduce((n, x) => n + x.results.length, 0);
for (const inst of INSTANCES) {
  await waitReady(inst.url);
  const key = await apiKey(inst.url);
  let ok = 0;
  const created: string[] = [];
  for (const { name, results } of all) {
    for (const res of results) {
      try {
        const r = await uploadWorkflow(res.workflow, { url: inst.url, apiKey: key });
        created.push(r.id);
        const back = await api(inst.url, key, 'GET', `/workflows/${r.id}`);
        const want = res.workflow.nodes.map((n) => n.name).sort();
        const got = (back.nodes as Array<{ name: string }>).map((n) => n.name).sort();
        if (JSON.stringify(want) !== JSON.stringify(got)) throw new Error(`node names changed: ${want.length} → ${got.length}`);
        ok++;
      } catch (e) {
        failures++;
        console.error(`${inst.name}: ${name} (${res.workflow.name}): ${(e as Error).message}`);
      }
    }
  }
  for (const id of created) await api(inst.url, key, 'DELETE', `/workflows/${id}`).catch(() => {});
  console.log(`${inst.name}: ${ok}/${total} workflows imported and read back`);
}
if (failures) {
  console.error(`${failures} import failure(s)`);
  process.exit(1);
}
