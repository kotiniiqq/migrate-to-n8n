/** n8n's own node catalogs (fetched by `npm run n8n-types`), used to check what we emit. Test-only. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CATALOGS, catalogDir } from '../../scripts/fetch-n8n-types.ts';

export type N8nVersion = (typeof CATALOGS)[number]['n8n'];
export const N8N_VERSIONS: N8nVersion[] = CATALOGS.map((c) => c.n8n);

interface Description {
  name: string;
  version: number | number[];
  properties?: Array<Record<string, any>>;
  credentials?: Array<{ name: string }>;
}
export interface NodeType {
  /** One description per version group (n8n splits big nodes into versioned descriptions). */
  descriptions: Array<{ versions: number[]; properties: Array<Record<string, any>>; credentials: string[] }>;
  versions: number[];
}

const cache = new Map<N8nVersion, Map<string, NodeType>>();

function read(path: string): Description[] {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`n8n catalog missing at ${path}: run \`npm run n8n-types\` first`);
  }
}

export function loadCatalog(n8n: N8nVersion): Map<string, NodeType> {
  const hit = cache.get(n8n);
  if (hit) return hit;
  const pkgs = CATALOGS.find((c) => c.n8n === n8n)!.packages;
  const map = new Map<string, NodeType>();
  for (const [pkg, v] of Object.entries(pkgs)) {
    const prefix = `${pkg}.`; // the catalog lists bare names: `httpRequest`, `openAi`
    for (const d of read(join(catalogDir(pkg, v), 'nodes.json'))) {
      const type = `${prefix}${d.name}`;
      const versions = Array.isArray(d.version) ? d.version : [d.version];
      const entry = map.get(type) ?? { descriptions: [], versions: [] };
      entry.descriptions.push({ versions, properties: d.properties ?? [], credentials: (d.credentials ?? []).map((c) => c.name) });
      entry.versions.push(...versions);
      map.set(type, entry);
    }
  }
  cache.set(n8n, map);
  return map;
}

/** The highest typeVersion of `type` that every targeted n8n version knows. */
export function commonVersion(type: string): number {
  const sets = N8N_VERSIONS.map((v) => new Set(loadCatalog(v).get(type)?.versions ?? []));
  const shared = [...sets[0]].filter((x) => sets.every((s) => s.has(x)));
  if (!shared.length) throw new Error(`${type} is not available in every targeted n8n version`);
  return Math.max(...shared);
}

/** The description of `type` that covers `version` in the given n8n catalog. */
export function describe(n8n: N8nVersion, type: string, version: number) {
  const d = loadCatalog(n8n).get(type)?.descriptions.find((x) => x.versions.includes(version));
  if (!d) throw new Error(`${type}@${version} is not in n8n ${n8n}`);
  return d;
}
