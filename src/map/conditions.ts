/** Source filter conditions (OR of AND groups) → the parameters of an n8n Filter or If node.
 *
 *  One AND group, or several single conditions joined by OR, use n8n's own condition rows. Anything n8n's
 *  single combinator cannot express (OR of AND groups, mixed case sensitivity) becomes one boolean condition
 *  built from JavaScript, so the logic stays exactly the same. */
import { randomUUID } from 'node:crypto';

import type { ConditionGroup } from '../types.ts';
import type { MapCtx } from './registry.ts';

export interface OpSpec {
  type: 'string' | 'number' | 'dateTime' | 'boolean' | 'array';
  operation: string;
  single?: boolean;
  ci?: boolean;
  /** The same test as JavaScript, given the left and right expressions. */
  js(l: string, r: string): string;
}

const s = (l: string) => `String(${l} ?? '')`;
const lc = (l: string) => `String(${l} ?? '').toLowerCase()`;
const num = (l: string) => `Number(${l})`;
const date = (l: string) => `DateTime.fromISO(String(${l})).toMillis()`;
const exists = (l: string) => `(${l} !== undefined && ${l} !== null && ${l} !== '')`;

const text = (operation: string, js: (a: string, b: string) => string, ci = false): OpSpec => ({ type: 'string', operation, ci, js });

/** Make's operator ids. */
export const MAKE_OPS: Record<string, OpSpec> = {
  'text:equal': text('equals', (l, r) => `${s(l)} === ${s(r)}`),
  'text:equal:ci': text('equals', (l, r) => `${lc(l)} === ${lc(r)}`, true),
  'text:notequal': text('notEquals', (l, r) => `${s(l)} !== ${s(r)}`),
  'text:notequal:ci': text('notEquals', (l, r) => `${lc(l)} !== ${lc(r)}`, true),
  'text:contain': text('contains', (l, r) => `${s(l)}.includes(${s(r)})`),
  'text:contains': text('contains', (l, r) => `${s(l)}.includes(${s(r)})`),
  'text:contain:ci': text('contains', (l, r) => `${lc(l)}.includes(${lc(r)})`, true),
  'text:notcontain': text('notContains', (l, r) => `!${s(l)}.includes(${s(r)})`),
  'text:notcontain:ci': text('notContains', (l, r) => `!${lc(l)}.includes(${lc(r)})`, true),
  'text:startwith': text('startsWith', (l, r) => `${s(l)}.startsWith(${s(r)})`),
  'text:startwith:ci': text('startsWith', (l, r) => `${lc(l)}.startsWith(${lc(r)})`, true),
  'text:notstartwith': text('notStartsWith', (l, r) => `!${s(l)}.startsWith(${s(r)})`),
  'text:endwith': text('endsWith', (l, r) => `${s(l)}.endsWith(${s(r)})`),
  'text:endwith:ci': text('endsWith', (l, r) => `${lc(l)}.endsWith(${lc(r)})`, true),
  'text:notendwith': text('notEndsWith', (l, r) => `!${s(l)}.endsWith(${s(r)})`),
  'text:pattern': text('regex', (l, r) => `new RegExp(${s(r)}).test(${s(l)})`),
  'text:pattern:ci': text('regex', (l, r) => `new RegExp(${s(r)}, 'i').test(${s(l)})`, true),
  'text:notpattern': text('notRegex', (l, r) => `!new RegExp(${s(r)}).test(${s(l)})`),
  'number:equal': { type: 'number', operation: 'equals', js: (l, r) => `${num(l)} === ${num(r)}` },
  'number:notequal': { type: 'number', operation: 'notEquals', js: (l, r) => `${num(l)} !== ${num(r)}` },
  'number:greater': { type: 'number', operation: 'gt', js: (l, r) => `${num(l)} > ${num(r)}` },
  'number:greaterThan': { type: 'number', operation: 'gt', js: (l, r) => `${num(l)} > ${num(r)}` },
  'number:less': { type: 'number', operation: 'lt', js: (l, r) => `${num(l)} < ${num(r)}` },
  'number:lessThan': { type: 'number', operation: 'lt', js: (l, r) => `${num(l)} < ${num(r)}` },
  'number:greaterorequal': { type: 'number', operation: 'gte', js: (l, r) => `${num(l)} >= ${num(r)}` },
  'number:lessorequal': { type: 'number', operation: 'lte', js: (l, r) => `${num(l)} <= ${num(r)}` },
  'date:equal': { type: 'dateTime', operation: 'equals', js: (l, r) => `${date(l)} === ${date(r)}` },
  'date:notequal': { type: 'dateTime', operation: 'notEquals', js: (l, r) => `${date(l)} !== ${date(r)}` },
  'date:greater': { type: 'dateTime', operation: 'after', js: (l, r) => `${date(l)} > ${date(r)}` },
  'date:less': { type: 'dateTime', operation: 'before', js: (l, r) => `${date(l)} < ${date(r)}` },
  'date:greaterorequal': { type: 'dateTime', operation: 'afterOrEquals', js: (l, r) => `${date(l)} >= ${date(r)}` },
  'date:lessorequal': { type: 'dateTime', operation: 'beforeOrEquals', js: (l, r) => `${date(l)} <= ${date(r)}` },
  'boolean:equal': { type: 'boolean', operation: 'equals', js: (l, r) => `Boolean(${l}) === (String(${r}) === 'true')` },
  'boolean:notequal': { type: 'boolean', operation: 'notEquals', js: (l, r) => `Boolean(${l}) !== (String(${r}) === 'true')` },
  exist: { type: 'string', operation: 'exists', single: true, js: (l) => exists(l) },
  notexist: { type: 'string', operation: 'notExists', single: true, js: (l) => `!${exists(l)}` },
  'array:contain': { type: 'array', operation: 'contains', js: (l, r) => `(${l} ?? []).includes(${r})` },
  'array:notcontain': { type: 'array', operation: 'notContains', js: (l, r) => `!(${l} ?? []).includes(${r})` },
  'array:empty': { type: 'array', operation: 'empty', single: true, js: (l) => `!(${l} ?? []).length` },
  'array:notempty': { type: 'array', operation: 'notEmpty', single: true, js: (l) => `!!(${l} ?? []).length` },
};

