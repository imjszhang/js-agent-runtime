import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { plan, run, probe, registerAdapter } from '../dist/index.js';
const fakeCliSkip = process.platform === 'win32' && 'fake CLIs are shebang scripts; Windows cannot start them without a shell';

const privateMarker='private-native-account-metadata@example.invalid';
const credential='test-provider-credential-not-for-metadata';
const fake=`#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const args=process.argv.slice(2), emit=x=>console.log(JSON.stringify(x));
const phase=args.includes('--version')?'version':args.includes('status')?'login':'execute';
const store=args.find(value=>value.startsWith('cli_auth_credentials_store='));
const trace={phase,home:process.env.HOME,cwd:process.cwd(),codexHome:process.env.CODEX_HOME,claudeConfigDir:process.env.CLAUDE_CONFIG_DIR,store,
  credentialPresent:Boolean(process.env.JS_AGENT_RUNTIME_API_KEY||process.env.ANTHROPIC_API_KEY),shellOverride:process.env.CLAUDE_CODE_SHELL,
  ...(process.env.FAKE_ECHO_PROXY?{proxy:process.env.HTTPS_PROXY,nonstandardProxy:process.env.CUSTOM_PROXY,unrelatedKeyPresent:Boolean(process.env.UNRELATED_SERVICE_KEY)}:{})};
appendFileSync(process.env.FAKE_TRACE_PATH,JSON.stringify(trace)+'\\n');
if(process.env.FAKE_HANG===phase){
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  writeFileSync(process.env.FAKE_PID_PATH,String(child.pid));
  setInterval(()=>{},1000);await new Promise(()=>{});
}
if(phase==='version'){
  await new Promise(resolve=>setTimeout(resolve,Number(process.env.FAKE_VERSION_DELAY||0)));
  console.log((process.env.FAKE_VERSION||'2.1.296')+(process.env.FAKE_ECHO_PROXY?' '+process.env.HTTPS_PROXY:''));process.exit(0);
}
if(phase==='login'){
  await new Promise(resolve=>setTimeout(resolve,Number(process.env.FAKE_LOGIN_DELAY||0)));
  process.stderr.write('${privateMarker}\\n');
  if(args.includes('login'))console.log(process.env.FAKE_LOGIN==='reject'?'Logged in using API key':'Logged in using ChatGPT');
  else emit({loggedIn:process.env.FAKE_LOGIN!=='reject',authMethod:process.env.FAKE_METHOD||'claude.ai',apiProvider:'firstParty',configDirectory:process.env.CLAUDE_CONFIG_DIR??process.env.HOME+'/.claude',email:'${privateMarker}',accessToken:'private-native-access-data'});
  process.exit(process.env.FAKE_LOGIN==='reject'?1:0);
}
let input='';for await(const chunk of process.stdin)input+=chunk;
writeFileSync('executed.txt',input);
if(process.env.FAKE_AGENT==='claude-code')emit({type:'result',subtype:'success',result:'done',usage:{input_tokens:2,output_tokens:1},total_cost_usd:0.25});
else {emit({type:'thread.started',thread_id:'preflight-session'});if(process.env.FAKE_ECHO_PROXY)emit({type:'item.completed',item:{type:'agent_message',text:'proxy '+process.env.HTTPS_PROXY}});emit({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}});}
`;
async function fixture(t,adapter='codex',auth='api-key'){
  const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'runtime-preflight-')));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const workspace=path.join(dir,'workspace'),native=path.join(dir,'native');await mkdir(workspace);await mkdir(native);
  const executable=path.join(dir,'fake.mjs');await writeFile(executable,fake,{mode:0o700});
  const backend=auth==='api-key'?{auth,model:'fake',provider:'test',protocol:adapter==='codex'?'responses':adapter==='opencode'?'chat-completions':'anthropic-messages',baseURL:'https://example.invalid/v1',apiKeyEnv:'TEST_PROVIDER_KEY'}
    :auth==='chatgpt'?{auth,model:'fake',codexHome:native,credentialsStore:'keyring'}:{auth,model:'fake',claudeConfigDir:native};
  const request={runId:'preflight',workspace,prompt:'local fixture',target:{name:'fixture',harness:{adapter,executable,permission:'workspace-write'},backend},stateDir:path.join(dir,'state'),timeoutMs:3000,terminationGraceMs:30};
  const env={FAKE_TRACE_PATH:path.join(dir,'trace.jsonl'),FAKE_PID_PATH:path.join(dir,'child.pid'),FAKE_AGENT:adapter};
  return {dir,workspace,native,request,env,options:{env,runDir:path.join(dir,'logs'),resolveCredential:()=>credential}};
}
const traces=async f=>(await readFile(f.env.FAKE_TRACE_PATH,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
async function noExecution(f){await assert.rejects(access(path.join(f.workspace,'executed.txt')));await assert.rejects(access(f.request.stateDir));}

test('native version rejection happens before credential lookup, login or agent execution', { skip: fakeCliSkip },async t=>{
  for(const [adapter,auth,version,reason] of [['claude-code','claude-subscription','2.1.295',/2\.1\.296/],['opencode','api-key','1.9.0',/V2/]]){
    const f=await fixture(t,adapter,auth);let resolutions=0;
    const r=await run(plan(f.request),{...f.options,env:{...f.env,FAKE_VERSION:version},resolveCredential:()=>{resolutions++;return credential;}});
    assert.equal(r.status,'failed');assert.match(r.error,reason);assert.equal(resolutions,0);
    assert.deepEqual((await traces(f)).map(x=>x.phase),['version']);await noExecution(f);
  }
});

test('API version checks use isolated directories and do not receive provider credentials', { skip: fakeCliSkip },async t=>{
  const f=await fixture(t);const events=[];
  const r=await run(plan(f.request),{...f.options,onEvent:event=>events.push(event)});
  assert.equal(r.status,'completed',r.error);
  const [version,execution]=await traces(f);
  assert.equal(version.credentialPresent,false);assert.equal(execution.credentialPresent,true);
  assert.equal(version.home,version.cwd);assert.match(version.home,/state\/metadata$/);assert.notEqual(version.codexHome,execution.codexHome);
  assert.deepEqual(events.filter(event=>event.type==='started').map(event=>event.data.target),['fixture']);
  await assert.rejects(access(f.request.stateDir));
});

test('native login rejection cannot fall back to an API credential or expose identity metadata', { skip: fakeCliSkip },async t=>{
  for(const [adapter,auth] of [['codex','chatgpt'],['claude-code','claude-subscription']]){
    const f=await fixture(t,adapter,auth);const events=[];
    const r=await run(plan(f.request),{...f.options,env:{...f.env,FAKE_LOGIN:'reject'},resolveCredential:()=>{throw new Error('must not resolve credentials');},onEvent:event=>events.push(event)});
    assert.equal(r.status,'failed');assert.match(r.error,/did not confirm/);assert.equal(r.cost,null);
    assert.deepEqual((await traces(f)).map(x=>x.phase),['version','login']);await noExecution(f);
    const records=(await Promise.all((await readdir(f.options.runDir)).map(file=>readFile(path.join(f.options.runDir,file),'utf8')))).join('\n');
    assert.doesNotMatch(JSON.stringify({r,events})+records,/private-native-account|private-native-access-data/);
  }
});

test('Claude subscription rejects an API login and reports no native API-style cost on success', { skip: fakeCliSkip },async t=>{
  const rejected=await fixture(t,'claude-code','claude-subscription');
  const denied=await run(plan(rejected.request),{...rejected.options,env:{...rejected.env,FAKE_METHOD:'api_key'}});
  assert.equal(denied.status,'failed');await noExecution(rejected);
  const accepted=await fixture(t,'claude-code','claude-subscription');
  const r=await run(plan(accepted.request),accepted.options);
  assert.equal(r.status,'completed',r.error);assert.equal(r.cost,null);assert.equal(r.usage.totalTokens,3);
});

test('Codex credential-store selection is shared by login metadata and execution', { skip: fakeCliSkip },async t=>{
  const f=await fixture(t,'codex','chatgpt');
  const r=await run(plan(f.request),{...f.options,resolveCredential:()=>{throw new Error('must not resolve credentials');}});
  assert.equal(r.status,'completed',r.error);
  const [version,login,execution]=await traces(f);
  assert.notEqual(version.codexHome,f.native);assert.equal(login.codexHome,f.native);assert.equal(execution.codexHome,f.native);
  assert.equal(login.store,'cli_auth_credentials_store="keyring"');assert.equal(execution.store,login.store);
  assert.equal(login.credentialPresent,false);assert.equal(execution.credentialPresent,false);
  const p=await probe(plan(f.request),{checkExecutable:true,checkLogin:true,env:f.env});
  assert.equal(p.ok,true);assert.doesNotMatch(JSON.stringify(p),/private-native-account|private-native-access-data/);
  const probeRows=(await traces(f)).slice(-2);assert.equal(probeRows[1].store,login.store);
  for(const row of probeRows)await assert.rejects(access(row.cwd));
});

test('version and login checks share the task and probe deadlines', { skip: fakeCliSkip },async t=>{
  const f=await fixture(t,'claude-code','claude-subscription');
  const env={...f.env,FAKE_VERSION_DELAY:'300',FAKE_LOGIN_DELAY:'300'};
  const r=await run(plan({...f.request,timeoutMs:500}),{...f.options,env});
  assert.equal(r.status,'timed_out',r.error);assert.ok(r.durationMs<1300);await noExecution(f);
  assert.deepEqual((await traces(f)).map(x=>x.phase),['version','login']);
  const p=await probe(plan(f.request),{checkExecutable:true,checkLogin:true,timeoutMs:500,env});
  assert.equal(p.ok,false);assert.equal(p.checks.find(x=>x.name==='executable').status,'passed');assert.equal(p.checks.find(x=>x.name==='login').status,'failed');
  for(const row of (await traces(f)).slice(-2))await assert.rejects(access(row.cwd));
});

test('cancellation during metadata stops descendants and removes temporary state', { skip: fakeCliSkip },async t=>{
  const f=await fixture(t),controller=new AbortController();
  const pending=run(plan(f.request),{...f.options,env:{...f.env,FAKE_HANG:'version'},signal:controller.signal});
  const started=Date.now();
  while(true){try{await access(f.env.FAKE_PID_PATH);break;}catch{if(Date.now()-started>2000)throw new Error('fake metadata did not start');await new Promise(resolve=>setTimeout(resolve,10));}}
  const pid=Number(await readFile(f.env.FAKE_PID_PATH,'utf8'));controller.abort();
  const r=await pending;assert.equal(r.status,'cancelled');await noExecution(f);
  const reapingStarted=Date.now();
  while(Date.now()-reapingStarted<1000){try{process.kill(pid,0);}catch{break;}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.throws(()=>process.kill(pid,0));assert.deepEqual((await traces(f)).map(x=>x.phase),['version']);
});

test('legacy extensions are not forced through built-in metadata, and probe uses the planned executable', { skip: fakeCliSkip },async t=>{
  const f=await fixture(t);const id='preflight-extension';
  const unregister=registerAdapter({id,version:'1',validate:()=>{},probeArgs:['--version'],
    plan:request=>({files:[],process:{executable:f.request.target.harness.executable,args:[],cwd:request.workspace,stdin:request.prompt,env:{...f.env,HOME:f.request.stateDir}}}),
    createParser:()=>({push:()=>[],finish:()=>({completed:true,failed:false,text:'extension',usage:null,cost:null,sessionId:null,responseModel:null,error:null})})});
  t.after(unregister);
  const target={name:'extension',harness:{adapter:id,executable:path.join(f.dir,'placeholder-not-a-native-cli'),permission:'workspace-write'},backend:{auth:'extension',model:'fake'}};
  const execution=plan({...f.request,target});
  const r=await run(execution);assert.equal(r.status,'completed',r.error);assert.deepEqual((await traces(f)).map(x=>x.phase),['execute']);
  const p=await probe(execution,{checkExecutable:true});assert.equal(p.ok,true,JSON.stringify(p));assert.equal(p.executable,execution.process.executable);
});

test('standard inherited proxies reach native processes and are redacted from run and probe outputs', { skip: fakeCliSkip },async t=>{
  const proxy='https://fake-proxy-user:fake-proxy-password@proxy.example.invalid:8443';
  const replacements={HTTPS_PROXY:proxy,CUSTOM_PROXY:'private-nonstandard-proxy',UNRELATED_SERVICE_KEY:'private-unrelated-provider-key'};
  const previous=Object.fromEntries(Object.keys(replacements).map(key=>[key,process.env[key]]));
  t.after(()=>{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  Object.assign(process.env,replacements);
  const f=await fixture(t),events=[],env={...f.env,FAKE_ECHO_PROXY:'1'};
  const r=await run(plan(f.request),{...f.options,env,onEvent:event=>events.push(event)});
  assert.equal(r.status,'completed',r.error);assert.match(r.text,/REDACTED/);
  assert.ok(events.some(event=>event.type==='raw'&&JSON.stringify(event.data).includes('REDACTED')));
  const p=await probe(plan(f.request),{checkExecutable:true,env});
  assert.equal(p.ok,true);assert.match(p.checks[0].message,/REDACTED/);
  const records=(await Promise.all((await readdir(f.options.runDir)).map(file=>readFile(path.join(f.options.runDir,file),'utf8')))).join('\n');
  assert.doesNotMatch(JSON.stringify({r,p,events})+records,/fake-proxy-user|fake-proxy-password|private-nonstandard-proxy|private-unrelated-provider-key/);
  for(const row of await traces(f)){
    assert.equal(row.proxy,proxy);assert.equal(row.nonstandardProxy,undefined);assert.equal(row.unrelatedKeyPresent,false);
  }
});
