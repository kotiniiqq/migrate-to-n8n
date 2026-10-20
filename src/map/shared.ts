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

const METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'];

/** An HTTP method for the n8n HTTP Request node: a known verb, or an expression when the source used a formula. */
export function httpMethod(v: unknown, ctx: { expr(v: unknown): unknown; js(v: unknown): string; note(t: string, review?: boolean): void }, fallback = 'GET'): string {
  const s = str(v).trim();
  if (!s) return fallback;
  if (s.includes('{{')) return `={{ String(${ctx.js(s)}).toUpperCase() }}`;
  const m = s.toUpperCase();
  if (METHODS.includes(m)) return m;
  ctx.note(`The HTTP method "${m}" is not available in n8n; it is set to ${fallback}.`, true);
  return fallback;
}
