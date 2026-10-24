import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { plan, run, probe } from '../dist/index.js';
import { createOpenCodeParser } from '../dist/opencode-parser.js';
import { planOpenCodeInspection, parseOpenCodeInspection } from '../dist/opencode.js';

const tokens = { input: 10, output: 3, reasoning: 2, cache: { read: 7, write: 1 } };
const expectedUsage = { inputTokens: 18, outputTokens: 5, totalTokens: 23, cachedInputTokens: 7, reasoningTokens: 2 };
function request(harness = {}) {
  return { runId: 'opencode-test', workspace: '/tmp/opencode-workspace', prompt: 'Fix it\nwithout interactive input', timeoutMs: 10_000,
    target: { name: 'isolated-opencode', harness: { adapter: 'opencode', executable: 'opencode', permission: 'workspace-write', ...harness },
      backend: { auth: 'api-key', provider: 'custom-gateway', model: 'test-model', protocol: 'chat-completions', baseURL: 'https://backend.example/v1/', apiKeyEnv: 'SELECTED_KEY' } } };
}
const step = (id, reason = 'stop', usage = tokens) => ({ type: 'step_finish', sessionID: 'ses_test', part: { id, messageID: `msg_${id}`, reason, tokens: usage, cost: 0 } });
const text = (id, value, messageID = `msg_${id}`) => ({ type: 'text', sessionID: 'ses_test', part: { id: `text_${id}`, messageID, text: value } });
const start = id => ({ type: 'step_start', sessionID: 'ses_test', part: { id: `start_${id}`, messageID: `msg_${id}` } });
function parse(events) { const parser = createOpenCodeParser(), emitted = events.flatMap(e => parser.push(e)); return { ...parser.finish(), events: emitted }; }
const output = (events, overrides = {}) => ({ stdout: events.map(e => JSON.stringify(e)).join('\n') + '\n', stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false, error: null, ...overrides });
function exported(input = request()) {
  return {
    info: { id: 'ses_test', model: { id: 'test-model', providerID: 'js_agent_runtime' }, outcome: 'succeeded', time: { idle: 20 }, location: { directory: input.workspace }, tokens, cost: 0 },
    messages: [
      { id: 'msg_user', type: 'user', text: input.prompt },
      { id: 'msg_one', type: 'assistant', model: { id: 'test-model', providerID: 'js_agent_runtime' }, time: { completed: 19 }, finish: 'stop', content: [{ type: 'text', text: 'Hello' }] },
      { id: 'msg_idle', type: 'idle', outcome: 'succeeded' },
    ],
  };
}
const inspection = (value = exported(), overrides = {}) => output([], { stdout: JSON.stringify(value), ...overrides });
const missingTerminal = () => output([start('one'), text('one', 'Hel')]);

test('OpenCode V2 plan is deterministic, isolated and credential free on disk', () => {
  const input = request(), p = plan(input), config = JSON.parse(p.files[0].content);
  assert.deepEqual(plan(input), p);
  assert.deepEqual(p.process.args, ['run', '--standalone', '--format', 'json', '--thinking', '--model', 'js_agent_runtime/test-model', '--agent', 'build']);
  assert.equal(p.process.cwd, input.workspace); assert.equal(p.process.stdin, input.prompt);
  assert.equal(p.process.env.PWD, input.workspace); assert.equal(p.process.env.GIT_CEILING_DIRECTORIES, input.workspace);
  assert.equal(p.process.env.HOME, path.join(p.stateDir, 'opencode'));
  assert.equal(p.process.env.JS_AGENT_RUNTIME_API_KEY, undefined);
  assert.deepEqual(p.credential, { ref: 'SELECTED_KEY', envVar: 'JS_AGENT_RUNTIME_API_KEY' });
  for (const flag of ['OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_DISABLE_AUTOUPDATE']) assert.equal(p.process.env[flag], '1');
  assert.ok(p.files.every(f => f.path.startsWith(p.stateDir + path.sep)));
  assert.equal(config.providers.js_agent_runtime.package, '@opencode/ai/providers/openai-compatible');
  assert.equal(config.providers.js_agent_runtime.settings.baseURL, 'https://backend.example/v1');
  assert.deepEqual(config.providers.js_agent_runtime.env, ['JS_AGENT_RUNTIME_API_KEY']);
  assert.equal(config.providers.js_agent_runtime.models['test-model'].cost, undefined);
  assert.deepEqual(config.agents.title, { disabled: true }); assert.deepEqual(config.agents.summary, { disabled: true });
  assert.equal(config.warming, false);
  for (const disabled of ['-opencode.config.instruction', '-opencode.config.skill', '-opencode.config.compatibility', '-opencode.skill']) assert.ok(config.plugins.includes(disabled));
});

