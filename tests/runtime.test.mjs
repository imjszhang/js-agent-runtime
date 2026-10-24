import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { plan, run, probe, registerAdapter, snapshotDirectory, hashObject, createRedactor } from '../dist/index.js';
const fakeCliSkip = process.platform === 'win32' && 'fake CLIs are shebang scripts; Windows cannot start them without a shell';

const secret = 'this-is-a-private-test-credential-1847';
const fakeSource = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2), mode = process.env.FAKE_SCENARIO ?? 'codex';
const emit = x => process.stdout.write(JSON.stringify(x) + '\\n');
if (args.includes('--version')) { console.log('2.1.296'); process.exit(0); }
if (args.includes('status')) {
  if (args.includes('login')) console.log('Logged in using ChatGPT');
  else emit({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',configDirectory:process.env.CLAUDE_CONFIG_DIR ?? process.env.HOME+'/.claude' });
  process.exit(0);
}
let input=''; for await (const chunk of process.stdin) input += chunk;
const key = process.env.JS_AGENT_RUNTIME_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '';
if (mode === 'hang' || mode === 'descendant') {
  if (mode === 'descendant') {
    const child = spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], { stdio: 'ignore' });
    writeFileSync('child.pid', String(child.pid));
  }
  setInterval(()=>{},1000);
} else if (mode === 'bad') { console.log('not-json'); }
else if (mode === 'missing-terminal') { emit({type:'thread.started',thread_id:'fake'}); }
else if (mode === 'failure') { emit({type:'turn.failed',error:{message:'Expected failure'}}); }
else if (mode === 'overflow') { console.log('x'.repeat(8192)); }
else if (mode === 'claude') {
  if(process.env.CLAUDE_CODE_SHELL) {
    const wrapper=readFileSync(process.env.CLAUDE_CODE_SHELL,'utf8');
    if(!wrapper.includes('/usr/bin/sandbox-exec')||!wrapper.includes('--noprofile --norc'))process.exit(41);
    const settings=JSON.parse(readFileSync(args[args.indexOf('--settings')+1],'utf8'));
    if(!settings.sandbox.filesystem.denyWrite.some(p=>process.env.CLAUDE_CODE_SHELL.startsWith(p+'/')))process.exit(42);
  }
  emit({type:'assistant',session_id:'fake-claude',message:{model:'fake-model',content:[{type:'text',text:'Produced file'}]}});
  writeFileSync('artifact.txt', input);
  emit({type:'result',subtype:'success',result:'done',usage:{input_tokens:5,output_tokens:3,cache_read_input_tokens:2,cache_creation_input_tokens:1},total_cost_usd:0.01});
} else {
  emit({type:'thread.started',thread_id:'fake-codex'});
  emit({type:'item.completed',item:{type:'command_execution',text:'tool '+key}});
  process.stderr.write('private '+key+'\\n');
  emit({type:'item.completed',item:{type:'agent_message',text:'done '+key}});
  writeFileSync('artifact.txt', input);
  writeFileSync('environment.json', JSON.stringify({inherited:process.env.UNRELATED_PRIVATE_TOKEN,home:process.env.HOME,keyPresent:Boolean(key)}));
  emit({type:'turn.completed',usage:{input_tokens:11,output_tokens:7,cached_input_tokens:2}});
}
`;
async function fixture(t, adapter='codex', auth='api-key') {
  const dir = await mkdtemp(path.join(os.tmpdir(),'js-agent-runtime-test-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const workspace = path.join(dir,'workspace'); await mkdir(workspace);
  const executable = path.join(dir,'fake-agent.mjs'); await writeFile(executable,fakeSource,{mode:0o700});
  const backend = auth === 'api-key'
    ? { auth, provider:'test',model:'fake-model',protocol:adapter==='codex'?'responses':'anthropic-messages',baseURL:'https://example.invalid/v1',apiKeyEnv:'TEST_CREDENTIAL' }
    : { auth, model:'fake-model', ...(auth==='claude-subscription'&&process.platform!=='darwin'?{claudeConfigDir:path.join(dir,'auth')}:{}) };
  const request = {runId:'test-run',workspace,prompt:'make an artifact',target:{name:'test',harness:{adapter,executable,permission:'workspace-write'},backend},timeoutMs:3000,stateDir:path.join(dir,'state')};
  return {dir,workspace,executable,request,options:{resolveCredential:()=>secret,runDir:path.join(dir,'logs')}};
}
test('plan is deterministic and does not create files or require credentials', async t=>{
  const f=await fixture(t); const a=plan(f.request); assert.deepEqual(a,plan(f.request));
  assert.equal(JSON.stringify(a).includes(secret),false); await assert.rejects(access(f.request.stateDir));
  assert.equal(a.credential.ref,'TEST_CREDENTIAL'); assert.equal(a.process.cwd,f.workspace);
  assert.equal(plan({...f.request,workspace:path.join(f.dir,'does-not-exist')}).process.cwd,path.join(f.dir,'does-not-exist'));
});
test('strict schema rejects unknown fields, incompatible auth/protocol, effort and unsafe paths',async t=>{
  const f=await fixture(t);
  assert.throws(()=>plan({...f.request,unknown:1}),/Unknown/);
  assert.throws(()=>plan({...f.request,workspace:'relative'}),/absolute/);
  assert.throws(()=>plan({...f.request,stateDir:path.join(f.workspace,'state')}),/overlap/);
  assert.throws(()=>plan({...f.request,target:{...f.request.target,backend:{...f.request.target.backend,protocol:'chat-completions'}}}),/requires responses/);
  assert.throws(()=>plan({...f.request,target:{...f.request.target,backend:{auth:'chatgpt',model:'x',baseURL:'https://example.invalid'}}}),/Unknown/);
  assert.throws(()=>plan({...f.request,target:{...f.request.target,backend:{...f.request.target.backend,baseURL:'https://key:password@example.invalid'}}}),/without credentials/);
  const claude=await fixture(t,'claude-code');
  for(const reasoningEffort of ['low','high','max']) {
    const p=plan({...claude.request,target:{...claude.request.target,backend:{...claude.request.target.backend,reasoningEffort}}});
    assert.equal(p.process.args[p.process.args.indexOf('--effort')+1],reasoningEffort);
    assert.ok(p.process.args.includes('--include-partial-messages'));
  }
  assert.throws(()=>plan({...claude.request,target:{...claude.request.target,backend:{...claude.request.target.backend,reasoningEffort:'ultra'}}}),/low.*high.*max/);
});
test('native auth preserves CLI credential ownership and isolates subscription state',async t=>{
  const codex=await fixture(t,'codex','chatgpt'), p=plan(codex.request);
  assert.equal(p.credential,undefined); assert.match(p.process.env.CODEX_HOME,/\.codex$/);
  assert.ok(p.process.args.some(a=>a.includes('filesystem=')));
  const claude=await fixture(t,'claude-code','claude-subscription'), c=plan(claude.request);
  if(process.platform==='darwin') {
    assert.equal(c.process.env.HOME,os.homedir()); assert.equal(c.process.env.CLAUDE_CONFIG_DIR,undefined);
    assert.match(c.process.env.CLAUDE_CODE_SHELL,/claude-shell\/subscription-bash$/);
    const policy=c.files.find(file=>file.path.endsWith('profile.sb')).content;
    assert.ok(policy.includes(JSON.stringify(path.join(os.homedir(),'.zshrc'))));
    assert.ok(policy.includes(JSON.stringify(path.join(os.homedir(),'.bashrc'))));
  } else assert.throws(()=>plan({...claude.request,target:{...claude.request.target,backend:{auth:'claude-subscription',model:'fake-model'}}}),/explicit claudeConfigDir/);
  assert.ok(!c.process.args.includes('--bare'));
  const custom=plan({...claude.request,target:{...claude.request.target,backend:{...claude.request.target.backend,claudeConfigDir:path.join(claude.dir,'auth')}}});
  assert.equal(custom.process.env.CLAUDE_CONFIG_DIR,path.join(claude.dir,'auth'));
  assert.equal(custom.process.env.CLAUDE_CODE_SHELL,undefined);
  assert.throws(()=>plan({...codex.request,target:{...codex.request.target,backend:{auth:'chatgpt',model:'x',codexHome:codex.workspace}}}),/overlap/);
});
test('Codex native login routes Responses to ChatGPT OAuth while API targets retain their supplied endpoint',async t=>{
  function configFrom(p) {
    const entries=[];
    for(let i=0;i<p.process.args.length;i++)if(p.process.args[i]==='-c') {
      const entry=p.process.args[++i],split=entry.indexOf('='),key=entry.slice(0,split);
      if(!key.endsWith('.filesystem'))entries.push([key,JSON.parse(entry.slice(split+1))]);
    }
    return Object.fromEntries(entries);
  }
  const native=await fixture(t,'codex','chatgpt'), nativePlan=plan(native.request), c=configFrom(nativePlan);
  const prefix=`model_providers.${c.model_provider}`;
  const endpoint=new URL('responses',c[`${prefix}.base_url`]+'/');
  assert.equal(endpoint.href,'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(c[`${prefix}.requires_openai_auth`],true);
  assert.equal(c[`${prefix}.wire_api`],'responses');
  assert.equal(c[`${prefix}.env_key`],undefined);
  assert.equal(c.openai_base_url,undefined);
  assert.equal(nativePlan.credential,undefined);
  assert.equal(c.cli_auth_credentials_store,'auto');
  for(const credentialsStore of ['file','keyring','auto']) {
    const selected=plan({...native.request,target:{...native.request.target,backend:{...native.request.target.backend,credentialsStore}}});
    assert.equal(configFrom(selected).cli_auth_credentials_store,credentialsStore);
  }
  assert.throws(()=>plan({...native.request,target:{...native.request.target,backend:{...native.request.target.backend,credentialsStore:'invalid'}}}),/credentialsStore/);
  assert.equal(c.default_permissions,'js_agent_runtime');
  assert.ok(nativePlan.process.args.some(value=>value.startsWith('permissions.js_agent_runtime.filesystem=')));
  const api=await fixture(t), apiPlan=plan(api.request), a=configFrom(apiPlan), apiPrefix=`model_providers.${a.model_provider}`;
  assert.equal(a[`${apiPrefix}.base_url`],api.request.target.backend.baseURL);
  assert.equal(a[`${apiPrefix}.requires_openai_auth`],false);
  assert.equal(a[`${apiPrefix}.env_key`],'JS_AGENT_RUNTIME_API_KEY');
  assert.equal(apiPlan.credential.ref,'TEST_CREDENTIAL');
});
test('streams ordered redacted events and persists redacted records without inheriting credentials', { skip: fakeCliSkip },async t=>{
  const f=await fixture(t), events=[]; process.env.UNRELATED_PRIVATE_TOKEN='not-inherited'; t.after(()=>delete process.env.UNRELATED_PRIVATE_TOKEN);
  const r=await run(plan(f.request),{...f.options,onEvent:async e=>{await Promise.resolve();events.push(e)}});
  assert.equal(r.status,'completed'); assert.equal(r.usage.totalTokens,18); assert.equal(r.sessionId,'fake-codex');
  assert.match(r.text,/REDACTED/); assert.equal(events[0].type,'started'); assert.equal(events.at(-1).type,'completed');
  assert.deepEqual(events.map(e=>e.sequence),events.map((_,i)=>i+1));
  const all=(await Promise.all((await readdir(f.options.runDir)).map(file=>readFile(path.join(f.options.runDir,file),'utf8')))).join('\n');
  assert.equal(all.includes(secret),false); assert.equal(JSON.stringify(events).includes(secret),false);
  assert.equal(JSON.parse(await readFile(path.join(f.workspace,'environment.json'),'utf8')).inherited,undefined);
  assert.equal(await readFile(path.join(f.workspace,'artifact.txt'),'utf8'),f.request.prompt);
  await assert.rejects(access(f.request.stateDir));
});
test('Claude API and native login both execute with normalized Messages usage', { skip: fakeCliSkip },async t=>{
  for(const auth of ['api-key','claude-subscription']) {
    const f=await fixture(t,'claude-code',auth);
    const r=await run(plan(f.request),{...f.options,env:{FAKE_SCENARIO:'claude'}});
    assert.equal(r.status,'completed',r.error); assert.equal(r.usage.inputTokens,8); assert.equal(r.usage.totalTokens,11);
    if(auth==='claude-subscription') assert.equal(r.cost,null); else assert.equal(r.cost.total,0.01);
  }
});
test('Codex native login executes without requesting a credential', { skip: fakeCliSkip },async t=>{
  const f=await fixture(t,'codex','chatgpt');
  const r=await run(plan(f.request),{...f.options,resolveCredential:()=>{throw new Error('must not run')}});
  assert.equal(r.status,'completed');
});
test('terminal event, exit status, malformed output and output bounds are enforced', { skip: fakeCliSkip },async t=>{
  for(const mode of ['bad','missing-terminal','failure','overflow']) {
    const f=await fixture(t);
    const r=await run(plan({...f.request,maxOutputBytes:1024}),{...f.options,env:{FAKE_SCENARIO:mode}});
    assert.equal(r.status,'failed',mode); assert.ok(r.error);
  }
});
test('timeout and AbortSignal stop the process group', { skip: fakeCliSkip },async t=>{
  const timeout=await fixture(t);
  const r=await run(plan({...timeout.request,timeoutMs:300,terminationGraceMs:50}),{...timeout.options,env:{FAKE_SCENARIO:'descendant'}});
  assert.equal(r.status,'timed_out');
  const pid=Number(await readFile(path.join(timeout.workspace,'child.pid'),'utf8'));
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.throws(()=>process.kill(pid,0));
  const cancelled=await fixture(t), controller=new AbortController();
  const pending=run(plan(cancelled.request),{...cancelled.options,env:{FAKE_SCENARIO:'hang'},signal:controller.signal});
  setTimeout(()=>controller.abort(),100);
  assert.equal((await pending).status,'cancelled');
});
test('pre-abort and cancelling unresolved credential do not start an agent', { skip: fakeCliSkip },async t=>{
  const f=await fixture(t), c=new AbortController();c.abort();
  assert.equal((await run(plan(f.request),{...f.options,signal:c.signal})).status,'cancelled');
  await assert.rejects(access(path.join(f.workspace,'artifact.txt')));
  const second=await fixture(t), controller=new AbortController();
  const pending=run(plan(second.request),{...second.options,signal:controller.signal,resolveCredential:()=>new Promise(()=>{})});
  setTimeout(()=>controller.abort(),50);
  assert.equal((await pending).status,'cancelled');
});
test('modified plan, protected env and duplicate record directory are rejected', { skip: fakeCliSkip },async t=>{
  const f=await fixture(t), p=plan(f.request);
  await assert.rejects(run({...p,process:{...p.process,args:['different']}},f.options),/modified/);
  await assert.rejects(run(p,{...f.options,env:{OPENAI_API_KEY:'wrong'}}),/Protected/);
  assert.equal((await run(p,f.options)).status,'completed');
  assert.equal((await run(p,f.options)).status,'failed');
  assert.equal(JSON.parse(await readFile(path.join(f.options.runDir,'result.json'),'utf8')).status,'completed');
});
test('runtime rejects symlinked authentication/log paths into the workspace',async t=>{
  const native=await fixture(t,'codex','chatgpt'), linkedAuth=path.join(native.dir,'linked-auth');
  await symlink(native.workspace,linkedAuth);
  const target={...native.request.target,backend:{...native.request.target.backend,codexHome:linkedAuth}};
  assert.equal((await run(plan({...native.request,target}),native.options)).status,'failed');
  const f=await fixture(t), linkedLogs=path.join(f.dir,'linked-logs');await symlink(f.workspace,linkedLogs);
  const result=await run(plan(f.request),{...f.options,runDir:path.join(linkedLogs,'runtime')});
  assert.equal(result.status,'failed');assert.match(result.error,/Resolved runDir/);
});
test('observer failure interrupts execution and produces a failed result', { skip: fakeCliSkip },async t=>{
  const f=await fixture(t);
  const r=await run(plan(f.request),{...f.options,env:{FAKE_SCENARIO:'hang'},onEvent:()=>{throw new Error(secret)}});
  assert.equal(r.status,'failed'); assert.match(r.error,/observer/); assert.equal(JSON.stringify(r).includes(secret),false);
});
test('probe is static by default and native metadata checks use only fake CLI', { skip: fakeCliSkip },async t=>{
  const f=await fixture(t,'codex','chatgpt');
  assert.equal((await probe(plan(f.request))).ok,true);
  const r=await probe(plan(f.request),{checkExecutable:true,checkLogin:true});
  assert.equal(r.ok,true); assert.equal(r.checks.length,2);
  await assert.rejects(access(path.join(f.workspace,'artifact.txt')));
  const claude=await fixture(t,'claude-code','claude-subscription');
  assert.equal((await probe(plan(claude.request),{checkExecutable:true,checkLogin:true})).ok,true);
  await assert.rejects(access(claude.request.stateDir));
});
test('extensions are registered explicitly and cannot replace built-ins', { skip: fakeCliSkip },async t=>{
  assert.throws(()=>registerAdapter({id:'codex',version:'x'}),/already registered/);
  const f=await fixture(t);
  const unregister=registerAdapter({id:'fake-extension',version:'1',validate:t=>assert.equal(t.backend.auth,'test'),plan:(r)=>({files:[],process:{executable:r.target.harness.executable,args:[],cwd:r.workspace,stdin:r.prompt,env:{FAKE_SCENARIO:'codex'}}}),createParser:()=>({push:()=>[],finish:()=>({completed:true,failed:false,text:'extension',usage:null,cost:null,sessionId:null,responseModel:null,error:null})})});
  t.after(unregister);
  const request={...f.request,target:{...f.request.target,harness:{...f.request.target.harness,adapter:'fake-extension'},backend:{auth:'test',model:'x'}}};
  assert.equal((await run(plan(request),f.options)).text,'extension');
  unregister();assert.throws(()=>plan(request),/Unknown adapter/);
});
test('snapshot hashes are stable, omit private env/dependencies and reject symlinks',async t=>{
  const f=await fixture(t); await writeFile(path.join(f.workspace,'a.txt'),'hello');await writeFile(path.join(f.workspace,'.env'),'never read');
  const a=await snapshotDirectory(f.workspace);assert.equal(a.files.length,1);assert.deepEqual(a,await snapshotDirectory(f.workspace));
  assert.equal(hashObject({b:2,a:1}),hashObject({a:1,b:2}));
  await symlink(path.join(f.workspace,'a.txt'),path.join(f.workspace,'link'));
  await assert.rejects(snapshotDirectory(f.workspace),/symbolic link/);
});
test('redaction handles known secrets, bearer strings, encoded forms and sensitive object fields',()=>{
  const r=createRedactor([secret]);const data=r.value({text:secret+' '+Buffer.from(secret).toString('base64'),api_key:'other',usage:{input_tokens:4},url:'https://name:password@example.invalid'});
  assert.equal(JSON.stringify(data).includes(secret),false);assert.equal(data.api_key,'[REDACTED]');assert.equal(data.usage.input_tokens,4);assert.equal(data.url.includes('password'),false);
  assert.equal(r.text('{"access_token":"not-a-known-key"}').includes('not-a-known-key'),false);
});
