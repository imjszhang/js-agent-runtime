// Explicit opt-in: real DSH CLI against a loopback-only Messages stub. No real key or paid API.
// Build first, then JS_AGENT_RUNTIME_DSH_EXECUTABLE=/absolute/path/to/dsh node tests/native-deepseek.mjs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { plan, probe, run } from '../dist/index.js';

async function exists(file) { try { await access(file); return true; } catch { return false; } }
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const fakeKey = 'native-loopback-only-credential-349170';
const model = 'native-smoke-model';
const marker = 'WORKSPACE_NATIVE_RULE_724901';
const parentMarker = 'PARENT_RULE_MUST_NOT_LOAD_839201';
const description = 'PROJECT_SKILL_CATALOG_349701';
const skillBody = 'PROJECT_SKILL_BODY_592103';
const poisonDescription = 'NON_SELECTED_SKILL_ROOT_924105';
const finalText = 'DEEPSEEK_NATIVE_SMOKE_OK';

const executable = process.env.JS_AGENT_RUNTIME_DSH_EXECUTABLE;
if (!executable) {
  console.error('Set JS_AGENT_RUNTIME_DSH_EXECUTABLE to an installed DSH executable; no CLI is installed by this test.');
  process.exitCode = 1;
} else {
  await nativeSmoke(executable);
}

