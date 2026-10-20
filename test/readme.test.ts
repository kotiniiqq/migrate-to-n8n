import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { render } from '../scripts/readme-blocks.ts';
import { allEntries } from '../src/map/registry.ts';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('the generated parts of the README are up to date (npm run readme)', () => {
  assert.equal(render(readme), readme);
});

test('the Contact section is there, word for word', () => {
  assert.ok(readme.includes('## Contact\n\nFeedback, ideas, job offers or custom projects (n8n, MCP, AI automation): [kotiniiqq@gmail.com](mailto:kotiniiqq@gmail.com).\nBug reports and feature requests are welcome in [Issues](https://github.com/kotiniiqq/migrate-to-n8n/issues).'));
});

test('every tool the README names exists, and the registry marker is there', () => {
  for (const t of ['convert_make', 'convert_zapier', 'list_zaps', 'suggest_replacement', 'supported_modules', 'check_n8n_workflow', 'upload_to_n8n']) assert.ok(readme.includes(`\`${t}\``), t);
  assert.ok(readme.includes('<!-- mcp-name: io.github.kotiniiqq/migrate-to-n8n -->'));
  assert.ok(allEntries().length > 150);
});

test('no em dashes and no build-tool credits in the README', () => {
  assert.ok(!readme.includes('—'));
  assert.doesNotMatch(readme, /built with|generated (with|by)|co-authored/i);
});
