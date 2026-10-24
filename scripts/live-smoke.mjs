// Explicit live check: build first, then supply targets and a new output directory.
// Credentials come only from the named process environment variables; no .env is loaded.
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { plan, probe, run, createRedactor } from '../dist/index.js';

const marker = 'NATIVE_SMOKE_OK';
const redactor = createRedactor();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const errorText = error => redactor.text(error instanceof Error ? error.message : 'Live smoke failed');
const log = message => console.log(redactor.text(message));
const save = (file, value) => writeFile(file, JSON.stringify(redactor.value(value), null, 2) + '\n', { flag: 'wx', mode: 0o600 });

function argumentsFor(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!['--config', '--output'].includes(key) || args[key] || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error('Usage: node scripts/live-smoke.mjs --config <JSON path> --output <new absolute directory>');
    }
    args[key] = argv[index + 1];
  }
  if (!args['--config'] || !args['--output'] || !path.isAbsolute(args['--output'])) {
    throw new Error('Both --config and a new absolute --output directory are required');
  }
  return args;
}

async function smallRegularFile(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw new Error('Artifact must be a regular file of at most 64 KiB');
  return readFile(file);
}

async function checkArtifacts(workspace, input, originalHash) {
  const checks = {
    inputSha256Before: originalHash, inputSha256After: null, inputUnchanged: false,
    resultSha256: null, resultJsonValid: false, nonceMatches: false, sumMatches: false,
    expectedSum: input.values.reduce((sum, value) => sum + value, 0), actualSum: null, errors: [],
  };
  try {
    checks.inputSha256After = hash(await smallRegularFile(path.join(workspace, 'input.json')));
    checks.inputUnchanged = checks.inputSha256After === originalHash;
  } catch (error) { checks.errors.push(`input.json: ${errorText(error)}`); }
  try {
    const bytes = await smallRegularFile(path.join(workspace, 'result.json'));
    checks.resultSha256 = hash(bytes);
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error('Invalid JSON'); }
    checks.resultJsonValid = value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).sort().join(',') === 'nonce,sum'
      && typeof value.nonce === 'string' && Number.isSafeInteger(value.sum);
    if (checks.resultJsonValid) {
      checks.nonceMatches = value.nonce === input.nonce;
      checks.sumMatches = value.sum === checks.expectedSum;
      checks.actualSum = value.sum;
    }
  } catch (error) { checks.errors.push(`result.json: ${errorText(error)}`); }
  return checks;
}

