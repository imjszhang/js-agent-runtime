import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const temp = mkdtempSync(join(tmpdir(), 'js-agent-runtime-package-'));
try {
  const result = execFileSync('npm', ['pack', '--json', '--pack-destination', temp], { encoding: 'utf8' });
  const [{ filename }] = JSON.parse(result);
  writeFileSync(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, filename)], { cwd: temp, stdio: 'inherit' });
  writeFileSync(join(temp, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { plan, probe, run, listAdapters, RUNTIME_VERSION } from 'js-agent-runtime';
assert.equal(RUNTIME_VERSION, ${JSON.stringify(JSON.parse(readFileSync('package.json', 'utf8')).version)});
for (const fn of [plan, probe, run, listAdapters]) assert.equal(typeof fn, 'function');
assert.deepEqual(listAdapters().map(adapter => adapter.id).sort(), ['claude-code', 'codex', 'cursor-agent', 'deepseek-harness', 'opencode']);
assert.ok(JSON.parse(readFileSync(new URL(import.meta.resolve('js-agent-runtime/schema')), 'utf8')));
console.log('Installed tarball imports and schema export passed');
`);
  execFileSync('node', ['smoke.mjs'], { cwd: temp, stdio: 'inherit' });
  writeFileSync(join(temp, 'smoke.mts'), "import { plan, type RunRequest } from 'js-agent-runtime';\nconst build: (request: RunRequest) => unknown = plan;\n");
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--module', 'NodeNext', '--target', 'ES2022', '--strict', '--skipLibCheck', 'smoke.mts'], { cwd: temp, stdio: 'inherit' });
  console.log('Installed tarball TypeScript declarations passed');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
