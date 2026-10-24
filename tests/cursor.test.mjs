import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, access, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { plan, run, probe, runProcess } from '../dist/index.js';
import { createCursorParser } from '../dist/cursor-parser.js';
import { CURSOR_AGENT_VERSION, assertCursorAgentVersion, cursorEnvironment, cursorVersionProcess, cursorLoginProcess, parseCursorAccountStatus, assertCursorWorkspace } from '../dist/cursor.js';
import { planCursorShell } from '../dist/cursor-shell.js';
import { planCursorLauncher } from '../dist/cursor-launcher.js';
import { planCursorRuntime } from '../dist/cursor-runtime.js';

const secret = 'cursor-test-secret-never-persist';
function request(harness = {}, backend = {}) {
  return { runId: 'cursor-test', workspace: '/tmp/cursor-workspace', prompt: 'Create the draft.\nPreserve Chinese: 中文。', timeoutMs: 10_000,
    target: { name: 'native-cursor', harness: { adapter: 'cursor-agent', executable: 'cursor-agent', permission: 'workspace-write', ...harness },
      backend: { auth: 'cursor-api-key', model: 'auto', ...backend } } };
}
const init = (r = request(), source = 'env') => ({ type: 'system', subtype: 'init', session_id: 'ses_cursor', cwd: r.workspace, apiKeySource: source, model: 'display label' });
const final = { type: 'result', subtype: 'success', is_error: false, session_id: 'ses_cursor', result: 'Completed exactly.', usage: { input_tokens: 0, output_tokens: 0 } };
function parsed(events, r = request()) { const parser = createCursorParser(r); const emitted = events.flatMap(event => parser.push(event)); return { ...parser.finish(), events: emitted }; }
const config = (p, suffix) => JSON.parse(p.files.find(file => file.path.endsWith(suffix)).content);

test('Cursor plan is deterministic, native, isolated and credential-free', () => {
  const r = request({ useHttp1ForAgent: true, nativeStallTimeoutMs: 120_000 }), p = plan(r);
  assert.deepEqual(plan(r), p);
  assert.deepEqual(p.credential, { ref: 'CURSOR_API_KEY', envVar: 'CURSOR_API_KEY' });
  assert.equal(p.process.env.CURSOR_API_KEY, undefined);
  assert.equal(p.process.env.HOME, p.stateDir); assert.equal(p.process.env.AGENT_CLI_CREDENTIAL_STORE, 'memory');
  assert.equal(p.process.env.NODE_USE_ENV_PROXY, '1'); assert.equal(p.process.executable, '/bin/bash');
  assert.equal(p.process.cwd, r.workspace); assert.equal(p.process.stdin, r.prompt);
  assert.ok(p.process.args.includes('--trust')); assert.ok(p.process.args.includes('--disable-project-configs'));
  assert.equal(p.process.args[p.process.args.indexOf('--sandbox') + 1], 'enabled');
  const settings = config(p, 'cli-config.json'); assert.deepEqual(settings.network, { useHttp1ForAgent: true });
  assert.deepEqual(settings.permissions.allow, [`Read(${r.workspace}/**)`, `Write(${r.workspace}/**)`]);
  assert.ok(settings.permissions.deny.includes('Mcp(*:*)')); assert.ok(!settings.permissions.allow.includes('Shell(*)'));
  assert.deepEqual(config(p, 'compatibility.json').nativeStallTimeoutMs, 120_000);
  assert.equal(config(p, 'sandbox.json').type, 'workspace_readwrite');
  assert.match(p.process.env.NODE_OPTIONS, /cursor-runtime\/preload.cjs/);
  assert.equal(plan(request({}, { apiKeyEnv: 'SELECTED_CURSOR_KEY' })).credential.ref, 'SELECTED_CURSOR_KEY');
});

