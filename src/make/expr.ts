/** Make formulas ({{…}} with references like `3.email` and functions like `formatDate`) → n8n expressions.
 *
 *  Each {{…}} is parsed into a small syntax tree and printed as JavaScript for n8n's {{ }} expressions
 *  (Luxon `DateTime` and `$now` are available there). Anything we cannot translate exactly is reported and
 *  the original text is kept, so nothing changes meaning silently. */
import { nodeRef } from '../util/names.ts';

export interface MakeExprCtx {
  /** n8n node name for a Make module id, or undefined when the module has no node. */
  refName(moduleId: string): string | undefined;
  /** How a step exposes its output, when it is not `$('Name').item.json.<path>`: another base expression, and
   *  how many leading path fields to drop (an HTTP response's `data`). May throw to refuse a field. */
  refBase?(moduleId: string, firstField?: string): { base: string; drop: number; note?: string } | undefined;
}

export interface Translated {
  value: string;
  ok: boolean;
  notes: string[];
}

class Unsupported extends Error {}

// ---------- tokens ----------

type Tok =
  | { t: 'num'; v: string }
  | { t: 'str'; v: string }
  | { t: 'regex'; v: string }
  | { t: 'ref'; id: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: 'punct'; v: '(' | ')' | ';' | '.' | '[' | ']' | ',' }
  | { t: 'tick'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const prevAllowsRegex = () => {
    const p = out[out.length - 1];
    return !p || (p.t === 'punct' && (p.v === '(' || p.v === ';' || p.v === ',')) || p.t === 'op';
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      // Make doubles a quote to escape it: "say ""hi"""
      let v = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new Unsupported('a text in quotes is not closed');
        if (src[i] === c) {
          if (src[i + 1] === c) { v += c; i += 2; continue; }
          i++;
          break;
        }
        v += src[i++];
      }
      out.push({ t: 'str', v });
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end < 0) throw new Unsupported('a `name` is not closed');
      out.push({ t: 'tick', v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (c === '/' && prevAllowsRegex()) {
      const m = /^\/((?:\\.|[^/\\])+)\/([gimsuy]*)/.exec(src.slice(i));
      if (m) { out.push({ t: 'regex', v: m[0] }); i += m[0].length; continue; }
    }
    if (/\d/.test(c)) {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i))!;
      // `3.email` and `3.\`x\`` are module references; `0.6` is a number
      const ref = /^(\d+)(?=\.[A-Za-z_$`]|\[)/.exec(src.slice(i));
      if (ref) { out.push({ t: 'ref', id: ref[1] }); i += ref[1].length; continue; }
      out.push({ t: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '!=', '<>', '->', '=='].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/%<>=&|!'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    if ('();.[],'.includes(c)) { out.push({ t: 'punct', v: c as any }); i++; continue; }
    throw new Unsupported(`unexpected character "${c}"`);
  }
  return out;
}

// ---------- syntax tree ----------

type Seg = { k: 'prop'; name: string } | { k: 'index'; expr: Node } | { k: 'all' };
type Node =
  | { k: 'num'; v: string }
  | { k: 'str'; v: string }
  | { k: 'regex'; v: string }
  | { k: 'kw'; v: string }
  | { k: 'local'; v: string }
  | { k: 'var'; path: Seg[] }
  | { k: 'ref'; id: string; path: Seg[] }
  | { k: 'call'; name: string; args: Node[]; path: Seg[] }
  | { k: 'paren'; e: Node; path: Seg[] }
  | { k: 'lambda'; params: string[]; body: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'un'; op: string; e: Node };

const KEYWORDS = new Set(['true', 'false', 'null', 'now', 'timestamp', 'newline', 'space', 'tab', 'emptystring', 'emptyarray', 'pi', 'random', 'nbsp']);
// lowest first
const LEVELS: string[][] = [['or', '|'], ['and'], ['=', '==', '!=', '<>', '<', '>', '<=', '>='], ['&'], ['+', '-'], ['*', '/', '%', 'mod']];

class Parser {
  i = 0;
  constructor(private toks: Tok[], private locals: Set<string> = new Set()) {}
  peek(): Tok | undefined { return this.toks[this.i]; }
  isPunct(v: string) { const t = this.peek(); return t?.t === 'punct' && t.v === v; }
  expect(v: string) {
    if (!this.isPunct(v)) throw new Unsupported(`expected "${v}"`);
    this.i++;
  }
  parseAll(): Node {
    const n = this.expr(0);
    if (this.i < this.toks.length) throw new Unsupported('unexpected text after the formula');
    return n;
  }
  opAt(level: number): string | undefined {
    const t = this.peek();
    if (!t) return;
    const v = t.t === 'op' ? t.v : t.t === 'id' ? t.v : undefined;
    return v !== undefined && LEVELS[level].includes(v) ? v : undefined;
  }
  expr(level: number): Node {
    if (level >= LEVELS.length) return this.unary();
    let l = this.expr(level + 1);
    for (let op = this.opAt(level); op; op = this.opAt(level)) {
      this.i++;
      l = { k: 'bin', op, l, r: this.expr(level + 1) };
    }
    return l;
  }
  unary(): Node {
    const t = this.peek();
    if (t?.t === 'op' && (t.v === '-' || t.v === '!')) { this.i++; return { k: 'un', op: t.v, e: this.unary() }; }
    if (t?.t === 'id' && t.v === 'not') { this.i++; return { k: 'un', op: '!', e: this.unary() }; }
    return this.primary();
  }
  path(): Seg[] {
    const segs: Seg[] = [];
    for (;;) {
      if (this.isPunct('.')) {
        this.i++;
        const t = this.peek();
        if (t?.t === 'id') segs.push({ k: 'prop', name: t.v });
        else if (t?.t === 'tick') segs.push({ k: 'prop', name: t.v });
        else if (t?.t === 'num' && /^\d+$/.test(t.v)) segs.push({ k: 'prop', name: t.v });
        else throw new Unsupported('expected a field name after "."');
        this.i++;
      } else if (this.isPunct('[')) {
        this.i++;
        if (this.isPunct(']')) { this.i++; segs.push({ k: 'all' }); continue; }
        const e = this.expr(0);
        this.expect(']');
        segs.push({ k: 'index', expr: e });
      } else return segs;
    }
  }
  primary(): Node {
    const t = this.peek();
    if (!t) throw new Unsupported('the formula ends too early');
    this.i++;
    switch (t.t) {
      case 'num': return { k: 'num', v: t.v };
      case 'str': return { k: 'str', v: t.v };
      case 'regex': return { k: 'regex', v: t.v };
      case 'ref': return { k: 'ref', id: t.id, path: this.path() };
      case 'id': {
        if (this.isPunct('(')) {
          this.i++;
          const args: Node[] = [];
          if (!this.isPunct(')')) {
            for (;;) {
              args.push(this.expr(0));
              if (this.isPunct(';')) { this.i++; continue; }
              break;
            }
          }
          this.expect(')');
          return { k: 'call', name: t.v, args, path: this.path() };
        }
        if (this.locals.has(t.v)) return { k: 'local', v: t.v };
        if (t.v === 'var' && this.isPunct('.')) return { k: 'var', path: this.path() };
        if (KEYWORDS.has(t.v)) return { k: 'kw', v: t.v };
        throw new Unsupported(`unknown name "${t.v}"`);
      }
      case 'punct':
        if (t.v === '(') {
          // lambda: (item) -> body   or   (a, b) -> body
          const save = this.i;
          const params: string[] = [];
          while (this.peek()?.t === 'id') {
            params.push((this.peek() as { v: string }).v);
            this.i++;
            if (this.isPunct(',')) this.i++;
          }
          if (params.length && this.isPunct(')') && (this.toks[this.i + 1] as any)?.v === '->') {
            this.i += 2;
            const inner = new Parser(this.toks, new Set([...this.locals, ...params]));
            inner.i = this.i;
            const body = inner.expr(0);
            this.i = inner.i;
            return { k: 'lambda', params, body };
          }
          this.i = save;
          const e = this.expr(0);
          this.expect(')');
          return { k: 'paren', e, path: this.path() };
        }
        throw new Unsupported(`unexpected "${t.v}"`);
      default:
        throw new Unsupported('unexpected text');
    }
  }
}

// ---------- printing ----------

type Kind = 'datetime' | 'any';
interface Out { js: string; kind: Kind }

const IDENT = /^[A-Za-z_$][\w$]*$/;
const prop = (name: string) => (IDENT.test(name) ? `.${name}` : `['${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`);
const jsStr = (s: string) => JSON.stringify(s);
const jsSingle = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Moment-style date format (what Make uses) → Luxon format. */
/** Zapier's offsets are the other way round: "Z" is +0000 and "ZZ" is +00:00 (as its own format list shows). */
export function convertDateFormat(fmt: string, offsets: 'make' | 'zapier' = 'make'): { fmt: string; exact: boolean; unsupported: string[] } {
  const zone: Array<[string, string]> = offsets === 'zapier' ? [['ZZ', 'ZZ'], ['Z', 'ZZZ']] : [['ZZ', 'ZZZ'], ['Z', 'ZZ']];
  const MAP: Array<[string, string | null]> = [
    ['YYYY', 'yyyy'], ['YY', 'yy'], ['MMMM', 'LLLL'], ['MMM', 'LLL'], ['MM', 'LL'], ['M', 'L'],
    ['Do', null], ['DDDD', 'ooo'], ['DD', 'dd'], ['D', 'd'], ['dddd', 'cccc'], ['ddd', 'ccc'], ['d', null],
    ['HH', 'HH'], ['H', 'H'], ['hh', 'hh'], ['h', 'h'], ['mm', 'mm'], ['m', 'm'], ['ss', 'ss'], ['s', 's'],
    ['SSS', 'SSS'], ['A', 'a'], ['a', 'a'], ['X', 'X'], ['x', 'x'], ...zone, ['Q', 'q'], ['W', 'W'],
  ];
  let out = '';
  let literal = '';
  const unsupported: string[] = [];
  const flush = () => {
    if (literal) out += `'${literal.replace(/'/g, "''")}'`;
    literal = '';
  };
  for (let i = 0; i < fmt.length;) {
    if (fmt[i] === '[') {
      const end = fmt.indexOf(']', i);
      if (end > i) { literal += fmt.slice(i + 1, end); i = end + 1; continue; }
    }
    const hit = MAP.find(([m]) => fmt.startsWith(m, i));
    if (hit) {
      flush();
      if (hit[1] === null) {
        unsupported.push(hit[0]);
        out += hit[0] === 'Do' ? 'd' : 'c';
      } else out += hit[1];
      i += hit[0].length;
    } else if (/[A-Za-z]/.test(fmt[i])) {
      literal += fmt[i++];
    } else {
      flush();
      out += fmt[i] === "'" ? "''" : fmt[i];
      i++;
    }
  }
  flush();
  return { fmt: out, exact: unsupported.length === 0, unsupported };
}

class Printer {
  notes: string[] = [];
  constructor(private ctx: MakeExprCtx) {}

  dt(o: Out): string {
    return o.kind === 'datetime' ? o.js : `DateTime.fromISO(String(${o.js}))`;
  }

  path(base: string, segs: Seg[]): string {
    let js = base;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.k === 'prop') js += prop(s.name);
      else if (s.k === 'index') {
        const e = s.expr;
        js += e.k === 'num' && /^\d+$/.test(e.v) ? `[${Number(e.v) - 1}]` : `[(${this.p(e).js}) - 1]`;
      } else return `${js}.map(e => ${this.path('e', segs.slice(i + 1))})`;
    }
    return js;
  }

  /** Literal string argument, or throw: formats and keys must be known at conversion time. */
  lit(n: Node | undefined, what: string): string {
    if (n?.k === 'str') return n.v;
    if (n?.k === 'num') return n.v;
    throw new Unsupported(`${what} must be written as plain text`);
  }

  call(name: string, a: Node[]): Out {
    const P = (n: Node) => this.p(n);
    const js = (n: Node) => this.p(n).js;
    const need = (min: number, max = min) => {
      if (a.length < min || a.length > max) throw new Unsupported(`${name}() with ${a.length} arguments`);
    };
    const any = (s: string): Out => ({ js: s, kind: 'any' });
    const dt = (s: string): Out => ({ js: s, kind: 'datetime' });
    const units: Record<string, string> = { addSeconds: 'seconds', addMinutes: 'minutes', addHours: 'hours', addDays: 'days', addMonths: 'months', addYears: 'years' };
    if (Object.hasOwn(units, name)) {
      need(2);
      return dt(`${this.dt(P(a[0]))}.plus({ ${units[name]}: ${js(a[1])} })`);
    }
    switch (name) {
      case 'formatDate': {
        need(2, 3);
        const f = convertDateFormat(this.lit(a[1], 'the date format'));
        if (!f.exact) this.notes.push(`Date format token ${f.unsupported.join(', ')} has no exact Luxon equivalent; check the output.`);
        const zone = a[2] ? `.setZone(${jsSingle(this.lit(a[2], 'the time zone'))})` : '';
        return any(`${this.dt(P(a[0]))}${zone}.toFormat(${jsSingle(f.fmt)})`);
      }
      case 'parseDate': {
        need(1, 3);
        if (!a[1]) return dt(`DateTime.fromISO(String(${js(a[0])}))`);
        const f = convertDateFormat(this.lit(a[1], 'the date format'));
        if (!f.exact) this.notes.push(`Date format token ${f.unsupported.join(', ')} has no exact Luxon equivalent; check the output.`);
        const zone = a[2] ? `, { zone: ${jsSingle(this.lit(a[2], 'the time zone'))} }` : '';
        return dt(`DateTime.fromFormat(String(${js(a[0])}), ${jsSingle(f.fmt)}${zone})`);
      }
      case 'if': need(3); return any(`(${js(a[0])} ? ${js(a[1])} : ${js(a[2])})`);
      // Make counts only null, "" and an empty list as empty (0 and false are values).
      case 'ifempty': need(2); return any(`((v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) ? ${js(a[1])} : v)(${js(a[0])})`);
      case 'coalesce':
        if (!a.length) need(1);
        return any(`[${a.map(js).join(', ')}].find((v) => v !== undefined && v !== null && v !== '')`);
      case 'switch': {
        if (a.length < 3) need(3);
        const subject = js(a[0]);
        const rest = a.slice(1);
        let out = rest.length % 2 === 1 ? js(rest[rest.length - 1]) : 'null';
        for (let i = rest.length - (rest.length % 2) - 2; i >= 0; i -= 2) out = `(${subject} == ${js(rest[i])} ? ${js(rest[i + 1])} : ${out})`;
        return any(out);
      }
      case 'length': need(1); return any(`${js(a[0])}.length`);
      case 'lower': need(1); return any(`String(${js(a[0])}).toLowerCase()`);
      case 'upper': need(1); return any(`String(${js(a[0])}).toUpperCase()`);
      case 'trim': need(1); return any(`String(${js(a[0])}).trim()`);
      case 'capitalize': need(1); return any(`(s => s.charAt(0).toUpperCase() + s.slice(1))(String(${js(a[0])}))`);
      case 'replace': {
        need(3);
        if (a[1].k === 'regex') return any(`String(${js(a[0])}).replace(${a[1].v}, ${js(a[2])})`);
        return any(`String(${js(a[0])}).replaceAll(${js(a[1])}, ${js(a[2])})`);
      }
      case 'get': {
        need(2);
        if (a[1].k === 'num' && /^\d+$/.test(a[1].v)) return any(`${js(a[0])}?.[${Number(a[1].v) - 1}]`);
        if (a[1].k === 'str') return any(js(a[0]) + a[1].v.split('.').map((k) => (/^\d+$/.test(k) ? `?.[${Number(k) - 1}]` : `?.${IDENT.test(k) ? k : `[${jsSingle(k)}]`}`)).join(''));
        throw new Unsupported('get() with a computed path');
      }
      case 'join': need(2); return any(`${js(a[0])}.join(${js(a[1])})`);
      case 'split': need(2); return any(`String(${js(a[0])}).split(${js(a[1])})`);
      case 'toString': need(1); return any(`String(${js(a[0])})`);
      case 'parseNumber': {
        need(1, 2);
        if (!a[1]) return any(`Number(${js(a[0])})`);
        const sep = this.lit(a[1], 'the decimal separator');
        return any(sep === ','
          ? `Number(String(${js(a[0])}).replace(/[.\\s]/g, '').replace(',', '.'))`
          : `Number(String(${js(a[0])}).replace(/[,\\s]/g, ''))`);
      }
      case 'round': {
        need(1, 2);
        if (!a[1]) return any(`Math.round(${js(a[0])})`);
        const p = this.lit(a[1], 'the precision');
        return any(`(Math.round((${js(a[0])}) * 10 ** ${p}) / 10 ** ${p})`);
      }
      case 'floor': need(1); return any(`Math.floor(${js(a[0])})`);
      case 'ceil': need(1); return any(`Math.ceil(${js(a[0])})`);
      case 'abs': need(1); return any(`Math.abs(${js(a[0])})`);
      case 'max': case 'min':
        if (!a.length) need(1);
        return any(a.length === 1 ? `Math.${name}(...${js(a[0])})` : `Math.${name}(${a.map(js).join(', ')})`);
      case 'sum':
        if (!a.length) need(1);
        return any(a.length === 1 ? `${js(a[0])}.reduce((s, v) => s + Number(v), 0)` : `(${a.map((n) => `Number(${js(n)})`).join(' + ')})`);
      case 'average':
        if (!a.length) need(1);
        return any(a.length === 1
          ? `(arr => arr.reduce((s, v) => s + Number(v), 0) / arr.length)(${js(a[0])})`
          : `((${a.map((n) => `Number(${js(n)})`).join(' + ')}) / ${a.length})`);
      case 'map': {
        need(2, 4);
        if (a[1].k === 'lambda') { need(2); return any(`${js(a[0])}.map(${js(a[1])})`); }
        const key = this.lit(a[1], 'the key');
        const pick = `e => e?.${IDENT.test(key) ? key : `[${jsSingle(key)}]`}`;
        if (a.length === 2) return any(`${js(a[0])}.map(${pick})`);
        if (a.length === 3) need(2, 2);
        const fk = this.lit(a[2], 'the filter key');
        const fv = this.lit(a[3], 'the filter values').split(',').map((s) => s.trim());
        return any(`${js(a[0])}.filter(e => ${JSON.stringify(fv)}.includes(String(e?.[${jsSingle(fk)}]))).map(${pick})`);
      }
      case 'contains': need(2); return any(`${js(a[0])}.includes(${js(a[1])})`);
      case 'substring': need(2, 3); return any(`String(${js(a[0])}).substring(${a.slice(1).map(js).join(', ')})`);
      case 'indexOf': need(2, 3); return any(`String(${js(a[0])}).indexOf(${a.slice(1).map(js).join(', ')})`);
      case 'first': need(1); return any(`${js(a[0])}[0]`);
      case 'last': need(1); return any(`${js(a[0])}.at(-1)`);
      case 'slice': need(2, 3); return any(`${js(a[0])}.slice(${a.slice(1).map(js).join(', ')})`);
      case 'merge': if (a.length < 2) need(2); return any(`[${a.map((n) => `...${js(n)}`).join(', ')}]`);
      case 'add': if (a.length < 2) need(2); return any(`[...${js(a[0])}, ${a.slice(1).map(js).join(', ')}]`);
      case 'keys': need(1); return any(`Object.keys(${js(a[0])})`);
      case 'reverse': need(1); return any(`[...${js(a[0])}].reverse()`);
      case 'sort': need(1); return any(`[...${js(a[0])}].sort()`);
      case 'flatten': need(1); return any(`${js(a[0])}.flat()`);
      case 'distinct': case 'deduplicate': need(1); return any(`[...new Set(${js(a[0])})]`);
      case 'encodeURL': need(1); return any(`encodeURIComponent(${js(a[0])})`);
      case 'decodeURL': need(1); return any(`decodeURIComponent(${js(a[0])})`);
      case 'base64': need(1); return any(`String(${js(a[0])}).base64Encode()`);
      case 'md5': case 'sha1': case 'sha256': case 'sha512': need(1); return any(`String(${js(a[0])}).hash('${name}')`);
      case 'stripHTML': need(1); return any(`String(${js(a[0])}).removeTags()`);
      case 'not': need(1); return any(`!(${js(a[0])})`);
      default:
        throw new Unsupported(`function ${name}() has no automatic translation`);
    }
  }

  p(n: Node): Out {
    const any = (js: string): Out => ({ js, kind: 'any' });
    switch (n.k) {
      case 'num': return any(n.v);
      case 'str': return any(jsStr(n.v));
      case 'regex': return any(n.v);
      case 'local': return any(n.v);
      case 'var': {
        const names = n.path.map((s) => (s.k === 'prop' ? s.name : '?'));
        const [scope, name, ...more] = names;
        const SYSTEM: Record<string, string> = { executionId: '$execution.id', id: '$workflow.id', name: '$workflow.name' };
        if (scope === 'scenario' && Object.hasOwn(SYSTEM, name) && !more.length) return any(SYSTEM[name]);
        if (scope === 'scenario' && name === 'executionStartedAt' && !more.length) {
          this.notes.push('The execution start time is approximated by the current time ($now).');
          return { js: '$now', kind: 'datetime' };
        }
        if ((scope === 'organization' || scope === 'team') && name && !more.length) {
          this.notes.push(`Make ${scope} variable "${name}" becomes the n8n variable "${name}": create it in n8n (Variables), or replace it with a value.`);
          return any(`$vars${prop(name)}`);
        }
        throw new Unsupported(`Make variable var.${names.join('.')} has no n8n equivalent`);
      }
      case 'kw': {
        const kw: Record<string, Out> = {
          true: any('true'), false: any('false'), null: any('null'), now: { js: '$now', kind: 'datetime' },
          timestamp: any('Math.floor($now.toSeconds())'), newline: any('"\\n"'), space: any('" "'), tab: any('"\\t"'),
          emptystring: any('""'), emptyarray: any('[]'), pi: any('Math.PI'), random: any('Math.random()'), nbsp: any('"\\u00a0"'),
        };
        return kw[n.v];
      }
      case 'ref': {
        const first = n.path[0]?.k === 'prop' ? n.path[0].name : undefined;
        let custom: { base: string; drop: number; note?: string } | undefined;
        try {
          custom = this.ctx.refBase?.(n.id, first);
        } catch (e) {
          throw new Unsupported((e as Error).message);
        }
        if (custom?.note && !this.notes.includes(custom.note)) this.notes.push(custom.note);
        if (custom) return any(this.path(custom.base, n.path.slice(custom.drop)));
        const name = this.ctx.refName(n.id);
        if (name === undefined) throw new Unsupported(`module ${n.id} is not in the converted workflow`);
        return any(this.path(`${nodeRef(name)}.item.json`, n.path));
      }
      case 'call': {
        const o = this.call(n.name, n.args);
        return n.path.length ? any(this.path(o.js, n.path)) : o;
      }
      case 'paren': {
        const o = this.p(n.e);
        return n.path.length ? any(this.path(`(${o.js})`, n.path)) : { js: `(${o.js})`, kind: o.kind };
      }
      case 'lambda': return any(`(${n.params.join(', ')}) => ${this.p(n.body).js}`);
      case 'un': return any(`${n.op}${this.p(n.e).js}`);
      case 'bin': {
        const l = this.p(n.l).js;
        const r = this.p(n.r).js;
        if (n.op === '&') return any(`${n.l.k === 'bin' && n.l.op === '&' ? l : `String(${l})`} + String(${r})`);
        const op = ({ '=': '==', '<>': '!=', and: '&&', or: '||', '|': '||', mod: '%' } as Record<string, string>)[n.op] ?? n.op;
        return any(`${l} ${op} ${r}`);
      }
    }
  }
}

/** Find the {{…}} parts of a Make value, skipping quoted text and nested braces inside them. */
function splitTemplate(src: string): Array<{ text: string } | { expr: string; raw: string } | { broken: string }> {
  const parts: Array<{ text: string } | { expr: string; raw: string } | { broken: string }> = [];
  let i = 0;
  let text = '';
  while (i < src.length) {
    if (src.startsWith('{{', i)) {
      let j = i + 2;
      let depth = 0;
      let quote: string | null = null;
      for (; j < src.length; j++) {
        const c = src[j];
        if (quote) { if (c === quote) quote = null; continue; }
        if (c === '"' || c === "'") quote = c;
        else if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (depth <= 0 && src.startsWith('}}', j)) break;
      }
      if (j >= src.length) {
        // An opening {{ whose closing }} is missing (or swallowed by an unclosed bracket or quote).
        if (text) parts.push({ text });
        parts.push({ broken: src.slice(i) });
        return parts;
      }
      if (text) parts.push({ text });
      text = '';
      parts.push({ expr: src.slice(i + 2, j), raw: src.slice(i, j + 2) });
      i = j + 2;
    } else text += src[i++];
  }
  if (text) parts.push({ text });
  return parts;
}

export function translateMakeExpr(value: string, ctx: MakeExprCtx): Translated {
  const parts = splitTemplate(value);
  if (!parts.some((p) => !('text' in p))) return { value, ok: true, notes: [] };
  const printer = new Printer(ctx);
  const out: string[] = [];
  try {
    for (const p of parts) {
      if ('text' in p) { out.push(p.text); continue; }
      if ('broken' in p) throw new Unsupported('a {{ is not closed');
      const tree = new Parser(tokenize(p.expr)).parseAll();
      out.push(`{{ ${printer.p(tree).js} }}`);
    }
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e;
    return { value, ok: false, notes: [`Formula not translated (${e.message}): ${value}`] };
  }
  const ok = printer.notes.length === 0;
  return { value: `=${out.join('')}`, ok, notes: printer.notes.map((n) => `${n} Original: ${value}`) };
}

/** The same translation as plain JavaScript, for Code nodes and for building larger expressions. Text
 *  around formulas becomes string literals joined with +; a value without formulas is one string literal. */
export function translateMakeJs(value: string, ctx: MakeExprCtx): { js: string; ok: boolean; notes: string[] } {
  const parts = splitTemplate(value);
  const printer = new Printer(ctx);
  const out: string[] = [];
  try {
    for (const p of parts) {
      if ('text' in p) out.push(JSON.stringify(p.text));
      else if ('broken' in p) throw new Unsupported('a {{ is not closed');
      else {
        const js = printer.p(new Parser(tokenize(p.expr)).parseAll()).js;
        out.push(parts.length > 1 ? `String(${js})` : js);
      }
    }
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e;
    return { js: JSON.stringify(value), ok: false, notes: [`Formula not translated (${e.message}): ${value}`] };
  }
  return { js: out.join(' + ') || '""', ok: printer.notes.length === 0, notes: printer.notes.map((n) => `${n} Original: ${value}`) };
}
