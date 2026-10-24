import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, access, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { plan, run, probe } from '../dist/index.js';
import { createDeepseekParser } from '../dist/deepseek-parser.js';

const secret = 'dsh-test-credential-never-persist';
const session = { type: 'session', sessionId: 'test-session' };
const completed = { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } };
const final = { type: 'final', text: 'Finished\nexactly.' };
const step = (number = 1, usage = { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 2 }) => ({ type: 'status', phase: 'step_end', turn: 1, step: number, usage });
function parse(events) {
  const parser = createDeepseekParser(), emitted = events.flatMap(e => parser.push(e));
  return { ...parser.finish(), events: emitted };
}
function request(overrides = {}) {
  return { runId: 'dsh-test', workspace: '/tmp/dsh-workspace', prompt: 'Read the selected rules\nand create a draft.', timeoutMs: 10_000,
    target: { name: 'independent-provider', harness: { adapter: 'deepseek-harness', executable: 'dsh', permission: 'workspace-write', ...overrides },
      backend: { auth: 'api-key', provider: 'custom-gateway', model: 'selected-model', protocol: 'anthropic-messages', baseURL: 'https://backend.example/anthropic/', apiKeyEnv: 'SELECTED_KEY' } } };
}
const patch = execution => JSON.parse(execution.files.find(f => f.path.endsWith('runtime.patch.yml')).content);
test('DSH plan is deterministic, uses an independent Messages provider, and keeps keys out of state', () => {
  const input = request(), p = plan(input), patches = patch(p), config = id => patches.find(e => e.id === id).config;
  assert.deepEqual(plan(input), p);
  assert.deepEqual(p.process.args, ['--profile', 'headless', '--patch', path.join(p.stateDir, 'dsh/runtime.patch.yml'), '--json', '-']);
  assert.equal(p.process.cwd, input.workspace); assert.equal(p.process.stdin, input.prompt);
  assert.deepEqual(config('llm-deepseek'), { baseURL: 'https://backend.example/anthropic', apiKeyEnv: 'JS_AGENT_RUNTIME_API_KEY', models: [{ id: 'selected-model' }] });
  assert.deepEqual(config('agent-default-model'), { provider: 'deepseek-official', model: 'selected-model' });
  assert.deepEqual(p.credential, { ref: 'SELECTED_KEY', envVar: 'JS_AGENT_RUNTIME_API_KEY' });
  assert.equal(p.process.env.JS_AGENT_RUNTIME_API_KEY, undefined);
  assert.equal(p.process.env.DSH_HOME, path.join(p.stateDir, 'dsh'));
  assert.equal(p.process.env.HOME, p.stateDir);
  assert.deepEqual(JSON.parse(p.files.find(f => f.path.endsWith('package.json')).content).dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']);
  for (const id of ['credentials', 'deepseek-account', 'llm-deepseek-account', 'llm-pi-ai', 'plugin-manager', 'tool-subagent', 'otel']) assert.equal(patches.find(e => e.id === id).disabled, true);
});
test('DSH permissions remain explicit; project skills are scoped to the requested workspace', () => {
  for (const permission of ['read-only', 'workspace-write', 'bypass']) {
    const p = plan(request({ permission, contextMode: 'project' })), patches = patch(p), config = id => patches.find(e => e.id === id)?.config;
    const mode = permission === 'bypass' ? 'danger-full-access' : permission;
    assert.deepEqual(config('sandbox-policy'), { mode, workspaceRoot: p.request.workspace });
    assert.deepEqual(config('permission'), { presets: { [mode]: { sandbox: mode, approval: 'never' } }, defaultPreset: mode });
    assert.equal(p.process.env.DSH_PERMISSION_MODE, mode);
    assert.equal(config('approval').policy, 'never');
    assert.deepEqual(config('skill-filesystem'), { includeDefaultRoots: false, customSkillDirs: [path.join(p.request.workspace, '.agents/skills')], watch: false });
    assert.deepEqual(config('agent-instructions').projectRootMarkers, []);
    assert.equal(config('agent-instructions').dshHome, p.process.env.DSH_HOME);
    assert.equal(patches.find(e => e.id === 'tool-bash')?.disabled, permission === 'read-only' ? true : undefined);
  }
  assert.equal(patch(plan(request())).find(e => e.id === 'agent-instructions').disabled, true);
});
test('DSH rejects native auth, wrong protocols, configured sentinel, and unsupported reasoning controls', () => {
  const make = backend => { const r = request(); r.target.backend = backend; return r; };
  for (const auth of ['chatgpt', 'claude-config', 'claude-subscription']) assert.throws(() => plan(make({ auth, model: 'model' })), /api-key/);
  for (const protocol of ['responses', 'chat-completions']) assert.throws(() => plan(make({ ...request().target.backend, protocol })), /anthropic-messages/);
  assert.throws(() => plan(make({ ...request().target.backend, model: 'configured' })), /reserved/);
  assert.throws(() => plan(make({ ...request().target.backend, reasoningEffort: 'high' })), /only supported by Codex/);
});
test('DSH normalizes step usage once, including caches, and retains recoverable tool failures', () => {
  const r = parse([session, { type: 'thinking', text: 'plan' }, { type: 'tool_call', tool: 'read', callId: 'a' },
    { type: 'tool_result', callId: 'a', status: 'error', result: 'missing; recoverable' }, step(),
    step(2, { inputTokens: 20, outputTokens: 6, cacheReadTokens: 5, reasoningTokens: 3 }), { type: 'future_event', model: 'not-response-proof' }, completed, final]);
  assert.equal(r.completed, true); assert.equal(r.failed, false); assert.equal(r.text, final.text);
  assert.deepEqual(r.usage, { inputTokens: 40, outputTokens: 10, totalTokens: 50, cachedInputTokens: 8, reasoningTokens: 5 });
  assert.equal(r.cost, null); assert.equal(r.responseModel, null);
  assert.equal(r.events.filter(e => e.type === 'tool').length, 2);
  assert.equal(r.events.filter(e => e.type === 'usage').length, 2);
});
test('DSH missing and partial usage stay unknown', () => {
  for (const events of [[session, completed, final], [session, step(), { ...step(2), usage: undefined }, completed, final]]) assert.equal(parse(events).usage, null);
  const r = parse([session, step(), step(2, { inputTokens: 20, outputTokens: 6 }), completed, final]);
  assert.deepEqual(r.usage, { inputTokens: 35, outputTokens: 10, totalTokens: 45, cachedInputTokens: null, reasoningTokens: null });
});
test('DSH requires terminal proof and rejects duplicate, conflicting, or trailing events', () => {
  for (const events of [[], [session], [session, final], [session, completed], [completed, final], [session, session, completed, final],
    [session, step(), step(), completed, final], [session, { ...step(), turn: undefined }, completed, final],
    [session, completed, completed, final], [session, { ...completed, reason: { kind: 'aborted' } }, completed, final],
    [session, { type: 'error', message: 'provider failed' }, completed, final], [session, completed, { type: 'final' }],
    [session, null, completed, final], [session, completed, final, { type: 'text', text: 'replace' }], [session, completed, final, { type: 'tool_call' }]]) {
    const r = parse(events); assert.equal(r.completed, false, JSON.stringify(events)); assert.ok(r.error); assert.equal(r.usage, null);
  }
  assert.equal(parse([session, completed, final, { type: 'text', text: 'replace' }]).text, final.text);
  assert.equal(parse([session, { ...completed, reason: { kind: 'error', error: { message: 'model unavailable' } } }, final]).error, 'model unavailable');
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-deepseek-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), executable = path.join(root, 'fake-dsh.mjs');
  await mkdir(workspace);
  await writeFile(executable, `#!${process.execPath}
import fs from 'node:fs'; import assert from 'node:assert/strict'; import path from 'node:path';
if(process.argv.includes('--version')) { assert.equal(process.env.JS_AGENT_RUNTIME_API_KEY,undefined); console.log('0.2.0-rc.2'); process.exit(0); }
const args=process.argv.slice(2); assert.equal(args[0],'--profile'); assert.equal(args[1],'headless'); assert.equal(args.at(-1),'-');
const patches=JSON.parse(fs.readFileSync(args[args.indexOf('--patch')+1],'utf8'));
const config=patches.find(e=>e.id==='llm-deepseek').config;
assert.equal(config.baseURL,'https://backend.example/anthropic'); assert.equal(config.apiKeyEnv,'JS_AGENT_RUNTIME_API_KEY');
assert.ok(process.env.JS_AGENT_RUNTIME_API_KEY); assert.equal(process.env.UNRELATED_PRIVATE_TOKEN,undefined);
let prompt=''; for await(const chunk of process.stdin)prompt+=chunk;
fs.writeFileSync('artifact.txt',prompt);
const emit=e=>console.log(JSON.stringify(e)); emit(${JSON.stringify(session)});
const mode=process.env.FAKE_SCENARIO;
if(mode==='hang') {setInterval(()=>{},1000);} else {
  if(mode==='bad') console.log('not json');
  if(mode==='error') emit({type:'error',message:'failure '+process.env.JS_AGENT_RUNTIME_API_KEY});
  emit(${JSON.stringify(step())}); emit(${JSON.stringify(completed)});
  if(mode!=='missing') emit({type:'final',text:'done '+process.env.JS_AGENT_RUNTIME_API_KEY});
  if(mode==='nonzero') process.exitCode=1;
}
`, { mode: 0o700 });
  const r = request(); Object.assign(r, { workspace, stateDir: path.join(root, 'state') }); r.target.harness.executable = executable;
  return { root, request: r, options: { runDir: path.join(root, 'logs'), resolveCredential: ref => { assert.equal(ref, 'SELECTED_KEY'); return secret; } } };
}
test('DSH executes a file task, redacts credentials, and cleans private state', async t => {
  const f = await fixture(t), events = [];
  const previous = process.env.UNRELATED_PRIVATE_TOKEN; process.env.UNRELATED_PRIVATE_TOKEN = 'unrelated';
  t.after(() => { if (previous === undefined) delete process.env.UNRELATED_PRIVATE_TOKEN; else process.env.UNRELATED_PRIVATE_TOKEN = previous; });
  const r = await run(plan(f.request), { ...f.options, onEvent: e => { events.push(e); } });
  assert.equal(r.status, 'completed', r.error); assert.equal(r.usage.totalTokens, 19);
  assert.equal(await readFile(path.join(f.request.workspace, 'artifact.txt'), 'utf8'), f.request.prompt);
  assert.equal(JSON.stringify(events).includes(secret), false); assert.equal(r.text.includes(secret), false);
  const logs = await Promise.all((await readdir(f.options.runDir)).map(file => readFile(path.join(f.options.runDir, file), 'utf8')));
  assert.equal(logs.join('\n').includes(secret), false);
  await assert.rejects(access(f.request.stateDir));
});
test('DSH metadata probe needs no credentials and accepts bare version numbers', async t => {
  const f = await fixture(t), r = await probe(plan(f.request), { checkExecutable: true, checkLogin: true });
  assert.equal(r.ok, true); assert.equal(r.checks[0].message, '0.2.0-rc.2'); assert.equal(r.checks[1].status, 'skipped');
  await assert.rejects(access(path.join(f.request.workspace, 'artifact.txt')));
});
test('DSH run rejects invalid output and exit status, even after plausible terminal events', async t => {
  for (const scenario of ['bad', 'error', 'missing', 'nonzero']) {
    const f = await fixture(t);
    const r = await run(plan(f.request), { ...f.options, env: { FAKE_SCENARIO: scenario } });
    assert.equal(r.status, 'failed', scenario); assert.ok(r.error); assert.equal(JSON.stringify(r).includes(secret), false);
    if (scenario === 'bad') assert.equal(r.usage, null, 'malformed output may conceal usage samples');
  }
});
test('DSH cancellation and timeout use the shared process lifecycle', async t => {
  for (const cancel of [false, true]) {
    const f = await fixture(t);
    const controller = new AbortController();
    const pending = run(plan({ ...f.request, timeoutMs: cancel ? 5000 : 500, terminationGraceMs: 50 }), { ...f.options, signal: controller.signal, env: { FAKE_SCENARIO: 'hang' } });
    const timer = cancel ? setTimeout(() => controller.abort(), 300) : undefined;
    const r = await pending; clearTimeout(timer);
    assert.equal(r.status, cancel ? 'cancelled' : 'timed_out'); await assert.rejects(access(f.request.stateDir));
  }
});
test('DSH operational environment cannot redirect configuration or inject credentials', async t => {
  const f = await fixture(t);
  for (const key of ['DSH_HOME', 'DSH_PERMISSION_MODE', 'DEEPSEEK_BASE_URL', 'AGENTS_HOME', 'JS_AGENT_RUNTIME_API_KEY']) {
    await assert.rejects(run(plan(f.request), { ...f.options, env: { [key]: 'wrong' } }), /Protected environment/);
  }
  const r = await run(plan(f.request), { resolveCredential: () => undefined });
  assert.equal(r.status, 'failed'); assert.match(r.error, /Missing credential/);
  await assert.rejects(access(path.join(f.request.workspace, 'artifact.txt')));
});