async function checkTarget(target, index, output, timeoutMs) {
  const started = Date.now();
  const runId = `live-${index + 1}-${randomUUID()}`;
  const directory = path.join(output, String(index + 1).padStart(2, '0'));
  const workspace = path.join(directory, 'workspace');
  const record = {
    runId, name: target?.name ?? `target-${index + 1}`, adapter: target?.harness?.adapter ?? null,
    auth: target?.backend?.auth ?? null, model: target?.backend?.model ?? null,
    directory, workspace, stateDir: path.join(directory, 'state'), runDir: path.join(directory, 'logs'),
    startedAt: new Date(started).toISOString(), finishedAt: null, durationMs: null,
    probeDurationMs: null, runDurationMs: null, probe: null, execution: null,
    toolEvents: 0, finalMarkerMatches: false, artifacts: null, passed: false, error: null,
  };
  let input, originalHash;
  try {
    await mkdir(directory, { mode: 0o700 });
    await mkdir(workspace, { mode: 0o700 });
    input = { nonce: randomUUID(), values: Array.from({ length: 5 }, () => randomInt(-50, 101)) };
    const bytes = JSON.stringify(input, null, 2) + '\n';
    originalHash = hash(bytes);
    await writeFile(path.join(workspace, 'input.json'), bytes, { flag: 'wx', mode: 0o600 });
    const executionPlan = plan({
      runId, target, workspace, stateDir: record.stateDir, timeoutMs,
      prompt: [
        'This is a small native agent smoke test. Use your tools to read input.json in the current workspace.',
        'Write result.json in this workspace as a JSON object with exactly two fields: nonce (the unchanged input nonce) and sum (the integer sum of input.values).',
        'You must actually create the file with a tool. Do not modify input.json. Do not install anything or read files outside this workspace.',
        'After creating and checking result.json, respond with exactly NATIVE_SMOKE_OK.',
      ].join('\n'),
    });
    log(`[${index + 1}] ${record.name}: probe`);
    const probeStarted = Date.now();
    try {
      record.probe = await probe(executionPlan, { checkExecutable: true, checkLogin: true, timeoutMs: Math.min(timeoutMs, 30_000) });
    } finally { record.probeDurationMs = Date.now() - probeStarted; }
    if (!record.probe.ok) throw new Error('Executable or login metadata probe failed');
    log(`[${index + 1}] ${record.name}: run`);
    const runStarted = Date.now();
    let result;
    try {
      result = await run(executionPlan, {
        runDir: record.runDir,
        resolveCredential: ref => {
          // The validated plan resolves only this target's explicitly selected credential reference.
          if (ref !== executionPlan.credential?.ref) return undefined;
          return process.env[ref];
        },
        onEvent: event => { if (event.type === 'tool') record.toolEvents += 1; },
      });
    } finally { record.runDurationMs = Date.now() - runStarted; }
    record.execution = {
      status: result.status, exitCode: result.exitCode, signal: result.signal, error: result.error,
      startedAt: result.startedAt, finishedAt: result.finishedAt, durationMs: result.durationMs,
      runtimeVersion: result.runtimeVersion, adapter: result.adapter, planHash: result.planHash,
      sessionId: result.sessionId, responseModel: result.responseModel, usage: result.usage, cost: result.cost,
    };
    record.finalMarkerMatches = result.text.includes(marker);
    if (result.status !== 'completed' || result.exitCode !== 0) record.error = result.error ?? 'Native execution did not complete successfully';
  } catch (error) { record.error = errorText(error); }
  if (input && originalHash) record.artifacts = await checkArtifacts(workspace, input, originalHash);
  record.passed = record.probe?.ok === true && record.execution?.status === 'completed'
    && record.execution.exitCode === 0 && record.finalMarkerMatches
    && record.artifacts?.inputUnchanged === true && record.artifacts.resultJsonValid
    && record.artifacts.nonceMatches && record.artifacts.sumMatches;
  if (!record.passed && !record.error) record.error = 'Final marker or artifact validation failed';
  record.finishedAt = new Date().toISOString();
  record.durationMs = Date.now() - started;
  log(`[${index + 1}] ${record.name}: ${record.passed ? 'passed' : 'failed'}${record.error ? ` (${record.error})` : ''}`);
  return redactor.value(record);
}

async function main() {
  const args = argumentsFor(process.argv.slice(2));
  let config;
  try { config = JSON.parse(await readFile(args['--config'], 'utf8')); }
  catch { throw new Error('Could not read --config as JSON'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(key => !['targets', 'timeoutMs'].includes(key))
    || !Array.isArray(config.targets) || !config.targets.length) {
    throw new Error('Config must contain a non-empty targets array and optional timeoutMs');
  }
  const timeoutMs = config.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('Invalid timeoutMs');
  for (const target of config.targets) {
    const backend = target?.backend;
    const ref = backend?.apiKeyEnv ?? (backend?.auth === 'cursor-api-key' ? 'CURSOR_API_KEY' : undefined);
    if (typeof ref === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(ref) && process.env[ref]) redactor.add(process.env[ref]);
  }
  const requested = path.resolve(args['--output']);
  // Resolve existing parent aliases before planning; mkdir without recursive makes output new-only.
  const output = path.join(await realpath(path.dirname(requested)), path.basename(requested));
  await mkdir(output, { mode: 0o700 });
  const started = Date.now();
  const results = new Array(config.targets.length);
  let next = 0;
  async function worker() {
    while (next < config.targets.length) {
      const index = next++;
      results[index] = await checkTarget(config.targets[index], index, output, timeoutMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, config.targets.length) }, () => worker()));
  const summary = {
    schemaVersion: 1, startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started, timeoutMs, probeTimeoutMs: Math.min(timeoutMs, 30_000),
    concurrency: Math.min(3, config.targets.length), total: results.length,
    passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length,
    results,
  };
  await save(path.join(output, 'summary.json'), summary);
  log(`Live smoke: ${summary.passed}/${summary.total} passed. Summary: ${path.join(output, 'summary.json')}`);
  if (summary.failed) process.exitCode = 1;
}

main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