function streamMessage(response, step, action) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
  const emit = event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  emit({ type: 'message_start', message: { id: `msg_${step}`, type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } } });
  if (action.tool) {
    emit({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tool_${step}`, name: action.tool, input: {} } });
    emit({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(action.input) } });
  } else {
    emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: finalText } });
  }
  emit({ type: 'content_block_stop', index: 0 });
  emit({ type: 'message_delta', delta: { stop_reason: action.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
  emit({ type: 'message_stop' });
  response.end();
}

function toolResult(body, call) {
  return (body.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : [])
    .find(block => block.type === 'tool_result' && block.tool_use_id === `tool_${call}`);
}

async function nativeSmoke(cli) {
  // /tmp is writable even under workspace-write. Use HOME so the outside-write test is real.
  const root = await mkdtemp(path.join(os.homedir(), '.js-agent-runtime-dsh-native-'));
  let server;
  try {
    const scenarios = [
      { name: 'project-write', contextMode: 'project', permission: 'workspace-write' },
      { name: 'project-read-only', contextMode: 'project', permission: 'read-only' },
      { name: 'snapshot-write', contextMode: 'snapshot', permission: 'workspace-write' },
      { name: 'project-bypass', contextMode: 'project', permission: 'bypass' },
    ];
    let active;
    server = createServer(async (request, response) => {
      try {
        assert.ok(active, 'no active smoke scenario');
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/selected/anthropic/v1/messages', 'provider base URL was not preserved');
        assert.equal(request.headers['x-api-key'], fakeKey, 'runtime credential must reach only the local stub');
        let raw = '';
        for await (const part of request) {
          raw += part;
          assert.ok(raw.length < 4 * 1024 * 1024, 'unexpectedly large model request');
        }
        const body = JSON.parse(raw);
        assert.equal(body.model, model);
        assert.equal(body.stream, true);
        const current = active.index++;
        active.requests.push(body);
        const action = active.actions[current];
        assert.ok(action, 'unexpected extra model request');
        const serialized = JSON.stringify(body);
        assert.ok(!serialized.includes(parentMarker), 'ancestor AGENTS.md leaked into this workspace');
        assert.ok(!serialized.includes(poisonDescription), 'unselected native skill directory leaked');
        if (current === 0) {
          const tools = new Set((body.tools ?? []).map(tool => tool.name));
          assert.equal(serialized.includes(marker), active.contextMode === 'project', 'project/snapshot rule loading mismatch');
          assert.equal(serialized.includes(description), true, 'workspace skill catalog missing');
          assert.equal(tools.has('skill'), true, 'workspace skill tool missing');
          if (active.permission === 'read-only') assert.equal(tools.has('bash'), false, 'read-only must not expose shell');
        }
        if (current > 0) {
          const previous = active.actions[current - 1];
          const result = toolResult(body, current - 1);
          assert.ok(result, `missing native ${previous.tool} result`);
          if (previous.tool === 'skill') {
            assert.notEqual(result.is_error, true, JSON.stringify(result));
            assert.ok(serialized.includes(skillBody), 'skill body was never read');
          }
          if (previous.expectedDenied) {
            assert.equal(result.is_error, true, `mutation should have been denied: ${JSON.stringify(result)}`);
            assert.match(JSON.stringify(result), /denied|sandbox|permission/i);
          }
          if (previous.expectedFile) {
            assert.equal(await exists(previous.expectedFile), true, `expected file missing after ${previous.tool}: ${JSON.stringify(result)}`);
            assert.equal(await readFile(previous.expectedFile, 'utf8'), previous.expectedContent);
          }
          if (previous.absentFile) assert.equal(await exists(previous.absentFile), false, 'sandbox allowed an unintended write');
        }
        streamMessage(response, current, action);
      } catch (error) {
        active?.errors.push(error);
        // Complete immediately rather than triggering native retries of an assertion failure.
        if (!response.headersSent) streamMessage(response, 9000, {});
        else response.end();
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const baseURL = `http://127.0.0.1:${server.address().port}/selected/anthropic`;
    for (const scenario of scenarios) {
      const base = path.join(root, scenario.name), workspace = path.join(base, 'parent', 'workspace');
      await mkdir(path.join(workspace, '.agents/skills/native-dsh-smoke'), { recursive: true });
      await mkdir(path.join(workspace, '.dsh/skills/not-selected'), { recursive: true });
      // A parent Git marker catches accidental ancestor discovery in both modes.
      await mkdir(path.join(base, 'parent/.git'));
      await writeFile(path.join(base, 'parent/AGENTS.md'), parentMarker);
      await writeFile(path.join(workspace, 'AGENTS.md'), marker);
      await writeFile(path.join(workspace, '.agents/skills/native-dsh-smoke/SKILL.md'),
        `---\nname: native-dsh-smoke\ndescription: ${description}\n---\n${skillBody}\n`);
      await writeFile(path.join(workspace, '.dsh/skills/not-selected/SKILL.md'),
        `---\nname: not-selected\ndescription: ${poisonDescription}\n---\nMust not load.\n`);
      // A project .env cannot replace the explicitly supplied process-layer credential.
      await writeFile(path.join(workspace, '.env'), 'JS_AGENT_RUNTIME_API_KEY=wrong-project-value\n');
      const inside = path.join(workspace, 'artifact.txt'), outside = path.join(base, 'outside.txt');
      const insideShell = path.join(workspace, 'shell.txt'), outsideShell = path.join(base, 'outside-shell.txt');
      const actions = [{ tool: 'skill', input: { name: 'native-dsh-smoke' } }];
      actions.push({ tool: 'write', input: { file_path: inside, content: 'native artifact\n' },
        ...(scenario.permission === 'read-only' ? { expectedDenied: true, absentFile: inside }
          : { expectedFile: inside, expectedContent: 'native artifact\n' }) });
      actions.push({ tool: 'write', input: { file_path: outside, content: 'outside artifact\n' },
        ...(scenario.permission === 'bypass' ? { expectedFile: outside, expectedContent: 'outside artifact\n' }
          : { expectedDenied: true, absentFile: outside }) });
      if (scenario.permission !== 'read-only') actions.push({ tool: 'bash', input: {
        command: `printf 'shell artifact\\n' > ${quote(insideShell)}; printf 'outside shell\\n' > ${quote(outsideShell)}`,
        description: 'Verify native shell workspace write boundaries using temporary files.',
      }, expectedFile: insideShell, expectedContent: 'shell artifact\n',
        ...(scenario.permission === 'bypass' ? {} : { absentFile: outsideShell }) });
      actions.push({});
      active = { ...scenario, actions, index: 0, requests: [], errors: [] };
      const request = { runId: scenario.name, workspace, prompt: 'Run the deterministic local smoke task. Follow the project skill when available.',
        timeoutMs: 60_000, stateDir: path.join(base, 'state'),
        target: { name: 'native-deepseek-smoke', harness: { adapter: 'deepseek-harness', executable: cli,
          permission: scenario.permission, contextMode: scenario.contextMode },
        backend: { auth: 'api-key', provider: 'independent-local-stub', model, protocol: 'anthropic-messages',
          baseURL, apiKeyEnv: 'NOT_A_REAL_API_KEY' } } };
      const executionPlan = plan(request);
      const probeResult = await probe(executionPlan, { checkExecutable: true, timeoutMs: 10_000 });
      assert.equal(probeResult.ok, true, JSON.stringify(probeResult));
      const events = [];
      const result = await run(executionPlan, { resolveCredential: () => fakeKey,
        runDir: path.join(base, 'logs'), onEvent: event => { events.push(event); },
        env: { HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost',
          http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '127.0.0.1,localhost' } });
      assert.equal(active.errors.length, 0, active.errors.map(error => error.stack).join('\n'));
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.equal(result.text, finalText);
      assert.equal(active.requests.length, actions.length);
      assert.ok(result.sessionId);
      assert.equal(result.responseModel, null);
      assert.equal(result.cost, null);
      assert.deepEqual(result.usage, { inputTokens: 13 * actions.length, outputTokens: 3 * actions.length,
        totalTokens: 16 * actions.length, cachedInputTokens: 2 * actions.length, reasoningTokens: null });
      assert.equal(events.at(-1).type, 'completed');
      assert.ok(events.some(event => event.type === 'tool'));
      assert.equal(JSON.stringify(events).includes(fakeKey), false);
      if (scenario.permission === 'bypass') assert.equal(await readFile(outsideShell, 'utf8'), 'outside shell\n');
      console.log(`${scenario.name}: local provider, native tools/context, permissions and usage passed (${actions.length} steps)`);
    }
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
