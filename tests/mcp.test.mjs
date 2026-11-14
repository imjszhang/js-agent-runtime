import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { plan, run } from '../dist/index.js';
import { withMcpNoProxy } from '../dist/mcp.js';

test('MCP child proxy exclusions preserve both cases and add explicit endpoint hosts only', () => {
  const env = { NO_PROXY: 'localhost,.internal', no_proxy: '127.0.0.1,localhost', HTTPS_PROXY: 'http://proxy.invalid:8080' };
  const r = request(); r.mcpServers = [server, { ...server, name: 'ipv6', url: 'http://[::1]:8899/mcp' }];
  const result = withMcpNoProxy(r, env);
  assert.equal(result.NO_PROXY, 'localhost,.internal,127.0.0.1,::1');
  assert.equal(result.no_proxy, result.NO_PROXY); assert.equal(result.HTTPS_PROXY, env.HTTPS_PROXY);
  assert.equal(env.NO_PROXY, 'localhost,.internal'); assert.equal(withMcpNoProxy({ ...r, mcpServers: [] }, env), env);
});

const server = { name: 'comfy-hub', url: 'http://127.0.0.1:8899/mcp/comfyui', bearerTokenRef: 'HUB_TOKEN', enabledTools: ['server_info', 'list_assets'] };
function request(adapter = 'codex') {
  return { runId: 'mcp-test', workspace: path.resolve('/tmp/mcp-workspace'), prompt: 'read tools', timeoutMs: 5000,
    target: { name: 'test', harness: { adapter, executable: adapter, permission: 'read-only' }, backend: {
      auth: 'api-key', model: 'fake', provider: 'test', protocol: adapter === 'codex' ? 'responses' : 'anthropic-messages',
      baseURL: 'https://example.invalid', apiKeyEnv: 'MODEL_KEY',
    } }, mcpServers: [server] };
}
test('MCP schema rejects ambiguous names, URLs, tool patterns, credentials and unsupported adapters', () => {
  for (const override of [{ name: 'a.b' }, { url: 'http://user:key@localhost/mcp' }, { url: 'http://localhost/mcp?token=x' },
    { url: 'file:///tmp/x' }, { url: 'http://local host/mcp' }, { bearerTokenRef: 'raw-token!' }, { enabledTools: ['*'] },
    { enabledTools: ['read', 'read'] }, { enabledTools: ['foo.bar'] }, { headers: {} }]) {
    assert.throws(() => plan({ ...request(), mcpServers: [{ ...server, ...override }] }));
  }
  assert.throws(() => plan({ ...request(), mcpServers: [server, server] }), /unique/);
  assert.throws(() => plan({ ...request(), mcpServers: Array.from({ length: 17 }, (_, i) => ({ ...server, name: `s${i}` })) }), /16/);
  for (const adapter of ['opencode', 'cursor-agent']) assert.throws(() => plan(request(adapter)), /Explicit MCP/);
});
test('MCP plans only carry credential references and native tool restrictions', () => {
  const p = plan(request());
  assert.deepEqual(p.mcpCredentials, [{ ref: 'HUB_TOKEN', envVar: 'JS_AGENT_RUNTIME_MCP_TOKEN_0' }]);
  assert.equal(p.process.env.JS_AGENT_RUNTIME_MCP_TOKEN_0, undefined);
  assert.ok(p.process.args.includes('mcp_servers={}'));
  assert.ok(p.process.args.includes('mcp_servers.comfy-hub.enabled_tools=["server_info","list_assets"]'));
  assert.ok(p.process.args.includes('mcp_servers.comfy-hub.bearer_token_env_var="JS_AGENT_RUNTIME_MCP_TOKEN_0"'));
  assert.ok(p.process.args.includes('--ignore-user-config'));
  const empty = plan({ ...request(), mcpServers: [{ ...server, enabledTools: [] }] });
  assert.ok(empty.process.args.includes('mcp_servers.comfy-hub.enabled_tools=[]'));
  const disabled = plan({ ...request(), mcpServers: [] });
  assert.equal(disabled.mcpCredentials, undefined);
});
test('omitted and empty MCP lists keep existing native arguments, files and environment unchanged', () => {
  for (const adapter of ['codex', 'claude-code', 'deepseek-harness']) {
    const r = request(adapter); delete r.mcpServers;
    const absent = plan(r), empty = plan({ ...r, mcpServers: [] });
    assert.deepEqual(empty.process, absent.process); assert.deepEqual(empty.files, absent.files);
    assert.deepEqual(empty.credential, absent.credential); assert.equal(empty.mcpCredentials, undefined);
    assert.equal(empty.process.env.JS_AGENT_RUNTIME_MCP_TOKEN_0, undefined);
  }
});
test('Claude and DSH use the native MCP bridge with explicit env references', { skip: process.platform === 'win32' }, () => {
  const claude = plan(request('claude-code')), args = claude.process.args;
  assert.equal(args.includes('--safe-mode'), false); assert.ok(args.includes('--restricted')); assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(claude.process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '0');
  const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers['comfy-hub'];
  assert.equal(config.command, process.execPath);
  assert.equal(config.env.JS_AGENT_RUNTIME_MCP_TOKEN_0, '${JS_AGENT_RUNTIME_MCP_TOKEN_0}');
  assert.equal(config.env.NODE_USE_ENV_PROXY, '0');
  assert.deepEqual(JSON.parse(config.args[1]).enabledTools, server.enabledTools);
  assert.match(args[args.indexOf('--allowedTools') + 1], /mcp__comfy-hub__server_info/);
  const dsh = plan(request('deepseek-harness'));
  const patch = dsh.files.find(f => f.path.endsWith('runtime.patch.yml')).content;
  assert.match(patch, /@deepseek-ai\/dsh-mcp-client/);
  assert.match(patch, /"transport":"stdio"/);
  assert.match(patch, /- \{"insert":\[\{"id":"runtime-mcp-0"/);
  assert.match(patch, /!!js "process.env.JS_AGENT_RUNTIME_MCP_TOKEN_0"/);
  assert.match(patch, /"failOnStartupError":true/);
  assert.match(patch, /"NODE_USE_ENV_PROXY":"0"/);
});
test('Claude shell wrapper removes every MCP token before launching Bash', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runtime-mcp-shell-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const r = { ...request('claude-code'), stateDir: path.join(dir, 'state'), mcpServers: [server, { ...server, name: 'second', bearerTokenRef: 'SECOND_TOKEN' }] };
  const p = plan(r);
  for (const f of p.files) { await mkdir(path.dirname(f.path), { recursive: true }); await writeFile(f.path, f.content, { mode: f.mode }); }
  const result = await promisify(execFile)(p.process.env.CLAUDE_CODE_SHELL, ['-c', 'printf "%s:%s:%s:%s:%s" "${JS_AGENT_RUNTIME_MCP_TOKEN_0-unset}" "${JS_AGENT_RUNTIME_MCP_TOKEN_1-unset}" "${ANTHROPIC_API_KEY-unset}" "${custom_Secret-unset}" "$SAFE_VALUE"'], {
    env: { PATH: process.env.PATH, JS_AGENT_RUNTIME_MCP_TOKEN_0: 'hidden-first', JS_AGENT_RUNTIME_MCP_TOKEN_1: 'hidden-second', ANTHROPIC_API_KEY: 'hidden-model', custom_Secret: 'hidden-custom', SAFE_VALUE: 'preserved' },
  });
  assert.equal(result.stdout, 'unset:unset:unset:unset:preserved');
});
test('run resolves all MCP credentials after metadata, redacts them everywhere and removes state', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runtime-mcp-run-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'workspace'); await mkdir(workspace);
  const executable = path.join(dir, 'codex.mjs');
  await writeFile(executable, `#!${process.execPath}
import assert from 'node:assert/strict';
const a=process.argv.slice(2), emit=x=>console.log(JSON.stringify(x));
if(a.includes('--version')) { assert.equal(process.env.JS_AGENT_RUNTIME_MCP_TOKEN_0,undefined);console.log('codex-cli 0.135.0');process.exit(0); }
assert.ok(process.env.JS_AGENT_RUNTIME_MCP_TOKEN_0);assert.ok(process.env.JS_AGENT_RUNTIME_MCP_TOKEN_1);
const secrets=[process.env.JS_AGENT_RUNTIME_API_KEY,process.env.JS_AGENT_RUNTIME_MCP_TOKEN_0,process.env.JS_AGENT_RUNTIME_MCP_TOKEN_1];
for(const s of secrets)assert.equal(JSON.stringify(a).includes(s),false);
for await(const _ of process.stdin){}
emit({type:'thread.started',thread_id:'mcp'});
emit({type:'item.completed',item:{type:'agent_message',text:secrets.join(' ')}});
console.error(secrets.join(' '));emit({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
`, { mode: 0o700 });
  const r = request(); r.workspace = workspace; r.stateDir = path.join(dir, 'state'); r.target.harness.executable = executable;
  r.mcpServers.push({ ...server, name: 'second', bearerTokenRef: 'SECOND_TOKEN' });
  const secrets = { MODEL_KEY: 'secret-model-123', HUB_TOKEN: 'secret-hub-first-456', SECOND_TOKEN: 'secret-hub-second-789' }, refs = [], events = [];
  const runDir = path.join(dir, 'logs');
  const result = await run(plan(r), { runDir, resolveCredential: ref => { refs.push(ref); return secrets[ref]; }, onEvent: e => events.push(e) });
  assert.equal(result.status, 'completed', result.error); assert.deepEqual(refs, ['MODEL_KEY', 'HUB_TOKEN', 'SECOND_TOKEN']);
  const logs = (await Promise.all((await readdir(runDir)).map(file => readFile(path.join(runDir, file), 'utf8')))).join('\n');
  for (const value of Object.values(secrets)) assert.equal(JSON.stringify({ result, events, logs }).includes(value), false);
  await assert.rejects(access(r.stateDir));
});

