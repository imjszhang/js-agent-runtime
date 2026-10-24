// Explicit opt-in: real CLI sandbox metadata/execution, never a model request.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { plan } from '../dist/index.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'js-agent-runtime-sandbox-'));
const executable = process.env.CODEX_EXECUTABLE ?? 'codex';
try {
  for (const auth of ['api-key', 'chatgpt']) for (const permission of ['read-only', 'workspace-write']) {
    const base = path.join(root, `${auth}-${permission}`), workspace = path.join(base, 'repo/nested/workspace');
    const stateDir = path.join(base, 'state'), authDir = path.join(base, 'auth');
    await mkdir(workspace, { recursive: true }); await mkdir(path.join(base, 'repo/.git')); await mkdir(stateDir); await mkdir(authDir);
    const backend = auth === 'chatgpt' ? { auth, model: 'not-called', codexHome: authDir }
      : { auth, model: 'not-called', provider: 'not-called', protocol: 'responses', baseURL: 'https://example.invalid/v1', apiKeyEnv: 'NOT_READ' };
    const p = plan({ runId: 'sandbox-check', workspace, prompt: 'not-sent', timeoutMs: 10_000, stateDir, target: { name: 'sandbox', harness: { adapter: 'codex', executable, permission }, backend } });
    if (auth === 'api-key') await mkdir(p.process.env.CODEX_HOME, {recursive:true});
    const config = [];
    for (let i = 0; i < p.process.args.length; i++) if (p.process.args[i] === '-c') config.push('-c', p.process.args[++i]);
    const script = 'const fs=require("fs");for(const file of ["inside.txt","../../outside.txt"]){try{fs.writeFileSync(file,"test");console.log(file+":allowed")}catch(e){console.log(file+":"+e.code)}}';
    const result = spawnSync(executable, ['sandbox', '-C', workspace, '-P', auth === 'chatgpt' ? 'js_agent_runtime' : permission === 'workspace-write' ? ':workspace' : ':read-only', ...config, '--', process.execPath, '-e', script], {
      cwd: workspace, env: { PATH: process.env.PATH, ...p.process.env }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, permission === 'workspace-write' ? /inside.txt:allowed/u : /inside.txt:(EPERM|EACCES)/u);
    assert.match(result.stdout, /\.\.\/\.\.\/outside.txt:(EPERM|EACCES)/u);
    console.log(`${auth}/${permission}: workspace and ancestor write boundaries passed`);
  }
} finally { await rm(root, { recursive: true, force: true }); }
