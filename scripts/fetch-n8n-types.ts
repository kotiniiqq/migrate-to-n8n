/** Download n8n's node and credential catalogs for the two n8n versions we target, for tests only.
 *  The catalogs are under n8n's Sustainable Use License, so they stay in .cache and never ship.
 *
 *   npm run n8n-types
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const CATALOGS = [
  { n8n: '2.44.4', packages: { 'n8n-nodes-base': '2.44.2', '@n8n/n8n-nodes-langchain': '2.44.2' } },
  { n8n: '1.123.85', packages: { 'n8n-nodes-base': '1.121.55', '@n8n/n8n-nodes-langchain': '1.122.60' } },
] as const;

const WANTED = ['package/dist/types/nodes.json', 'package/dist/types/credentials.json'];

/** Pull the named files out of a .tgz without a tar dependency (ustar: 512-byte headers). */
function untar(tgz: Buffer, wanted: string[]): Map<string, Buffer> {
  const tar = gunzipSync(tgz);
  const out = new Map<string, Buffer>();
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (s: number, l: number) => header.subarray(s, s + l).toString('utf8').replace(/\0.*$/s, '');
    const prefix = field(345, 155);
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156]);
    const body = tar.subarray(off + 512, off + 512 + size);
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (wanted.includes(name)) out.set(name, Buffer.from(body));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

export function catalogDir(pkg: string, version: string): string {
  return join('.cache', 'n8n-types', pkg.replace('/', '__'), version);
}

async function fetchOne(pkg: string, version: string): Promise<void> {
  const dir = catalogDir(pkg, version);
  if (existsSync(join(dir, 'nodes.json'))) return;
  const base = pkg.split('/').pop();
  const url = `https://registry.npmjs.org/${pkg}/-/${base}-${version}.tgz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const files = untar(Buffer.from(await res.arrayBuffer()), WANTED);
  mkdirSync(dir, { recursive: true });
  for (const want of WANTED) {
    const data = files.get(want);
    if (!data) throw new Error(`${pkg}@${version}: ${want} not found in the package`);
    writeFileSync(join(dir, want.split('/').pop()!), data);
  }
  console.log(`${pkg}@${version}: saved to ${dir}`);
}

for (const c of CATALOGS) for (const [pkg, v] of Object.entries(c.packages)) await fetchOne(pkg, v);
