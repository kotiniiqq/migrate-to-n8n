import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nodeRef, safeFileName, uniqueName } from '../src/util/names.ts';

test('uniqueName adds a counter to a taken name', () => {
  assert.equal(uniqueName('Send', new Set(['Send'])), 'Send 2');
  assert.equal(uniqueName('Send', new Set(['Send', 'Send 2'])), 'Send 3');
});

test('uniqueName keeps Cyrillic and emoji, and never returns an empty name', () => {
  assert.equal(uniqueName('Отправить письмо 📨', new Set()), 'Отправить письмо 📨');
  assert.equal(uniqueName('   ', new Set()), 'Step');
});

test('uniqueName trims long names to 64 characters, still unique', () => {
  const long = 'x'.repeat(100);
  const a = uniqueName(long, new Set());
  assert.equal(a.length, 64);
  const b = uniqueName(long, new Set([a]));
  assert.notEqual(b, a);
  assert.ok(b.length <= 64);
});

test('nodeRef escapes quotes and backslashes', () => {
  assert.equal(nodeRef("It's"), "$('It\\'s')");
  assert.equal(nodeRef('a\\b'), "$('a\\\\b')");
});

test('safeFileName removes characters Windows forbids and is never empty', () => {
  for (const n of ['a/b:c*?', 'x<y>|"z"', '', '...', 'CON', 'trailing. ']) {
    const f = safeFileName(n);
    assert.ok(f.length > 0 && f.length <= 80, n);
    assert.ok(!/[\\/:*?"<>|]/.test(f), f);
    assert.ok(!/^\.+$/.test(f) && !/[. ]$/.test(f), f);
    assert.ok(!/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(f), f);
  }
  assert.equal(safeFileName('Лиды из формы'), 'Лиды из формы');
});
