/** Golden files: a stable copy of a conversion (random ids replaced) checked into the repo.
 *  Regenerate with UPDATE_GOLDEN=1 after reviewing the change. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ConversionResult } from '../../src/types.ts';

export function stable(r: ConversionResult): unknown {
  const ids = new Map<string, string>();
  const id = (v: string) => ids.get(v) ?? (ids.set(v, `id-${ids.size + 1}`), ids.get(v)!);
  return JSON.parse(JSON.stringify(r, (k, v) => {
    if ((k === 'id' || k === 'webhookId') && typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v)) return id(v);
    if (k === 'path' && typeof v === 'string' && /^scenario-[a-z0-9]{6}$/.test(v)) return 'scenario-random';
    return v;
  }));
}

export function assertGolden(file: URL, r: ConversionResult): void {
  const actual = stable(r);
  if (process.env.UPDATE_GOLDEN || !existsSync(file)) {
    mkdirSync(dirname(file.pathname.replace(/^\/([A-Za-z]:)/, '$1')), { recursive: true });
    writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
    return;
  }
  assert.deepEqual(actual, JSON.parse(readFileSync(file, 'utf8')));
}