function rightValue(spec: OpSpec, raw: string | undefined, ctx: MapCtx): unknown {
  if (raw === undefined) return '';
  if (spec.type === 'number' && /^-?\d+(\.\d+)?$/.test(raw.trim())) return Number(raw);
  if (spec.type === 'boolean' && /^(true|false)$/i.test(raw.trim())) return raw.trim().toLowerCase() === 'true';
  return ctx.expr(raw);
}

/** `conditions` + options parameters for an n8n Filter/If node (typeVersion 2.3: condition format version 3). */
export function conditionParameters(groups: ConditionGroup, ops: Record<string, OpSpec>, ctx: MapCtx, label: string): Record<string, unknown> {
  const specs = groups.map((g) => g.map((c) => (Object.hasOwn(ops, c.op) ? ops[c.op] : undefined)));
  const unknown = groups.flat().filter((c) => !Object.hasOwn(ops, c.op));
  const flat = specs.flat();
  const textCi = flat.filter((x) => x?.type === 'string' && !x.single).map((x) => !!x?.ci);
  const ciMixed = textCi.length > 0 && new Set(textCi).size > 1;
  const native = !unknown.length && !ciMixed && (groups.length === 1 || groups.every((g) => g.length === 1));
  const options = { caseSensitive: !(textCi.length > 0 && textCi.every(Boolean)), leftValue: '', typeValidation: 'loose', version: 3 };

  if (native) {
    const conditions = groups.flat().map((c, i) => {
      const spec = flat[i]!;
      const operator: Record<string, unknown> = { type: spec.type, operation: spec.operation };
      if (spec.single) operator.singleValue = true;
      return { id: randomUUID(), leftValue: ctx.expr(c.left), rightValue: spec.single ? '' : rightValue(spec, c.right, ctx), operator };
    });
    return { conditions: { options, conditions, combinator: groups.length === 1 ? 'and' : 'or' }, looseTypeValidation: true, options: {} };
  }

  if (unknown.length) {
    ctx.note(`Condition operator ${unknown.map((c) => `"${c.op}"`).join(', ')} in "${label}" has no translation; the filter blocks every item until you replace it.`, true);
  }
  const js = groups
    .map((g, gi) => `(${g.map((c, ci) => specs[gi][ci]?.js(ctx.js(c.left), ctx.js(c.right ?? '')) ?? 'false').join(' && ')})`)
    .join(' || ');
  const conditions = [{ id: randomUUID(), leftValue: `={{ ${js} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }];
  return { conditions: { options: { ...options, caseSensitive: true }, conditions, combinator: 'and' }, looseTypeValidation: true, options: {} };
}
