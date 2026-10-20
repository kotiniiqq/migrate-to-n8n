import assert from 'node:assert/strict';
import { test } from 'node:test';

import { translateZapierExpr, translateZapierJs } from '../src/zapier/expr.ts';

const NAMES: Record<string, string> = { 1: 'New lead', 3: 'Name', 316245273: "It's" };
const ctx = { refName: (id: string) => NAMES[id] };
const L = "$('New lead').item.json";
const tr = (s: string) => translateZapierExpr(s, ctx);

const CASES: Array<[string, string]> = [
  ['{{1__email}}', `={{ ${L}.email }}`],
  ['Hi {{1__name}}!', `=Hi {{ ${L}.name }}!`],
  ['{{1__company__domain}}', `={{ ${L}.company.domain }}`],
  ['{{1__tags__0}}', `={{ ${L}.tags[0] }}`],
  ['{{1__Clause Name}}', `={{ ${L}['Clause Name'] }}`],
  ['{{1__choices[]text}}', `={{ ${L}.choices.map(e => e.text) }}`],
  ["{{=gives['1']['company']['domain']}}", `={{ ${L}.company.domain }}`],
  ['{{=gives["1"]["data"]["first name"]}}', `={{ ${L}.data['first name'] }}`],
  ['{{=output["316245273"]["new"]}}', "={{ $('It\\'s').item.json.new }}"],
  ['{{zap_meta_utc_iso}}', '={{ $now.toUTC().toISO() }}'],
  ['{{zap_meta_timestamp}}', '={{ Math.floor($now.toSeconds()) }}'],
  ['{{zap_meta_id}}', '={{ $execution.id }}'],
  ['no formulas', 'no formulas'],
];

for (const [input, expected] of CASES) {
  test(`translate ${input}`, () => {
    const r = tr(input);
    assert.equal(r.value, expected);
    assert.equal(r.ok, true, r.notes.join('; '));
  });
}

test('a field whose name starts with an underscore keeps it', () => {
  assert.equal(translateZapierExpr('{{9___zap_search_was_found_status}}', { refName: () => 'Find' }).value, "={{ $('Find').item.json._zap_search_was_found_status }}");
});

test('the human date of the run is translated with a note', () => {
  const r = tr('{{zap_meta_human_now}}');
  assert.match(r.value, /\$now\.toFormat/);
  assert.equal(r.ok, false);
});

test('an unknown step keeps the original text and is not ok', () => {
  const r = tr('{{42__x}} and {{1__y}}');
  assert.equal(r.ok, false);
  assert.equal(r.value, '{{42__x}} and {{1__y}}');
  assert.match(r.notes.join(' '), /42/);
});

test('JavaScript inside {{= }} that is more than a field path is not guessed', () => {
  const r = tr("{{=gives['1']['a'] + 1}}");
  assert.equal(r.ok, false);
});

test('translateZapierJs joins text and fields as a string', () => {
  assert.equal(translateZapierJs('Hi {{1__name}}!', ctx).js, `"Hi " + String(${L}.name) + "!"`);
  assert.equal(translateZapierJs('{{1__n}}', ctx).js, `${L}.n`);
});

test('references can be rewritten by the step that produced them', () => {
  const refBase = (id: string) => (id === '1' ? { base: `${L}.body`, drop: 0 } : undefined);
  assert.equal(translateZapierExpr('{{1__email}}', { ...ctx, refBase }).value, `={{ ${L}.body.email }}`);
});
