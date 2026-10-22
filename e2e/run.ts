/** Converted workflows must also *run* the same as in Make: scenarios without external apps are activated on
 *  real n8n and called through their webhook; the answers must equal what Make would return. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { convertMake } from '../src/convert.ts';
import { uploadWorkflow } from '../src/n8n/upload.ts';
import { activate, api, apiKey, cleanup, INSTANCES, waitReady } from './n8n.ts';

interface Case {
  fixture: string;
  calls: Array<{ body: unknown; status: number; expect: (text: string) => void }>;
}

const CASES: Case[] = [
  {
    fixture: 'test/e2e/make-formulas.json',
    calls: [
      {
        body: { name: 'anna', date: '2026-10-20', price: 10.5, kind: 'a', tags: ['x', 'y'] },
        status: 200,
        expect: (t) => assert.deepEqual(JSON.parse(t), { route: 'a', greeting: 'Hi ANNA, 20.10.2026, total 12.6', items: 2 }),
      },
      { body: { name: 'bob', date: '2026-01-02', price: 150, kind: 'z', tags: [] }, status: 201, expect: (t) => assert.deepEqual(JSON.parse(t), { route: 'b' }) },
    ],
  },
  {
    // A real export from Make (2026-10-21): routers with OR/AND filters, variables, Switch, error handlers.
    fixture: 'test/fixtures/make/owner-hard-cases.json',
    calls: [
      {
        body: { kind: 'info', force: false, items: [], date: '20.10.2026', vip: true, name: 'anna', email: 'anna@example.org', meta: '{"status": "new"}' },
        status: 200,
        expect: (t) => assert.deepEqual(JSON.parse(t), { state: 'Fresh', domain: 'example.org' }),
      },
    ],
  },
  {
    fixture: 'test/e2e/make-iterator.json',
    calls: [{ body: { items: [{ name: 'a', price: 1 }, { name: 'b', price: 2.5 }] }, status: 200, expect: (t) => assert.equal(t, 'a: 2, b: 5') }],
  },
  {
    // Parse CSV gives one item per row (a quoted field keeps its comma); Parse XML reads elements by name.
    fixture: 'test/e2e/make-csv-xml.json',
    calls: [{
      body: { csv: 'name,qty\n"pen, blue",2\npaper,10\n', xml: '<order id="7"><customer>Anna</customer></order>' },
      status: 200,
      expect: (t) => assert.equal(t, 'pen, blue x2, paper x10 | Anna'),
    }],
  },
];

let failures = 0;
for (const inst of INSTANCES) {
  await waitReady(inst.url);
  const key = await apiKey(inst.url);
  await cleanup(inst.url, key);
  for (const c of CASES) {
    const res = convertMake(readFileSync(c.fixture, 'utf8'));
    const { id } = await uploadWorkflow(res.workflow, { url: inst.url, apiKey: key });
    try {
      await activate(inst.url, key, id);
      const path = res.report.webhooks[0].path;
      for (const call of c.calls) {
        const r = await fetch(`${inst.url}/webhook/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(call.body) });
        const text = await r.text();
        try {
          assert.equal(r.status, call.status, text);
          call.expect(text);
          console.log(`${inst.name}: ${res.workflow.name} ${JSON.stringify(call.body).slice(0, 40)}… → ${r.status} ${text.slice(0, 80)}`);
        } catch (e) {
          failures++;
          console.error(`${inst.name}: ${res.workflow.name}: ${(e as Error).message}`);
        }
      }
    } finally {
      await api(inst.url, key, 'POST', `/workflows/${id}/deactivate`).catch(() => {});
      await api(inst.url, key, 'DELETE', `/workflows/${id}`).catch(() => {});
    }
  }
}
if (failures) {
  console.error(`${failures} run failure(s)`);
  process.exit(1);
}
console.log('all runs matched');
