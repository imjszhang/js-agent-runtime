import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const file = new URL('../src/plan.ts', import.meta.url);
const source = readFileSync(file, 'utf8');
const pattern = /export const RUNTIME_VERSION = "([^"]+)";/;
const match = source.match(pattern);
assert.ok(match, 'RUNTIME_VERSION declaration is missing');
if (process.argv.includes('--check')) {
  assert.equal(match[1], version, 'Package and runtime versions must match');
} else {
  writeFileSync(file, source.replace(pattern, `export const RUNTIME_VERSION = "${version}";`));
}
