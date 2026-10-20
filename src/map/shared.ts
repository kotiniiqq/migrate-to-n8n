/** Small helpers shared by the app mappings. */
import { nodeRef } from '../util/names.ts';
import type { MapOutput } from './registry.ts';

export const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

/** An n8n resource locator ("From list / By ID / By URL / By name" fields). */
export const rl = (mode: 'id' | 'url' | 'name' | 'list', value: unknown) => ({ __rl: true, mode, value });

/** Reading an app node's output: same path, but flagged, because n8n's field names may differ from the source's. */
export function appRef(app: string): NonNullable<MapOutput['ref']> {
  return (out) => ({ base: `${nodeRef(out)}.item.json`, drop: 0, note: `Check the fields read from "${out}": the n8n ${app} node may name them differently.` });
}

const JS_STRING = /^"(?:[^"\\]|\\.)*"$/;

/** `prefix + <js> + suffix` as a URL: plain text when the value is known now, else an expression. */
export function urlWith(prefix: string, js: string, suffix = ''): string {
  if (JS_STRING.test(js)) return `${prefix}${encodeURIComponent(JSON.parse(js) as string).replace(/%2F/gi, '/')}${suffix}`;
  return `={{ '${prefix}' + encodeURIComponent(${js}) + '${suffix}' }}`;
}
