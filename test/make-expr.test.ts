import assert from 'node:assert/strict';
import { test } from 'node:test';

import { translateMakeExpr, translateMakeJs } from '../src/make/expr.ts';

const NAMES: Record<string, string> = { 1: 'Webhook', 2: 'Set fullName', 3: "It's" };
const ctx = { refName: (id: string) => NAMES[id] };
const W = "$('Webhook').item.json";
const tr = (s: string) => translateMakeExpr(s, ctx);

const CASES: Array<[string, string]> = [
  ['{{1.email}}', `={{ ${W}.email }}`],
  ['Hi {{1.name}}!', `=Hi {{ ${W}.name }}!`],
  ['{{1.`First Name`}}', `={{ ${W}['First Name'] }}`],
  ['{{1.`3`}}', `={{ ${W}['3'] }}`],
  ['{{1.items[2].sku}}', `={{ ${W}.items[1].sku }}`],
  ['{{1.data.RWS[].RW}}', `={{ ${W}.data.RWS.map(e => e.RW) }}`],
  ['{{3.x}}', "={{ $('It\\'s').item.json.x }}"],
  ['{{formatDate(1.d; "YYYY-MM-DD")}}', `={{ DateTime.fromISO(String(${W}.d)).toFormat('yyyy-LL-dd') }}`],
  ['{{formatDate(now; "DD.MM.YYYY HH:mm")}}', "={{ $now.toFormat('dd.LL.yyyy HH:mm') }}"],
  ['{{formatDate(now; "YYYY-MM-DDTHH:mm:ssZ")}}', "={{ $now.toFormat('yyyy-LL-dd\\'T\\'HH:mm:ssZZ') }}"],
  ['{{formatDate(now; "MMMM YYYY"; "Europe/Kyiv")}}', "={{ $now.setZone('Europe/Kyiv').toFormat('LLLL yyyy') }}"],
  ['{{parseDate(1.d; "DD.MM.YYYY")}}', `={{ DateTime.fromFormat(String(${W}.d), 'dd.LL.yyyy') }}`],
  ['{{formatDate(addHours(now; -48); \'YYYY-MM-DD\')}}', "={{ $now.plus({ hours: -48 }).toFormat('yyyy-LL-dd') }}"],
  ['{{addDays(1.d; 3)}}', `={{ DateTime.fromISO(String(${W}.d)).plus({ days: 3 }) }}`],
  ['{{if(1.a = "x"; "yes"; "no")}}', `={{ (${W}.a == "x" ? "yes" : "no") }}`],
  ['{{ifempty(1.company; "—")}}', `={{ (${W}.company || "—") }}`],
  ['{{coalesce(1.a; 1.b; "z")}}', `={{ (${W}.a ?? ${W}.b ?? "z") }}`],
  ['{{length(1.list)}}', `={{ ${W}.list.length }}`],
  ['{{lower(1.s)}}', `={{ String(${W}.s).toLowerCase() }}`],
  ['{{upper(1.s)}}', `={{ String(${W}.s).toUpperCase() }}`],
  ['{{trim(1.s)}}', `={{ String(${W}.s).trim() }}`],
  ['{{replace(1.s; "a"; "b")}}', `={{ String(${W}.s).replaceAll("a", "b") }}`],
  ['{{replace(1.s; /\\s+/g; "-")}}', `={{ String(${W}.s).replace(/\\s+/g, "-") }}`],
  ['{{replace(1.text; newline; " ")}}', `={{ String(${W}.text).replaceAll("\\n", " ") }}`],
  ['{{get(1.arr; 2)}}', `={{ ${W}.arr?.[1] }}`],
  ['{{get(1.obj; "a.b")}}', `={{ ${W}.obj?.a?.b }}`],
  ['{{get(split(1.s; "##"); 1)}}', `={{ String(${W}.s).split("##")?.[0] }}`],
  ['{{get(1.p; 1).errorCode}}', `={{ ${W}.p?.[0].errorCode }}`],
  ['{{join(1.arr; ", ")}}', `={{ ${W}.arr.join(", ") }}`],
  ['{{split(1.s; ",")}}', `={{ String(${W}.s).split(",") }}`],
  ['{{toString(1.n)}}', `={{ String(${W}.n) }}`],
  ['{{parseNumber(1.n)}}', `={{ Number(${W}.n) }}`],
  ['{{round(1.n)}}', `={{ Math.round(${W}.n) }}`],
  ['{{round(1.n * 100; 2)}}', `={{ (Math.round((${W}.n * 100) * 10 ** 2) / 10 ** 2) }}`],
  ['{{floor(1.n)}}', `={{ Math.floor(${W}.n) }}`],
  ['{{ceil(1.n)}}', `={{ Math.ceil(${W}.n) }}`],
  ['{{sum(1.arr)}}', `={{ ${W}.arr.reduce((s, v) => s + Number(v), 0) }}`],
  ['{{sum(1.a; 1.b)}}', `={{ (Number(${W}.a) + Number(${W}.b)) }}`],
  ['{{map(1.arr; "line")}}', `={{ ${W}.arr.map(e => e?.line) }}`],
  ['{{map(split(1.g; ","); (item) -> trim(item))}}', `={{ String(${W}.g).split(",").map((item) => String(item).trim()) }}`],
  ['{{contains(1.s; "x")}}', `={{ ${W}.s.includes("x") }}`],
  ['{{substring(1.s; 0; 3)}}', `={{ String(${W}.s).substring(0, 3) }}`],
  ['{{emptystring}}', '={{ "" }}'],
  ['{{emptyarray}}', '={{ [] }}'],
  ['{{now}}', '={{ $now }}'],
  ['{{1.a + 1}}', `={{ ${W}.a + 1 }}`],
  ['{{1.a <> 2}}', `={{ ${W}.a != 2 }}`],
  ['{{1.a > 0.6}}', `={{ ${W}.a > 0.6 }}`],
  ['{{"Hi " & 1.name & "!"}}', `={{ String("Hi ") + String(${W}.name) + String("!") }}`],
  ['{{"[""" + 1.x + """]"}}', `={{ "[\\"" + ${W}.x + "\\"]" }}`],
  ['plain text', 'plain text'],
];