test('DSH optional-entry startup failure terminates the run, but ordinary tool diagnostics do not', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runtime-mcp-startup-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'workspace'); await mkdir(workspace);
  const executable = path.join(dir, 'dsh.mjs');
  await writeFile(executable, `#!${process.execPath}
if(process.argv.includes('--version')){console.log('0.2.0-rc.2');process.exit(0)}
for await(const _ of process.stdin){}
if(process.env.FAKE_DIAGNOSTIC==='tool'){
console.error('MCP tool call runtime-mcp-0 failed: recoverable upstream error');
const emit=x=>console.log(JSON.stringify(x));emit({type:'session',sessionId:'safe'});emit({type:'status',phase:'turn_end',turn:1,reason:{kind:'completed'}});emit({type:'final',text:'handled'});
}else {console.error('runtime-mcp-0 (@deepseek-ai/dsh-mcp-client): failed (initial connection timed out)');setInterval(()=>{},1000);}
`, { mode: 0o700 });
  const r = request('deepseek-harness'); r.workspace = workspace; r.stateDir = path.join(dir, 'state'); r.target.harness.executable = executable; r.terminationGraceMs = 50;
  const result = await run(plan(r), { resolveCredential: () => 'fake-test-secret' });
  assert.equal(result.status, 'failed'); assert.match(result.error, /MCP server failed to activate/); assert.ok(result.durationMs < 3000);
  await assert.rejects(access(r.stateDir));
  const recovered = await run(plan(r), { resolveCredential: () => 'fake-test-secret', env: { FAKE_DIAGNOSTIC: 'tool' } });
  assert.equal(recovered.status, 'completed', recovered.error);
});