test('Cursor permission levels are explicit and HTTP transport remains opt-in', () => {
  const ro = plan(request({ permission: 'read-only' }));
  assert.equal(ro.process.args[ro.process.args.indexOf('--mode') + 1], 'ask');
  assert.equal(config(ro, 'sandbox.json').type, 'workspace_readonly');
  assert.equal(config(ro, 'cli-config.json').network, undefined);
  assert.equal(ro.process.env.NODE_OPTIONS, undefined);
  const full = plan(request({ permission: 'bypass' }));
  assert.equal(full.process.args[full.process.args.indexOf('--sandbox') + 1], 'disabled');
  assert.ok(full.process.args.includes('--force')); assert.ok(!full.process.args.includes('--allowed-tools'));
  assert.equal(full.process.env.SHELL, '/bin/bash'); assert.equal(full.process.env.PATH, process.env.PATH ?? '/usr/bin:/bin');
  assert.deepEqual(config(full, 'cli-config.json').permissions, { allow: ['Read(*)', 'Write(*)', 'Shell(*)', 'WebFetch(*)'], deny: ['Mcp(*:*)'] });
  assert.equal(config(full, 'sandbox.json').type, 'insecure_none');
});

test('Cursor rejects provider routing, foreign auth/options, path patterns and unsupported versions', () => {
  for (const backend of [{ auth: 'api-key' }, { auth: 'claude-subscription' }, { provider: 'deepseek' }, { protocol: 'responses' }, { baseURL: 'https://api.example' }, { reasoningEffort: 'high' }, { apiKeyEnv: 'bad-name' }, { model: 'configured' }]) assert.throws(() => plan(request({}, backend)));
  for (const nativeStallTimeoutMs of [29_999, 300_001, 30_000.5, NaN]) assert.throws(() => plan(request({ nativeStallTimeoutMs })));
  assert.throws(() => plan({ ...request(), workspace: '/tmp/pattern[workspace]' }), /pattern/);
  assert.doesNotThrow(() => assertCursorAgentVersion(`${CURSOR_AGENT_VERSION}\n`));
  assert.throws(() => assertCursorAgentVersion('2026.07.24-other'), /reviewed version/);
  const other = request(); other.target.harness.adapter = 'codex'; other.target.harness.useHttp1ForAgent = true;
  assert.throws(() => plan(other));
});

test('Cursor metadata plans avoid launcher, preload and API credentials', () => {
  const r = request({ nativeStallTimeoutMs: 300_000, useCurrentUserHomeForLogin: true });
  const p = plan(r); assert.equal(p.process.env.HOME, p.stateDir, 'API-key mode stays isolated on macOS and Linux even with the login-only flag');
  const version = cursorVersionProcess(r, '/tmp/cursor-probe');
  assert.equal(version.executable, 'cursor-agent'); assert.equal(version.env.NODE_OPTIONS, undefined);
  assert.equal(version.env.HOME, '/tmp/cursor-probe'); assert.equal(version.env.CURSOR_API_KEY, undefined);
  assert.equal(version.env.AGENT_CLI_CREDENTIAL_STORE, 'memory'); assert.equal(version.stdin, '');
  if (process.platform !== 'darwin') {
    assert.throws(() => plan(request({}, { auth: 'cursor-login' })), /macOS Keychain/);
    assert.throws(() => cursorEnvironment('/tmp/cursor-probe', 'cursor-login', true), /macOS Keychain/);
  }
});

test('Cursor login retains current HOME only by explicit opt-in and reports safe metadata', { skip: process.platform !== 'darwin' }, () => {
  const r = request({ useCurrentUserHomeForLogin: true }, { auth: 'cursor-login' });
  const p = plan(r), metadata = cursorLoginProcess(r, '/tmp/cursor-account');
  assert.equal(p.process.env.HOME, os.homedir()); assert.equal(metadata.env.HOME, os.homedir());
  assert.equal(p.process.env.CURSOR_CONFIG_DIR, path.join(p.stateDir, '.cursor')); assert.equal(p.credential, undefined);
  assert.equal(cursorEnvironment('/tmp/cursor-account', 'cursor-login').HOME, '/tmp/cursor-account');
  const status = parseCursorAccountStatus(JSON.stringify({ status: 'authenticated', isAuthenticated: true, hasAccessToken: true, hasRefreshToken: true, email: 'hidden@example.com', accessToken: 'never-return' }));
  assert.deepEqual(status, { auth: 'cursor-login', credentialPresent: true, verified: false });
  assert.equal(JSON.stringify(status).includes('hidden'), false);
  assert.equal(parseCursorAccountStatus(JSON.stringify({ status: 'partially-authenticated', isAuthenticated: false, hasAccessToken: true, hasRefreshToken: false })).credentialPresent, false);
  assert.throws(() => parseCursorAccountStatus(JSON.stringify({ status: 'authenticated', isAuthenticated: false, hasAccessToken: true, hasRefreshToken: true })), /inconsistent/);
});

