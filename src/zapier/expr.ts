/** Zapier field references → n8n expressions.
 *
 *  Zapier maps fields as `{{<step id>__<field>__<sub field>}}` (numbers are list positions, `a[]b` is "b of
 *  every a"), or with the newer `{{=gives['<step id>']['field']}}` form. A few `zap_meta_*` values describe
 *  the run. Anything else is kept as written and reported, never guessed. */
import { nodeRef } from '../util/names.ts';

export interface ZapierExprCtx {
  refName(stepId: string): string | undefined;
  refBase?(stepId: string, firstField?: string): { base: string; drop: number; note?: string } | undefined;
}

class Unsupported extends Error {}

type Seg = { k: 'prop'; name: string } | { k: 'index'; n: number } | { k: 'all' };

const IDENT = /^[A-Za-z_$][\w$]*$/;
const prop = (name: string) => (IDENT.test(name) ? `.${name}` : `['${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`);

/** Zapier gives an empty value when a field along the way is missing, so every step after the first is optional. */
function path(base: string, segs: Seg[]): string {
  let js = base;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const step = (plain: string) => (i ? `?.${plain.replace(/^\./, '')}` : plain);
    if (s.k === 'prop') js += step(prop(s.name));
    else if (s.k === 'index') js += step(`[${s.n}]`);
    else return `${js}${step('.map')}(e => ${path('e', segs.slice(i + 1))})`;
  }
  return js;
}

function ref(id: string, segs: Seg[], ctx: ZapierExprCtx, notes: string[]): string {
  const first = segs[0]?.k === 'prop' ? segs[0].name : undefined;
  let custom: { base: string; drop: number; note?: string } | undefined;
  try {
    custom = ctx.refBase?.(id, first);
  } catch (e) {
    throw new Unsupported((e as Error).message);
  }
  if (custom?.note && !notes.includes(custom.note)) notes.push(custom.note);
  if (custom) return path(custom.base, segs.slice(custom.drop));
  const name = ctx.refName(id);
  if (name === undefined) throw new Unsupported(`step ${id} is not in the converted workflow`);
  return path(`${nodeRef(name)}.item.json`, segs);
}

const META: Record<string, { js: string; note?: string }> = {
  zap_meta_utc_iso: { js: '$now.toUTC().toISO()' },
  zap_meta_timestamp: { js: 'Math.floor($now.toSeconds())' },
  zap_meta_id: { js: '$execution.id' },
  zap_meta_human_now: { js: "$now.toFormat('LLL d, yyyy, h:mm a')", note: 'Zapier\'s human-readable run date is approximated as "Oct 20, 2026, 9:00 AM".' },
  zap_meta_est_iso: { js: "$now.setZone('America/New_York').toISO()" },
};

/** One {{…}} body → JavaScript. */
function token(body: string, ctx: ZapierExprCtx, notes: string[]): string {
  const t = body.trim();
  if (Object.hasOwn(META, t)) {
    if (META[t].note) notes.push(META[t].note!);
    return META[t].js;
  }
  // {{=gives['1']['a']['b']}} / {{=output["1"]["a"]}}
  const bracket = /^=\s*(?:gives|output)((?:\[\s*(?:'[^']*'|"[^"]*")\s*\])+)\s*$/.exec(t);
  if (bracket) {
    const keys = [...bracket[1].matchAll(/\[\s*(?:'([^']*)'|"([^"]*)")\s*\]/g)].map((m) => m[1] ?? m[2]);
    const [id, ...rest] = keys;
    return ref(id, rest.map((name) => ({ k: 'prop', name }) as Seg), ctx, notes);
  }
  if (t.startsWith('=')) throw new Unsupported('custom JavaScript in a Zapier field');
  // {{1__a__b}}, {{1__list__0}}, {{1__choices[]text}}
  const m = /^(\d+)__(.+)$/s.exec(t);
  if (!m) throw new Unsupported(`unknown field "${t}"`);
  const segs: Seg[] = [];
  for (const part of m[2].split('__')) {
    const pieces = part.split('[]');
    pieces.forEach((p, i) => {
      if (i > 0) segs.push({ k: 'all' });
      if (p === '') return;
      if (/^\d+$/.test(p) && segs.length) segs.push({ k: 'index', n: Number(p) });
      else segs.push({ k: 'prop', name: p });
    });
  }
  return ref(m[1], segs, ctx, notes);
}

function split(src: string): Array<{ text: string } | { expr: string }> {
  const parts: Array<{ text: string } | { expr: string }> = [];
  const re = /\{\{([\s\S]*?)\}\}/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) parts.push({ text: src.slice(last, m.index) });
    parts.push({ expr: m[1] });
    last = m.index + m[0].length;
  }
  if (last < src.length) parts.push({ text: src.slice(last) });
  return parts;
}

export function translateZapierExpr(value: string, ctx: ZapierExprCtx): { value: string; ok: boolean; notes: string[] } {
  const parts = split(value);
  if (!parts.some((p) => 'expr' in p)) return { value, ok: true, notes: [] };
  const notes: string[] = [];
  try {
    const out = parts.map((p) => ('text' in p ? p.text : `{{ ${token(p.expr, ctx, notes)} }}`)).join('');
    return { value: `=${out}`, ok: notes.length === 0, notes: notes.map((n) => `${n} Original: ${value}`) };
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e;
    return { value, ok: false, notes: [`Field not translated (${e.message}): ${value}`] };
  }
}

export function translateZapierJs(value: string, ctx: ZapierExprCtx): { js: string; ok: boolean; notes: string[] } {
  const parts = split(value);
  const notes: string[] = [];
  try {
    const out = parts.map((p) => ('text' in p ? JSON.stringify(p.text) : parts.length > 1 ? `String(${token(p.expr, ctx, notes)})` : token(p.expr, ctx, notes)));
    return { js: out.join(' + ') || '""', ok: notes.length === 0, notes: notes.map((n) => `${n} Original: ${value}`) };
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e;
    return { js: JSON.stringify(value), ok: false, notes: [`Field not translated (${e.message}): ${value}`] };
  }
}
