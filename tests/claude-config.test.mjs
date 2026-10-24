import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { plan, probe, run } from '../dist/index.js';

const secret = 'fake-user-owned-token-never-copied-to-runtime';
const source = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args=process.argv.slice(2), emit=x=>console.log(JSON.stringify(x));
if(args.includes('--version')){console.log('fake-configured-claude 1');process.exit(0)}
const value=flag=>args[args.indexOf(flag)+1];
if(!['user','user,project,local'].includes(value('--setting-sources'))||args.includes('--bare')||args.includes('--restricted')||args.includes('--safe-mode')) process.exit(31);
if(args.includes('status')){
  const settings=JSON.parse(value('--settings'));
  if(!settings.disableAllHooks||value('--mcp-config')!=='{"mcpServers":{}}')process.exit(32);
  emit({loggedIn:process.env.FAKE_LOGIN!=='no',authMethod:'oauth_token',apiProvider:'firstParty',email:'private-identity@example.invalid',accessToken:'do-not-return-metadata-token'});
  process.exit(0);
}
if(value('--permission-mode')!=='bypassPermissions'||process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB!=='0'||args.includes('--model')||!args.includes('--no-session-persistence'))process.exit(33);
const controls=JSON.parse(readFileSync(value('--settings'),'utf8'));
if(!controls.disableAllHooks||controls.sandbox.enabled!==false)process.exit(34);
const config=JSON.parse(readFileSync(process.env.CLAUDE_CONFIG_DIR+'/settings.json','utf8'));
let input='';for await(const chunk of process.stdin)input+=chunk;
writeFileSync('artifact.json',JSON.stringify({input,hasUserToken:!!config.env.ANTHROPIC_AUTH_TOKEN,injectedToken:!!process.env.ANTHROPIC_AUTH_TOKEN,injectedEndpoint:!!process.env.ANTHROPIC_BASE_URL,subprocessScrub:process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,home:process.env.HOME}));
emit({type:'system',subtype:'init',session_id:'configured-session',model:'actual-model-from-user-config'});
emit({type:'assistant',message:{content:[{type:'text',text:'done'}]}});
emit({type:'result',subtype:'success',result:'done',usage:{input_tokens:2,output_tokens:1}});
`;
async function fixture(t){
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'runtime-config-'));
  t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
  const workspace=path.join(dir,'workspace'),configDir=path.join(dir,'config');
  await fsp.mkdir(workspace);await fsp.mkdir(configDir);
  await fsp.writeFile(path.join(configDir,'settings.json'),JSON.stringify({env:{ANTHROPIC_AUTH_TOKEN:secret,ANTHROPIC_BASE_URL:'https://private-gateway.invalid'},model:'user-default'}));
  const executable=path.join(dir,'fake-claude.mjs');await fsp.writeFile(executable,source,{mode:0o700});
  const request={runId:'configured',workspace,prompt:'Produce the fixture',target:{name:'local',harness:{adapter:'claude-code',executable,permission:'bypass'},backend:{auth:'claude-config',model:'configured',claudeConfigDir:configDir}},timeoutMs:3000,stateDir:path.join(dir,'state')};
  return {dir,workspace,configDir,request};
}
const arg=(p,flag)=>p.process.args[p.process.args.indexOf(flag)+1];

test('configured plan is pure, keeps native settings opaque, and explicitly selects bypass',async t=>{
  const f=await fixture(t);let p;
  const mocks=[];
  try{
    for(const api of [fs,fsp])for(const name of ['readFile','readFileSync','stat','statSync','access','accessSync'])if(name in api)mocks.push(t.mock.method(api,name,()=>{throw new Error('plan must not inspect configuration')}));
    syncBuiltinESMExports();
    p=plan(f.request);assert.deepEqual(p,plan(f.request));
  }finally{for(const mock of mocks)mock.mock.restore();syncBuiltinESMExports()}
  assert.equal(p.credential,undefined);assert.equal(JSON.stringify(p).includes(secret),false);
  assert.equal(p.process.env.HOME,os.homedir());assert.equal(p.process.env.CLAUDE_CONFIG_DIR,f.configDir);
  assert.equal(p.process.env.ANTHROPIC_BASE_URL,undefined);assert.equal(p.process.env.ANTHROPIC_AUTH_TOKEN,undefined);
  assert.equal(p.process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,'0');
  assert.equal(arg(p,'--setting-sources'),'user');assert.equal(arg(p,'--permission-mode'),'bypassPermissions');
  assert.equal(arg(p,'--mcp-config'),'{"mcpServers":{}}');
  for(const flag of ['--model','--bare','--safe-mode','--restricted'])assert.ok(!p.process.args.includes(flag),flag);
  for(const flag of ['--no-session-persistence','--strict-mcp-config'])assert.ok(p.process.args.includes(flag),flag);
  const settings=JSON.parse(p.files[0].content);assert.equal(settings.disableAllHooks,true);assert.equal(settings.sandbox.enabled,false);
  assert.equal(settings.permissions.defaultMode,'bypassPermissions');
  await assert.rejects(fsp.access(f.request.stateDir));
  const missing=path.join(f.dir,'absent-config');
  assert.equal(plan({...f.request,target:{...f.request.target,backend:{...f.request.target.backend,claudeConfigDir:missing}}}).process.env.CLAUDE_CONFIG_DIR,missing);
  await assert.rejects(fsp.access(missing));
});

test('configured supports default namespace and explicit model, but the sentinel and bypass stay scoped',async t=>{
  const f=await fixture(t),target=f.request.target;
  const defaultPlan=plan({...f.request,target:{...target,backend:{auth:'claude-config',model:'configured'}}});
  assert.equal(defaultPlan.process.env.HOME,os.homedir());assert.equal(defaultPlan.process.env.CLAUDE_CONFIG_DIR,undefined);
  assert.equal(arg(plan({...f.request,target:{...target,backend:{...target.backend,model:'explicit-model'}}}),'--model'),'explicit-model');
  for(const auth of ['chatgpt','claude-subscription','api-key'])assert.throws(()=>plan({...f.request,target:{...target,backend:{auth,model:'configured'}}}),/reserved for claude-config/);
  assert.throws(()=>plan({...f.request,target:{...target,harness:{...target.harness,adapter:'codex'}}}),/bypass.*only supported/);
  assert.throws(()=>plan({...f.request,target:{...target,harness:{...target.harness,adapter:'codex',permission:'read-only'}}}),/requires Claude Code/);
  assert.throws(()=>plan({...f.request,target:{...target,backend:{auth:'claude-config'}}}),/backend.model/);
  assert.throws(()=>plan({...f.request,target:{...target,backend:{...target.backend,baseURL:'https://override.invalid'}}}),/Unknown/);
  for(const permission of ['read-only','workspace-write'])assert.equal(plan({...f.request,target:{...target,harness:{...target.harness,permission}}}).process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,'1');
});

test('existing Claude API and subscription profiles retain isolation and explicit models',async t=>{
  const f=await fixture(t);
  for(const auth of ['api-key','claude-subscription']){
    const backend=auth==='api-key'?{auth,model:'explicit',provider:'fixture',protocol:'anthropic-messages',baseURL:'https://api.invalid/v1',apiKeyEnv:'FIXTURE_KEY'}:{auth,model:'explicit'};
    const p=plan({...f.request,target:{...f.request.target,harness:{...f.request.target.harness,permission:'workspace-write'},backend}});
    assert.ok(p.process.args.includes('--restricted'));assert.ok(p.process.args.includes('--safe-mode'));
    assert.equal(arg(p,'--setting-sources'),'');assert.equal(arg(p,'--model'),'explicit');assert.equal(arg(p,'--permission-mode'),'dontAsk');
    assert.equal(JSON.parse(p.files[0].content).sandbox.enabled,true);
    assert.equal(p.process.env.ANTHROPIC_BASE_URL,auth==='api-key'?'https://api.invalid':'https://api.anthropic.com');
    assert.equal(p.process.args.includes('--bare'),auth==='api-key');
    assert.equal(p.process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,'1');
  }
});

test('bypass rejects API and subscription auth before creating any runtime state',async t=>{
  const f=await fixture(t);
  for(const backend of [
    {auth:'claude-subscription',model:'explicit'},
    {auth:'api-key',model:'explicit',provider:'fixture',protocol:'anthropic-messages',baseURL:'https://api.invalid/v1',apiKeyEnv:'FIXTURE_KEY'},
  ])assert.throws(()=>plan({...f.request,target:{...f.request.target,backend}}),/bypass permission requires claude-config authentication/);
  assert.equal(arg(plan(f.request),'--permission-mode'),'bypassPermissions');
  await assert.rejects(fsp.access(f.request.stateDir));
});

test('configured execution leaves config unchanged and records the actual init model without resolving credentials',async t=>{
  const f=await fixture(t),before=await fsp.readFile(path.join(f.configDir,'settings.json'));
  const runDir=path.join(f.dir,'logs');
  const result=await run(plan(f.request),{runDir,resolveCredential:()=>{throw new Error('native config must own authentication')}});
  assert.equal(result.status,'completed',result.error);assert.equal(result.responseModel,'actual-model-from-user-config');
  assert.equal(result.sessionId,'configured-session');
  const artifact=JSON.parse(await fsp.readFile(path.join(f.workspace,'artifact.json'),'utf8'));
  assert.deepEqual(artifact,{input:f.request.prompt,hasUserToken:true,injectedToken:false,injectedEndpoint:false,subprocessScrub:'0',home:os.homedir()});
  assert.deepEqual(await fsp.readFile(path.join(f.configDir,'settings.json')),before);
  for(const name of await fsp.readdir(runDir))assert.equal((await fsp.readFile(path.join(runDir,name),'utf8')).includes(secret),false);
  await assert.rejects(fsp.access(f.request.stateDir));
});

test('configured probe accepts native CLI login verdict without assuming OAuth method or provider endpoint',async t=>{
  const f=await fixture(t),p=plan(f.request);
  const result=await probe(p,{checkExecutable:true,checkLogin:true});
  assert.equal(result.ok,true);assert.match(result.checks.find(x=>x.name==='login').message,/endpoint and model compatibility are not verified/);
  assert.doesNotMatch(JSON.stringify(result),/private-identity|do-not-return-metadata-token|oauth_token|firstParty/);
  assert.equal((await probe(p,{checkLogin:true,env:{FAKE_LOGIN:'no'}})).ok,false);
  await assert.rejects(fsp.access(f.request.stateDir));await assert.rejects(fsp.access(path.join(f.workspace,'artifact.json')));
});

test('configured authentication directory is protected against direct and resolved workspace overlap',async t=>{
  const f=await fixture(t);
  assert.throws(()=>plan({...f.request,target:{...f.request.target,backend:{...f.request.target.backend,claudeConfigDir:f.workspace}}}),/overlap/);
  const link=path.join(f.dir,'config-link');await fsp.symlink(f.workspace,link);
  const result=await run(plan({...f.request,target:{...f.request.target,backend:{...f.request.target.backend,claudeConfigDir:link}}}));
  assert.equal(result.status,'failed');assert.match(result.error,/Resolved authentication directory overlaps/);
  await assert.rejects(fsp.access(path.join(f.workspace,'artifact.json')));
});


test('project context enables native Skill discovery without dropping bypass or credential isolation', async t => {
  const f = await fixture(t);
  f.request.target.harness.contextMode = 'project';
  const p = plan(f.request);
  assert.equal(p.process.cwd, f.workspace);
  assert.equal(arg(p, '--setting-sources'), 'user,project,local');
  assert.equal(p.process.args.includes('--disable-slash-commands'), false);
  assert.ok(arg(p, '--tools').split(',').includes('Skill'));
  assert.ok(arg(p, '--allowedTools').split(',').includes('Skill'));
  assert.equal(arg(p, '--permission-mode'), 'bypassPermissions');
  assert.equal(p.process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '0');
  assert.equal((await run(p, {runDir:path.join(f.workspace, 'runs', 'runtime')})).status, 'completed');
  assert.equal(JSON.parse(await fsp.readFile(path.join(f.workspace, 'runs', 'runtime', 'result.json'), 'utf8')).status, 'completed');
  assert.throws(() => plan({...f.request, target: {...f.request.target, backend: {auth:'claude-subscription', model:'test'}, harness:{...f.request.target.harness, permission:'workspace-write'}}}), /project context requires claude-config/);
  assert.throws(() => plan({...f.request, target: {...f.request.target, harness:{...f.request.target.harness, contextMode:'typo'}}}), /contextMode/);
});


test('project log placement rejects cwd and ancestors, and does not weaken snapshot mode', async t => {
  const f = await fixture(t);
  const nested = path.join(f.workspace,'logs','snapshot');
  assert.match((await run(plan(f.request), {runDir:nested})).error, /runDir must not overlap/);
  f.request.target.harness.contextMode = 'project';
  const p = plan(f.request);
  for (const runDir of [f.workspace, f.dir, f.request.stateDir]) {
    assert.match((await run(p, {runDir})).error, /runDir must not overlap/);
  }
  assert.throws(() => plan({...f.request, target:{...f.request.target,harness:{...f.request.target.harness,contextMode:['project']}}}), /contextMode/);
});