test('Cursor output uses terminal result and leaves unknown usage, cost and model null', () => {
  const r = parsed([init(), { type: 'assistant', session_id: 'ses_cursor', message: { content: 'duplicate partial' } }, { type: 'assistant', session_id: 'ses_cursor', message: { content: 'duplicate partial' } }, { type: 'tool_call', session_id: 'ses_cursor', tool_call: {} }, final]);
  assert.equal(r.completed, true); assert.equal(r.failed, false); assert.equal(r.text, final.result);
  assert.equal(r.usage, null); assert.equal(r.cost, null); assert.equal(r.responseModel, null); assert.equal(r.sessionId, 'ses_cursor');
  assert.equal(r.events.filter(e => e.type === 'message').length, 2); assert.equal(r.events.filter(e => e.type === 'usage').length, 1);
});

test('Cursor requires consistent initialization and terminal proof, and rejects all later events', () => {
  for (const events of [[], [init()], [final], [init(), init(), final], [init(), { ...final, is_error: true }], [init(), { ...final, subtype: 'failure' }],
    [init(), { ...final, session_id: 'other' }], [{ ...init(), cwd: '/other' }, final], [{ ...init(), apiKeySource: 'login' }, final],
    [null, init(), final], [init(), final, final], [init(), final, { type: 'future' }], [init(), { type: 'error', message: 'bad' }, final]]) {
    const r = parsed(events); assert.equal(r.completed, false, JSON.stringify(events)); assert.equal(r.failed, true); assert.ok(r.error);
  }
});