test('OpenCode permissions grant only local read tools or explicit editing and shell', () => {
  for (const permission of ['read-only', 'workspace-write']) {
    const config = JSON.parse(plan(request({ permission })).files[0].content);
    assert.deepEqual(config.permissions.filter(r => r.effect === 'allow').map(r => r.action), permission === 'read-only' ? ['read', 'glob', 'grep'] : ['read', 'glob', 'grep', 'edit', 'shell']);
    assert.deepEqual(config.agents.build.permissions, config.permissions);
    assert.ok(config.permissions.some(r => r.action === 'external_directory' && r.effect === 'deny'));
  }
  for (const overrides of [{ permission: 'bypass' }, { contextMode: 'project' }]) assert.throws(() => plan(request(overrides)));
  for (const protocol of ['responses', 'anthropic-messages']) { const input = request(); input.target.backend.protocol = protocol; assert.throws(() => plan(input), /chat-completions/); }
  for (const auth of ['chatgpt', 'claude-config', 'claude-subscription']) { const input = request(); input.target.backend = { auth, model: 'test-model' }; assert.throws(() => plan(input)); }
});

test('OpenCode shell hook uses undefined tombstones so merged parent credentials stay removed', async () => {
  const plugin = plan(request()).files.find(f => f.path.endsWith('index.mjs'));
  const sandbox = { plugin: null }; vm.runInNewContext(plugin.content.replace('export default', 'plugin ='), sandbox);
  let hook;
  await sandbox.plugin.setup({ shell: { hook: async (name, fn) => { assert.equal(name, 'create.before'); hook = fn; } } });
  const parent = { PATH: '/bin', HOME: '/isolated', JS_AGENT_RUNTIME_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret2', OPENCODE_CONFIG_CONTENT: 'secret3' };
  const invocation = { env: { ...parent } }; hook(invocation);
  const merged = { ...parent, ...invocation.env };
  for (const key of ['JS_AGENT_RUNTIME_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENCODE_CONFIG_CONTENT']) { assert.equal(merged[key], undefined); assert.ok(Object.hasOwn(invocation.env, key)); }
  assert.equal(merged.PATH, '/bin'); assert.equal(merged.HOME, '/isolated');
});

test('OpenCode normalizes deduplicated steps including cache and reasoning with unknown price', () => {
  const second = step('two'), result = parse([text('one', 'Inspecting'), step('one', 'tool-calls'), text('two', 'Done'), second, second]);
  assert.equal(result.completed, true); assert.equal(result.failed, false); assert.equal(result.text, 'Done');
  assert.equal(result.sessionId, 'ses_test'); assert.equal(result.responseModel, null); assert.equal(result.cost, null);
  assert.deepEqual(result.usage, { inputTokens: 36, outputTokens: 10, totalTokens: 46, cachedInputTokens: 14, reasoningTokens: 4 });
  assert.equal(result.events.filter(e => e.type === 'usage').length, 2);
});

test('OpenCode preserves tool events and final content, including reconciliation suffix deduplication', () => {
  const suffix = { type: 'text', sessionID: 'ses_test', part: { id: 'prt_final_text-0', messageID: 'msg_final', text: 'lo' } };
  const tool = { type: 'tool_use', sessionID: 'ses_test', part: { id: 'call', messageID: 'msg_final', tool: 'read', state: { status: 'completed' } } };
  const result = parse([tool, text('prefix', 'Hel', 'msg_final'), text('next', ' world', 'msg_final'), step('final'), suffix, suffix, { type: 'future_event' }]);
  assert.equal(result.completed, true); assert.equal(result.text, 'Hello world'); assert.ok(result.events.some(e => e.type === 'tool'));
  assert.equal(parse([step('final'), suffix, { ...suffix, part: { ...suffix.part, text: 'conflict' } }]).failed, true);
});

test('OpenCode final output cannot promote intermediate commentary', () => {
  assert.equal(parse([text('one', 'Intermediate'), step('one', 'tool-calls'), step('two')]).text, '');
  const recovered = { type: 'text', sessionID: 'ses_test', part: { id: 'prt_one_text-0', messageID: 'msg_one', text: 'Earlier' } };
  assert.equal(parse([step('one', 'tool-calls'), text('two', 'Final'), step('two'), recovered]).text, 'Final');
});

test('OpenCode incomplete counters or delegated calls have unknown aggregate usage', () => {
  for (const usage of [{}, { input: 1, output: 2, reasoning: 0 }, { ...tokens, output: -1 }]) assert.equal(parse([step('one', 'tool-calls', usage), step('two')]).usage, null);
  for (const tool of ['task', 'subagent']) assert.equal(parse([{ type: 'tool_use', sessionID: 'ses_test', part: { messageID: 'msg_one', tool } }, step('one')]).usage, null);
});

test('OpenCode rejects malformed, conflicting and out-of-order terminal events', () => {
  for (const events of [[], [text('one', 'Partial')], [step('one', 'tool-calls')], [step('one', 'length')], [step('one'), start('two')],
    [step('one'), text('two', 'Unexpected')], [{ ...step('one'), sessionID: undefined }], [step('one'), { type: 'error', error: { message: 'failed' } }],
    [step('one'), { ...text('one', 'text'), sessionID: 'ses_other' }], [step('one'), step('one', 'stop', { ...tokens, input: 3 })], [null]]) {
    const parsed = parse(events); assert.equal(parsed.completed, false, JSON.stringify(events)); assert.equal(parsed.failed, true); assert.ok(parsed.error);
  }
  assert.equal(parse([{ type: 'error', error: { data: { message: 'Invalid API key' } } }]).error, 'Invalid API key');
});

test('OpenCode inspection plan reads only the isolated session without model credentials', () => {
  const input = request(), p = plan(input), inspected = planOpenCodeInspection(input, p.stateDir, 'ses_test');
  assert.deepEqual(inspected.args, ['session', 'export', '--standalone', 'ses_test']); assert.equal(inspected.stdin, '');
  assert.equal(inspected.env.HOME, p.process.env.HOME); assert.equal(inspected.env.JS_AGENT_RUNTIME_API_KEY, undefined);
  assert.throws(() => planOpenCodeInspection(input, p.stateDir, '--other'), /Invalid OpenCode session/);
});

test('OpenCode export recovers the missing terminal race with durable final output and full usage', () => {
  const result = parseOpenCodeInspection(request(), missingTerminal(), inspection());
  assert.equal(result.completed, true); assert.equal(result.failed, false); assert.equal(result.error, null); assert.equal(result.text, 'Hello');
  assert.equal(result.cost, null); assert.deepEqual(result.usage, expectedUsage);
  assert.ok(result.events.some(e => e.type === 'raw' && e.data.source === 'opencode-session-export'));
});

test('OpenCode export cannot recover native errors, malformed streams, exits or cancellation', () => {
  for (const original of [output([step('one', 'length')]), output([step('one'), text('two', 'unexpected')]), output([step('one'), { type: 'error', error: { message: 'OpenCode ended without a terminal stop step' } }]),
    output([step('one')], { stdout: JSON.stringify(step('one')) + '\ninvalid' }), output([step('one')], { exitCode: 1 }), output([step('one')], { timedOut: true }), output([step('one')], { cancelled: true })]) {
    assert.equal(parseOpenCodeInspection(request(), original, inspection()).completed, false);
  }
});

test('OpenCode export must match session, backend, workspace, prompt, messages and terminal proof', () => {
  const valid = exported();
  const cases = [
    { ...valid, info: { ...valid.info, id: 'ses_other' } },
    { ...valid, info: { ...valid.info, model: { ...valid.info.model, id: 'other-model' } } },
    { ...valid, info: { ...valid.info, model: { ...valid.info.model, providerID: 'unexpected' } } },
    { ...valid, info: { ...valid.info, location: { directory: '/other' } } },
    { ...valid, info: { ...valid.info, outcome: 'running' } },
    { ...valid, messages: valid.messages.slice(0, -1) },
    { ...valid, messages: valid.messages.map(m => m.type === 'idle' ? { ...m, outcome: 'failed' } : m) },
    { ...valid, messages: valid.messages.map(m => m.type === 'user' ? { ...m, text: 'different prompt' } : m) },
    { ...valid, messages: valid.messages.map(m => m.type === 'assistant' ? { ...m, id: 'msg_other' } : m) },
    { ...valid, messages: valid.messages.map(m => m.type === 'assistant' ? { ...m, finish: 'tool-calls' } : m) },
    { ...valid, messages: valid.messages.map(m => m.type === 'assistant' ? { ...m, time: {} } : m) },
    { ...valid, messages: valid.messages.map(m => m.type === 'assistant' ? { ...m, content: [{ type: 'text', text: 'Wrong response' }] } : m) },
  ];
  for (const value of cases) assert.equal(parseOpenCodeInspection(request(), missingTerminal(), inspection(value)).completed, false);
  for (const overrides of [{ stdout: 'not JSON' }, { exitCode: 1 }, { timedOut: true }, { cancelled: true }, { error: 'spawn unavailable' }]) {
    const result = parseOpenCodeInspection(request(), missingTerminal(), inspection(undefined, overrides)); assert.equal(result.completed, false); assert.equal(result.usage, null);
  }
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-opencode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), executable = path.join(root, 'fake-opencode.mjs'); await mkdir(workspace);
  await writeFile(executable, `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
const args=process.argv.slice(2), mode=process.env.TEST_SCENARIO;
if(args.includes('--version')) { assert.equal(process.env.JS_AGENT_RUNTIME_API_KEY,undefined); console.log(mode==='old-version'?'opencode 1.4.0':'opencode 2.0.32'); process.exit(0); }
if(args[0]==='session') {
  assert.deepEqual(args,['session','export','--standalone','ses_test']); assert.equal(process.env.JS_AGENT_RUNTIME_API_KEY,undefined);
  if(mode==='inspection-timeout') await new Promise(r=>setTimeout(r,2000));
  if(mode==='inspection-overflow') { console.log('x'.repeat(2048)); process.exit(0); }
  const value=JSON.parse(fs.readFileSync(path.join(process.env.HOME,'session.json'),'utf8'));
  if(mode==='bad-export') value.info.location.directory='/wrong-workspace';
  console.log(JSON.stringify(value)); process.exit(0);
}
assert.equal(args[0],'run'); assert.equal(process.env.JS_AGENT_RUNTIME_API_KEY,'opencode-test-secret');
assert.equal(process.env.UNRELATED_PRIVATE_TOKEN,undefined);
let prompt=''; for await(const chunk of process.stdin) prompt+=chunk;
const value={info:{id:'ses_test',model:{id:'test-model',providerID:'js_agent_runtime'},outcome:'succeeded',time:{idle:20},location:{directory:process.cwd()},tokens:${JSON.stringify(tokens)}},messages:[{id:'msg_user',type:'user',text:prompt},{id:'msg_one',type:'assistant',model:{id:'test-model',providerID:'js_agent_runtime'},time:{completed:19},finish:'stop',content:[{type:'text',text:'Hello'}]},{id:'msg_idle',type:'idle',outcome:'succeeded'}]};
fs.writeFileSync(path.join(process.env.HOME,'session.json'),JSON.stringify(value));
if(mode==='no-session') { console.log(JSON.stringify({type:'step_finish',part:{id:'one',messageID:'msg_one',reason:'stop',tokens:${JSON.stringify(tokens)}}})); process.exit(0); }
if(mode==='malformed') { console.log('{incomplete'); process.exit(0); }
console.log(JSON.stringify(${JSON.stringify(start('one'))})); console.log(JSON.stringify(${JSON.stringify(text('one', 'Hel'))}));
if(mode==='main-failure'||mode==='main-timeout') {
 console.log(JSON.stringify(${JSON.stringify(step('one', 'stop'))}));
 if(mode==='main-failure')process.exit(1);
 setInterval(()=>{},1000); await new Promise(()=>{});
}
if(mode==='native-error') console.log(JSON.stringify({type:'error',sessionID:'ses_test',error:{message:'upstream failed'}}));
`, { mode: 0o700 });
  const input = request({ executable }); input.workspace = workspace; input.stateDir = path.join(root, 'state');
  return { input, root };
}

test('OpenCode runtime verifies a durable export, redacts logs and cleans isolated state', async t => {
  const { input, root } = await fixture(t), runDir = path.join(root, 'logs'), observed = [];
  const result = await run(plan(input), { runDir, resolveCredential: () => 'opencode-test-secret', onEvent: e => { observed.push(e); } });
  assert.equal(result.status, 'completed', result.error); assert.equal(result.text, 'Hello'); assert.deepEqual(result.usage, expectedUsage);
  assert.ok(observed.some(e => e.type === 'raw' && e.data.source === 'opencode-session-export'));
  assert.equal((await readFile(path.join(runDir, 'result.json'), 'utf8')).includes('opencode-test-secret'), false);
  await assert.rejects(access(input.stateDir), /ENOENT/);
});

test('OpenCode runtime rejects mismatched exports and preserves native stream errors', async t => {
  for (const mode of ['bad-export', 'native-error']) {
    const { input } = await fixture(t);
    const result = await run(plan(input), { resolveCredential: () => 'opencode-test-secret', env: { TEST_SCENARIO: mode } });
    assert.equal(result.status, 'failed'); assert.equal(result.usage, null);
    assert.match(result.error, mode === 'bad-export' ? /workspace/ : /upstream failed/);
  }
});

test('OpenCode inspection shares the task deadline and version checks reject V1', async t => {
  const { input } = await fixture(t); input.timeoutMs = 600;
  const result = await run(plan(input), { resolveCredential: () => 'opencode-test-secret', env: { TEST_SCENARIO: 'inspection-timeout' } });
  assert.equal(result.status, 'timed_out'); assert.equal(result.usage, null);
  const old = await probe(plan(input), { checkExecutable: true, env: { TEST_SCENARIO: 'old-version' } });
  assert.equal(old.ok, false);
});


test('OpenCode zero exit cannot bypass missing sessions, malformed events or bounded export output', async t => {
  for (const mode of ['no-session', 'malformed', 'inspection-overflow']) {
    const { input } = await fixture(t); input.maxOutputBytes = 1024;
    const result = await run(plan(input), { resolveCredential: () => 'opencode-test-secret', env: { TEST_SCENARIO: mode } });
    assert.equal(result.status, 'failed', mode); assert.equal(result.usage, null); assert.ok(result.error);
    if (mode === 'inspection-overflow') assert.match(result.error, /output exceeded/);
  }
});

test('OpenCode V1 run is refused before resolving the model credential', async t => {
  const { input } = await fixture(t); let resolved = false;
  const result = await run(plan(input), { resolveCredential: () => { resolved = true; return 'opencode-test-secret'; }, env: { TEST_SCENARIO: 'old-version' } });
  assert.equal(result.status, 'failed'); assert.match(result.error, /V2/); assert.equal(resolved, false);
});

test('OpenCode never reports stream counters as complete usage without successful inspection', async t => {
  for (const mode of ['main-failure', 'main-timeout']) {
    const { input } = await fixture(t); input.timeoutMs = 600; input.terminationGraceMs = 30;
    const result = await run(plan(input), { resolveCredential: () => 'opencode-test-secret', env: { TEST_SCENARIO: mode } });
    assert.equal(result.status, mode === 'main-timeout' ? 'timed_out' : 'failed');
    assert.equal(result.usage, null);
  }
});
