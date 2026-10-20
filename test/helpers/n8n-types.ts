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

type Prop = Record<string, any>;

function versionMatches(cond: unknown, version: number): boolean {
  if (typeof cond === 'number') return cond === version;
  const c = (cond as { _cnd?: Record<string, any> })?._cnd;
  if (!c) return false;
  if ('between' in c) return version >= c.between.from && version <= c.between.to;
  if ('gte' in c) return version >= c.gte;
  if ('lte' in c) return version <= c.lte;
  if ('gt' in c) return version > c.gt;
  if ('lt' in c) return version < c.lt;
  if ('eq' in c) return version === c.eq;
  return false;
}

/** n8n's displayOptions rule: is `prop` shown for these parameter values? */
function isShown(prop: Prop, params: Record<string, unknown>, props: Prop[], version: number): boolean {
  const value = (name: string) => (name in params ? params[name] : props.find((p) => p.name === name)?.default);
  const matches = (name: string, allowed: unknown[]) => {
    if (name === '@version') return allowed.some((a) => versionMatches(a, version));
    if (name.startsWith('@') || name.startsWith('/')) return true;
    const v = value(name);
    return allowed.some((a) => (a && typeof a === 'object' && '_cnd' in (a as object) ? true : a === v));
  };
  const show = prop.displayOptions?.show as Record<string, unknown[]> | undefined;
  const hide = prop.displayOptions?.hide as Record<string, unknown[]> | undefined;
  if (show && !Object.entries(show).every(([k, a]) => matches(k, a))) return false;
  if (hide && Object.entries(hide).some(([k, a]) => matches(k, a))) return false;
  return true;
}

const isExpression = (v: unknown) => typeof v === 'string' && v.startsWith('=');

/** Problems with one node against n8n's own description of it, in one targeted n8n version. */
export function nodeIssues(n8n: N8nVersion, node: { name: string; type: string; typeVersion: number; parameters: Record<string, unknown> }): string[] {
  const where = `${node.name} (${node.type}@${node.typeVersion}, n8n ${n8n})`;
  let d;
  try {
    d = describe(n8n, node.type, node.typeVersion);
  } catch (e) {
    return [`${where}: ${(e as Error).message}`];
  }
  const issues: string[] = [];
  for (const [key, value] of Object.entries(node.parameters)) {
    const candidates = d.properties.filter((p) => p.name === key);
    if (!candidates.length) { issues.push(`${where}: unknown parameter "${key}"`); continue; }
    const visible = candidates.filter((p) => isShown(p, node.parameters, d.properties, node.typeVersion));
    if (!visible.length) { issues.push(`${where}: parameter "${key}" is hidden by its display rules`); continue; }
    const p = visible[0];
    if (p.type === 'options' && !isExpression(value)) {
      const allowed = (p.options ?? []).map((o: Prop) => o.value);
      if (!allowed.includes(value)) issues.push(`${where}: "${key}" = ${JSON.stringify(value)} is not one of ${JSON.stringify(allowed)}`);
    }
    if ((p.type === 'collection' || p.type === 'fixedCollection') && value && typeof value === 'object' && !Array.isArray(value)) {
      const names = (p.options ?? []).map((o: Prop) => o.name);
      for (const k of Object.keys(value)) if (!names.includes(k)) issues.push(`${where}: "${key}.${k}" is not an option of ${key}`);
    }
  }
  return issues;
}

/** Every node of a workflow checked against both targeted n8n versions. */
export function catalogIssues(workflow: { nodes: Array<{ name: string; type: string; typeVersion: number; parameters: Record<string, unknown> }> }): string[] {
  return N8N_VERSIONS.flatMap((v) => workflow.nodes.flatMap((n) => nodeIssues(v, n)));
}