async function fixture(t, auth = 'cursor-api-key') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-cursor-')); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), executable = path.join(root, 'cursor-agent'), logic = path.join(root, 'native.mjs');
  await mkdir(workspace);
  await writeFile(executable, `#!/usr/bin/env bash\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${logic.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
  await writeFile(logic, `import fs from 'node:fs'; import assert from 'node:assert/strict'; import cp from 'node:child_process';
const args=process.argv.slice(2), mode=process.env.FAKE_SCENARIO;
if(args.includes('--version')) { assert.equal(process.env.CURSOR_API_KEY,undefined); assert.equal(process.env.NODE_OPTIONS,undefined); assert.equal(process.env.AGENT_CLI_CREDENTIAL_STORE,'memory'); console.log(mode==='version'?'unreviewed':${JSON.stringify(CURSOR_AGENT_VERSION)}); process.exit(0); }
if(args.includes('status')) { assert.equal(process.env.CURSOR_API_KEY,undefined); console.log(JSON.stringify({status:mode==='absent'?'unauthenticated':'authenticated',isAuthenticated:mode!=='absent',hasAccessToken:mode!=='absent',hasRefreshToken:mode!=='absent',email:'must-not-emit@example.com'})); process.exit(0); }
assert.ok(args.includes('--trust')); assert.equal(process.env.UNRELATED_TOKEN,undefined);
let input=''; for await(const chunk of process.stdin)input+=chunk;
fs.writeFileSync('artifact.txt',input);
if(process.env.AGENT_CLI_CREDENTIAL_STORE==='memory')assert.ok(process.env.CURSOR_API_KEY);
const tool=cp.spawnSync('bash',['-c','printf "%s|%s|%s" "'+ '$' + '{CURSOR_API_KEY-unset}" "'+ '$' + '{NODE_OPTIONS-unset}" "'+ '$' + 'HOME"'],{encoding:'utf8'});
if(!args.includes('--force'))assert.equal(tool.stdout,'unset|unset|'+process.env.XDG_CONFIG_HOME.replace(/\\/\\.config$/,''));
else {assert.equal(args[args.indexOf('--sandbox')+1],'disabled');assert.equal(args.includes('--allowed-tools'),false);assert.equal(process.env.SHELL,'/bin/bash');assert.equal(tool.stdout,process.env.CURSOR_API_KEY+'|unset|'+process.env.HOME);}
const emit=e=>console.log(JSON.stringify(e));
emit({type:'system',subtype:'init',session_id:'ses_cursor',cwd:mode==='workspace'?'/wrong':process.cwd(),apiKeySource:process.env.AGENT_CLI_CREDENTIAL_STORE==='default'?'login':'env'});
if(mode==='hang')setInterval(()=>{},1000);else{
 if(mode==='malformed')console.log('not JSON'); if(mode==='error')emit({type:'error',message:'failure '+process.env.CURSOR_API_KEY});
 if(mode!=='missing')emit({type:'result',subtype:'success',is_error:false,session_id:'ses_cursor',result:'done '+(process.env.CURSOR_API_KEY??''),usage:{input_tokens:99}});
 if(mode==='nonzero')process.exitCode=1;
}
`);
  const r = request({}, { auth }); Object.assign(r, { workspace, stateDir: path.join(root, 'state') }); r.target.harness.executable = executable;
  return { root, request: r, options: { runDir: path.join(root, 'logs'), resolveCredential: ref => { assert.equal(ref, 'CURSOR_API_KEY'); return secret; } } };
}

test('Cursor executes through native launcher, scrubs tool credentials and persists only redacted output', async t => {
  const f = await fixture(t), events = [];
  const r = await run(plan(f.request), { ...f.options, onEvent: event => { events.push(event); } });
  assert.equal(r.status, 'completed', r.error); assert.equal(r.usage, null); assert.equal(r.cost, null);
  assert.equal(await readFile(path.join(f.request.workspace, 'artifact.txt'), 'utf8'), f.request.prompt);
  const logs = await Promise.all((await readdir(f.options.runDir)).map(file => readFile(path.join(f.options.runDir, file), 'utf8')));
  assert.equal(logs.join('\n').includes(secret), false); assert.equal(JSON.stringify(events).includes(secret), false);
  await assert.rejects(access(f.request.stateDir));
});

test('Cursor explicit bypass executes with native shell and disabled sandbox', async t => {
  const f = await fixture(t); f.request.target.harness.permission = 'bypass';
  const r = await run(plan(f.request), f.options);
  assert.equal(r.status, 'completed', r.error); assert.equal(r.text.includes(secret), false);
  assert.equal(await readFile(path.join(f.request.workspace, 'artifact.txt'), 'utf8'), f.request.prompt);
  await assert.rejects(access(f.request.stateDir));
});

test('Cursor preflight rejects unreviewed versions and .cursor input before native task execution', async t => {
  for (const scenario of ['version', 'config']) {
    const f = await fixture(t);
    if (scenario === 'config') await writeFile(path.join(f.request.workspace, '.cursor'), 'user input preserved');
    const r = await run(plan(f.request), { ...f.options, env: { FAKE_SCENARIO: scenario } });
    assert.equal(r.status, 'failed'); await assert.rejects(access(path.join(f.request.workspace, 'artifact.txt')));
    if (scenario === 'config') assert.equal(await readFile(path.join(f.request.workspace, '.cursor'), 'utf8'), 'user input preserved');
  }
});

test('Cursor metadata probe uses original CLI without running a task or resolving credentials', async t => {
  const f = await fixture(t);
  const r = await probe(plan(f.request), { checkExecutable: true, checkLogin: true });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.checks[1].status, 'skipped');
  await assert.rejects(access(path.join(f.request.workspace, 'artifact.txt')));
  const wrong = await probe(plan(f.request), { checkExecutable: true, env: { FAKE_SCENARIO: 'version' } }); assert.equal(wrong.ok, false);
});

test('Cursor metadata and execution select the same CLI when an operational PATH differs', async t => {
  const f = await fixture(t), originalPath = process.env.PATH;
  t.after(() => { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; });
  process.env.PATH = `${f.root}${path.delimiter}${originalPath ?? '/usr/bin:/bin'}`;
  f.request.target.harness.executable = 'cursor-agent';
  const replacement = path.join(f.root, 'replacement'); await mkdir(replacement);
  await writeFile(path.join(replacement, 'cursor-agent'), '#!/bin/bash\nexit 91\n', { mode: 0o700 });
  const execution = plan(f.request), env = { PATH: replacement + path.delimiter + (originalPath ?? '/usr/bin:/bin') };
  assert.equal((await probe(execution, { checkExecutable: true, env })).ok, true);
  const result = await run(execution, { ...f.options, env });
  assert.equal(result.status, 'completed', result.error);
});

test('Cursor native login is checked before execution and incomplete login never falls back to API key', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t, 'cursor-login');
  const r = await run(plan(f.request), { ...f.options, resolveCredential: () => { throw new Error('must not resolve'); }, env: { FAKE_SCENARIO: 'absent' } });
  assert.equal(r.status, 'failed'); await assert.rejects(access(path.join(f.request.workspace, 'artifact.txt')));
  assert.equal(JSON.stringify(r).includes('must-not-emit'), false);
});

test('Cursor malformed streams, bad metadata and nonzero exits cannot produce success', async t => {
  for (const scenario of ['malformed', 'error', 'missing', 'workspace', 'nonzero']) {
    const f = await fixture(t), r = await run(plan(f.request), { ...f.options, env: { FAKE_SCENARIO: scenario } });
    assert.equal(r.status, 'failed', scenario); assert.ok(r.error); assert.equal(JSON.stringify(r).includes(secret), false);
  }
});

test('Cursor cancellation and timeout use the shared process lifecycle', async t => {
  for (const cancel of [false, true]) {
    const f = await fixture(t), controller = new AbortController();
    const pending = run(plan({ ...f.request, timeoutMs: cancel ? 5000 : 500, terminationGraceMs: 30 }), { ...f.options, signal: controller.signal, env: { FAKE_SCENARIO: 'hang' } });
    const timer = cancel ? setTimeout(() => controller.abort(), 300) : undefined;
    const r = await pending; clearTimeout(timer); assert.equal(r.status, cancel ? 'cancelled' : 'timed_out'); await assert.rejects(access(f.request.stateDir));
  }
});

test('Cursor root .cursor checks include dangling links and do not read their target', async t => {
  const f = await fixture(t); await symlink(path.join(f.root, 'missing'), path.join(f.request.workspace, '.cursor'));
  await assert.rejects(assertCursorWorkspace(f.request.workspace), /\.cursor/);
});

test('Cursor shell preserves standard proxies, skips rc files and removes credentials', async t => {
  const f = await fixture(t), home = path.join(f.root, "shell 'quoted"), shell = planCursorShell(home);
  for (const file of shell.files) { await mkdir(path.dirname(file.path), { recursive: true }); await writeFile(file.path, file.content, { mode: file.mode }); }
  const rc = path.join(f.root, 'rc'); await writeFile(rc, 'exit 88\n');
  const result = await runProcess({ executable: shell.env.SHELL, args: ['-c', 'printf "%s|%s|%s|%s|%s" "$HTTP_PROXY" "$https_proxy" "${CURSOR_API_KEY-unset}" "${CUSTOM_PROXY-unset}" "$HOME"'], cwd: f.root, stdin: '',
    env: { ...shell.env, HTTP_PROXY: 'http://standard', https_proxy: 'http://lowercase', CURSOR_API_KEY: 'private', CUSTOM_PROXY: 'custom', BASH_ENV: rc, NODE_OPTIONS: 'bad-option' } }, { timeoutMs: 3000 });
  assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.stdout, `http://standard|http://lowercase|unset|unset|${home}`);
});

