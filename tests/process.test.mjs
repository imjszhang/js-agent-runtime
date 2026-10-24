import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { plan, run, runProcess, registerAdapter } from '../dist/index.js';

// Lifecycle checks that run on every platform: the agent is the current Node
// executable plus a script, so no shebang or shell is needed.
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check, ms = 5000) {
  const started = Date.now();
  while (!(await check())) { if (Date.now() - started > ms) return false; await new Promise(resolve => setTimeout(resolve, 20)); }
  return true;
}
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runtime-process-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const parent = pidFile => `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`;
async function tree(dir) {
  const script = path.join(dir, 'parent.mjs'), pidFile = path.join(dir, 'grandchild.pid');
  await writeFile(script, parent(pidFile));
  return { processPlan: { executable: process.execPath, args: [script], cwd: dir, stdin: '', env: {} }, pidFile };
}
const grandchild = async pidFile => {
  assert.ok(await until(async () => { try { await access(pidFile); return true; } catch { return false; } }), 'grandchild did not start');
  return Number(await readFile(pidFile, 'utf8'));
};

test('timeout ends the root process and its descendants', async t => {
  const { processPlan, pidFile } = await tree(await fixture(t));
  // Long enough for a slow CI runner to start the grandchild before the deadline.
  const pending = runProcess(processPlan, { timeoutMs: 3000, terminationGraceMs: 50 });
  const pid = await grandchild(pidFile);
  const r = await pending;
  assert.equal(r.timedOut, true); assert.match(r.error, /timed out/); assert.notEqual(r.exitCode ?? r.signal, 0);
  assert.ok(await until(() => !alive(pid)), 'grandchild survived the timeout');
});

test('AbortSignal cancels the root process and its descendants', async t => {
  const { processPlan, pidFile } = await tree(await fixture(t)), controller = new AbortController();
  const pending = runProcess(processPlan, { timeoutMs: 10_000, terminationGraceMs: 50, signal: controller.signal });
  const pid = await grandchild(pidFile);
  controller.abort();
  const r = await pending;
  assert.equal(r.cancelled, true); assert.equal(r.timedOut, false);
  assert.ok(await until(() => !alive(pid)), 'grandchild survived cancellation');
});

test('output beyond the limit terminates the process', async t => {
  const dir = await fixture(t), script = path.join(dir, 'flood.mjs');
  await writeFile(script, "process.stdout.write('x'.repeat(8192) + '\\n'); setInterval(() => {}, 1000);\n");
  const r = await runProcess({ executable: process.execPath, args: [script], cwd: dir, stdin: '', env: {} }, { timeoutMs: 10_000, maxOutputBytes: 2048, terminationGraceMs: 50 });
  assert.match(r.error, /exceeded 2048 bytes/); assert.equal(r.timedOut, false); assert.ok(r.stdout.length <= 2048);
});

test('a normal exit reports its code, stdin and complete stdout/stderr lines', async t => {
  const dir = await fixture(t), script = path.join(dir, 'echo.mjs'), lines = [];
  await writeFile(script, "let input = ''; for await (const chunk of process.stdin) input += chunk;\nconsole.log('read ' + input); console.error('line two'); process.exitCode = 7;\n");
  const r = await runProcess({ executable: process.execPath, args: [script], cwd: dir, stdin: 'prompt text', env: {} }, { timeoutMs: 10_000, onLine: (stream, line) => lines.push([stream, line]) });
  assert.equal(r.exitCode, 7); assert.equal(r.error, null); assert.equal(r.timedOut, false); assert.equal(r.cancelled, false);
  assert.deepEqual(lines.sort(), [['stderr', 'line two'], ['stdout', 'read prompt text']]);
});

test('run executes an extension adapter end to end with the current Node executable', async t => {
  const dir = await fixture(t), workspace = path.join(dir, 'workspace'), script = path.join(dir, 'agent.mjs');
  await mkdir(workspace);
  await writeFile(script, "import { writeFileSync } from 'node:fs';\nlet input = ''; for await (const chunk of process.stdin) input += chunk;\nwriteFileSync('artifact.txt', input);\nconsole.log(JSON.stringify({ done: true }));\n");
  const unregister = registerAdapter({ id: 'process-test-extension', version: '1', validate: () => {},
    plan: request => ({ files: [], process: { executable: process.execPath, args: [script], cwd: request.workspace, stdin: request.prompt, env: {} } }),
    createParser: () => { let done = false; return { push: value => { done ||= value?.done === true; return [{ type: 'message', data: value }]; }, finish: () => ({ completed: done, failed: !done, text: done ? 'done' : '', usage: null, cost: null, sessionId: null, responseModel: null, error: done ? null : 'missing done' }) }; } });
  t.after(unregister);
  const target = { name: 'extension', harness: { adapter: 'process-test-extension', executable: process.execPath, permission: 'workspace-write' }, backend: { auth: 'none', model: 'none' } };
  const r = await run(plan({ runId: 'process-extension', workspace, prompt: 'write the prompt', target, timeoutMs: 10_000, stateDir: path.join(dir, 'state') }), { runDir: path.join(dir, 'logs') });
  assert.equal(r.status, 'completed', r.error); assert.equal(r.exitCode, 0); assert.equal(r.text, 'done');
  assert.equal(await readFile(path.join(workspace, 'artifact.txt'), 'utf8'), 'write the prompt');
  await assert.rejects(access(path.join(dir, 'state')));
});

test('Windows rejects shell launchers and compares paths case-insensitively', { skip: process.platform !== 'win32' && 'Windows path semantics' }, async t => {
  const dir = await fixture(t), workspace = path.join(dir, 'workspace');
  const target = executable => ({ name: 'windows', harness: { adapter: 'codex', executable, permission: 'workspace-write' },
    backend: { auth: 'api-key', provider: 'test', model: 'm', protocol: 'responses', baseURL: 'https://example.invalid/v1', apiKeyEnv: 'TEST_KEY' } });
  const request = (executable, extra = {}) => ({ runId: 'windows', workspace, prompt: 'p', target: target(executable), timeoutMs: 1000, ...extra });
  for (const executable of ['C:\\npm\\codex.cmd', 'codex.CMD', 'codex.bat', 'codex.cmd. ']) assert.throws(() => plan(request(executable)), /native executable on Windows/);
  assert.doesNotThrow(() => plan(request('C:\\Program Files\\codex\\codex.exe')));
  assert.throws(() => plan(request('codex.exe', { stateDir: path.join(workspace.toUpperCase(), 'state') })), /overlap/);
  assert.throws(() => plan(request('codex.exe', { stateDir: workspace.toLowerCase() })), /overlap/);
});