for (const [input, expected] of CASES) {
  test(`translate ${input}`, () => {
    const r = tr(input);
    assert.equal(r.value, expected);
    assert.equal(r.ok, true, r.notes.join('; '));
  });
}

test('a reference to an unknown module keeps the original text and is not ok', () => {
  const r = tr('{{99.x}} and {{1.y}}');
  assert.equal(r.ok, false);
  assert.equal(r.value, '{{99.x}} and {{1.y}}');
  assert.match(r.notes.join(' '), /99/);
});

test('an unknown function keeps the original text and is not ok', () => {
  const r = tr('{{pick(1.a; "x")}}');
  assert.equal(r.ok, false);
  assert.equal(r.value, '{{pick(1.a; "x")}}');
  assert.match(r.notes.join(' '), /pick/);
});

test('a date format token without an exact equivalent is translated but flagged', () => {
  const r = tr('{{formatDate(now; "Do MMMM")}}');
  assert.equal(r.ok, false);
  assert.match(r.notes.join(' '), /Do/);
});

test('broken formula syntax is flagged, not thrown', () => {
  const r = tr('{{formatDate(1.d; "YYYY"}}');
  assert.equal(r.ok, false);
});

test('a step can rewrite references to it: another base, and leading fields dropped', () => {
  const refBase = (id: string, first?: string) =>
    id === '2' && first === 'data' ? { base: "$('HTTP').item.json", drop: 1 } : id === '2' ? { base: "$('HTTP').item.json.other", drop: 0 } : undefined;
  const ctx2 = { refName: () => 'HTTP', refBase };
  assert.equal(translateMakeExpr('{{2.data.id}}', ctx2).value, "={{ $('HTTP').item.json.id }}");
  assert.equal(translateMakeExpr('{{2.x}}', ctx2).value, "={{ $('HTTP').item.json.other.x }}");
});

test('a reference rewrite can refuse a field that has no equivalent', () => {
  const refBase = () => { throw new Error('statusCode is not available'); };
  const r = translateMakeExpr('{{2.statusCode}}', { refName: () => 'HTTP', refBase });
  assert.equal(r.ok, false);
  assert.match(r.notes.join(' '), /statusCode is not available/);
});

test('Make system variables map to n8n workflow and execution data', () => {
  assert.equal(tr('{{var.scenario.executionId}}').value, '={{ $execution.id }}');
  assert.equal(tr('{{var.scenario.id}}').value, '={{ $workflow.id }}');
  assert.equal(tr('{{var.scenario.name}}').value, '={{ $workflow.name }}');
  assert.equal(tr('{{var.scenario.executionStartedAt}}').value, '={{ $now }}');
});

test('Make custom variables become n8n variables, flagged for review', () => {
  const r = tr('{{var.organization.API_BASE}}/items');
  assert.equal(r.value, '={{ $vars.API_BASE }}/items');
  assert.equal(r.ok, false);
  assert.match(r.notes.join(' '), /n8n variable "API_BASE"/);
});

test('translateMakeJs: one formula is plain JavaScript', () => {
  const r = translateMakeJs('{{1.email}}', ctx);
  assert.deepEqual(r, { js: `${W}.email`, ok: true, notes: [] });
});

test('translateMakeJs: text around formulas is joined as a string', () => {
  assert.equal(translateMakeJs('Hi {{1.name}}!', ctx).js, `"Hi " + String(${W}.name) + "!"`);
  assert.equal(translateMakeJs('{{1.a}}{{1.b}}', ctx).js, `String(${W}.a) + String(${W}.b)`);
  assert.equal(translateMakeJs('plain', ctx).js, '"plain"');
  assert.equal(translateMakeJs('', ctx).js, '""');
});

test('translateMakeJs: an untranslatable value stays a string literal and is not ok', () => {
  const r = translateMakeJs('{{99.x}}', ctx);
  assert.equal(r.js, '"{{99.x}}"');
  assert.equal(r.ok, false);
});