const ANCHOR = 'const n=null!==(t=be(null==e?void 0:e.failTimeoutMs))&&void 0!==t?t:3e4,r=be(null==e?void 0:e.advisoryTimeoutMs)';
const PINNED_HASH = '39a3fbb76b3382d2ffa82f6a158f292ae4fe0ba06162795dcbbacde325ca9853';
const SOURCE = `function timeout(e){let t;const be=v=>v;${ANCHOR};return [n,r];}const unrelated=3e4;`;
function runtimeFixture(options = {}) {
  const p = planCursorRuntime('/tmp/cursor runtime', 120_000), source = options.source ?? SOURCE;
  const original = () => {}, module = { _extensions: { '.js': original } }, process = { argv: ['node', options.entry ?? '/native/index.js'], env: { NODE_OPTIONS: options.nodeOptions ?? p.env.NODE_OPTIONS } };
  let compiled;
  const fs = { realpathSync: filename => path.resolve(filename), readFileSync: () => Buffer.from(source) };
  const hash = { createHash: algorithm => { assert.equal(algorithm, 'sha256'); return { update: bytes => { assert.deepEqual(bytes, Buffer.from(source)); return { digest: () => options.digest ?? PINNED_HASH }; } }; } };
  return { p, module, original, process, compiled: () => compiled,
    install: () => runInNewContext(p.files[0].content, { process, require: name => ({ 'node:fs': fs, 'node:path': path, 'node:crypto': hash, 'node:module': module })[name] }),
    load: () => module._extensions['.js']({ _compile: value => { assert.equal(module._extensions['.js'], original); assert.equal(process.env.NODE_OPTIONS?.includes(p.env.NODE_OPTIONS) ?? false, false); compiled = value; } }, '/native/index.js') };
}
test('Cursor stall preload changes only pinned source and removes itself before native imports/children', () => {
  const f = runtimeFixture(); f.install(); f.load(); assert.equal(f.compiled(), SOURCE.replace(':3e4,r=be', ':120000,r=be'));
  assert.equal(f.module._extensions['.js'], f.original); assert.equal(f.process.env.NODE_OPTIONS, undefined);
  assert.equal(f.p.compatibility.version, CURSOR_AGENT_VERSION); assert.equal(f.p.compatibility.sourceSha256, PINNED_HASH);
});
test('Cursor stall preload fails closed for altered bundles, wrong entry and ambiguous anchors/options', () => {
  for (const options of [{ digest: crypto.createHash('sha256').update(SOURCE).digest('hex') }, { source: 'other' }, { source: `${SOURCE}\n${ANCHOR}` }, { nodeOptions: '--trace-warnings' }]) {
    const f = runtimeFixture(options); f.install(); assert.throws(() => f.load()); assert.equal(f.compiled(), undefined); assert.equal(f.module._extensions['.js'], f.original);
  }
  const wrong = runtimeFixture({ entry: '/native/wrong.js' }); assert.throws(() => wrong.install(), /entry point/);
  const p = planCursorRuntime('/tmp/cursor runtime', 120_000), duplicate = runtimeFixture({ nodeOptions: `${p.env.NODE_OPTIONS} ${p.env.NODE_OPTIONS}` }); duplicate.install(); assert.throws(() => duplicate.load(), /removed safely/);
});

test('Cursor launchers reject nonexistent executables and shell builtins', async t => {
  const f = await fixture(t);
  for (const [name, code] of [['missing-js-agent-runtime-cursor', 127], ['printf', 126]]) {
    const p = planCursorLauncher(path.join(f.root, name), name);
    for (const file of p.files) { await mkdir(path.dirname(file.path), { recursive: true }); await writeFile(file.path, file.content, { mode: file.mode }); }
    const r = await runProcess({ executable: p.executable, args: p.args, cwd: f.root, stdin: '', env: { PATH: '/usr/bin:/bin' } }, { timeoutMs: 3000 }); assert.equal(r.exitCode, code);
  }
});
