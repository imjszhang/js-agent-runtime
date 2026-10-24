import { appendFileSync, writeFileSync } from "node:fs";
import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertPlan, getAdapter, RUNTIME_VERSION } from "./plan.js";
import { baseEnvironment, runProcess } from "./process.js";
import { createRedactor } from "./redaction.js";
import { absolute, envName, overlaps } from "./validation.js";
import type { ExecutionPlan, RunOptions, RunResult, RuntimeEvent, EventType } from "./types.js";

/** Operational values only. Auth and CLI configuration have dedicated typed inputs. */
export function operationalEnvironment(env: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(env)) {
    envName(key, "env key");
    if (/KEY|TOKEN|SECRET|PASSWORD|AUTH|^HOME$|^USERPROFILE$|^XDG_|^CODEX_|^CLAUDE_|^ANTHROPIC_|^OPENAI_|^DSH_|^DEEPSEEK_|^AGENTS_HOME$|^JS_AGENT_RUNTIME_API_KEY$|^NODE_OPTIONS$|^LD_|^DYLD_/iu.test(key)) throw new Error(`Protected environment override: ${key}`);
    if (typeof value !== "string" || value.includes("\0")) throw new Error(`Invalid environment value: ${key}`);
  }
  return { ...env };
}
async function newDirectory(directory: string): Promise<void> {
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
}
export async function prepareStateDirectories(env: Record<string, string>, stateDir: string): Promise<void> {
  for (const key of ["HOME", "USERPROFILE", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "DSH_HOME", "AGENTS_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "CLAUDE_CODE_TMPDIR"]) {
    const directory = env[key];
    if (directory && path.resolve(directory).startsWith(`${path.resolve(stateDir)}${path.sep}`)) await mkdir(directory, { recursive: true, mode: 0o700 });
  }
}
export async function run(input: ExecutionPlan, options: RunOptions = {}): Promise<RunResult> {
  const execution = assertPlan(input), { request } = execution;
  const started = Date.now(), startedAt = new Date(started).toISOString(), redactor = createRedactor();
  const env = operationalEnvironment(options.env), adapter = getAdapter(execution.adapter.id), parser = adapter.createParser();
  let ownedState = false, logDir: string | undefined, sequence = 0, callbackError = false, parseError: string | null = null;
  let callbackQueue = Promise.resolve();
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(); options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const result: RunResult = { schemaVersion: 1, runtimeVersion: RUNTIME_VERSION, runId: request.runId, planHash: execution.planHash, adapter: execution.adapter, status: "failed", text: "", usage: null, cost: null, sessionId: null, responseModel: null, exitCode: null, signal: null, error: null, startedAt, finishedAt: startedAt, durationMs: 0 };
  function emit(type: EventType, data: unknown): void {
    const event: RuntimeEvent = redactor.value({ schemaVersion: 1, runId: request.runId, sequence: ++sequence, time: new Date().toISOString(), type, data });
    if (logDir) appendFileSync(path.join(logDir, "events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
    if (options.onEvent) callbackQueue = callbackQueue.then(() => callbackError ? undefined : options.onEvent!(event)).then(() => undefined).catch(() => { callbackError = true; controller.abort(); });
  }
  try {
    if (controller.signal.aborted) { result.status = "cancelled"; result.error = "Run cancelled before start"; }
    else {
      const workspace = await realpath(request.workspace), workspaceStat = await lstat(request.workspace);
      if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) throw new Error("workspace must be an existing real directory");
      const parent = path.dirname(execution.stateDir); await mkdir(parent, { recursive: true, mode: 0o700 });
      const realState = path.join(await realpath(parent), path.basename(execution.stateDir));
      if (overlaps(realState, workspace)) throw new Error("Resolved stateDir overlaps workspace");
      const backend = request.target.backend;
      const authDirectory = backend.auth === "chatgpt" ? execution.process.env.CODEX_HOME
        : backend.auth === "claude-subscription" || backend.auth === "claude-config" ? execution.process.env.CLAUDE_CONFIG_DIR ?? path.join(execution.process.env.HOME!, ".claude") : undefined;
      if (authDirectory) {
        const resolvedAuth = await realpath(authDirectory).catch((cause: NodeJS.ErrnoException) => { if (cause.code === "ENOENT") return path.resolve(authDirectory); throw cause; });
        if (overlaps(resolvedAuth, workspace) || overlaps(resolvedAuth, realState)) throw new Error("Resolved authentication directory overlaps workspace or temporary state");
      }
      if (options.runDir) {
        const requested = absolute(options.runDir, "runDir");
        const projectLogs = request.target.harness.contextMode === "project";
        const invalidWorkspaceOverlap = (logs: string, cwd: string): boolean => overlaps(logs, cwd) && !(projectLogs && logs.startsWith(`${cwd}${path.sep}`));
        if (invalidWorkspaceOverlap(requested, request.workspace) || overlaps(requested, execution.stateDir)) throw new Error("runDir must not overlap workspace or stateDir");
        await mkdir(path.dirname(requested), { recursive: true, mode: 0o700 });
        const resolvedLogs = path.join(await realpath(path.dirname(requested)), path.basename(requested));
        if (invalidWorkspaceOverlap(resolvedLogs, workspace) || overlaps(resolvedLogs, realState)) throw new Error("Resolved runDir overlaps workspace or stateDir");
        await newDirectory(requested); logDir = requested;
      }
      await newDirectory(execution.stateDir); ownedState = true;
      const processEnv = { ...baseEnvironment(), ...env, ...execution.process.env };
      await prepareStateDirectories(processEnv, execution.stateDir);
      if (execution.credential) {
        let key: string | undefined;
        try {
          let timer: NodeJS.Timeout | undefined;
          let abortCredential: (() => void) | undefined;
          try {
            key = await Promise.race([
              Promise.resolve((options.resolveCredential ?? (name => process.env[name]))(execution.credential.ref)),
              new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("credential deadline")), Math.max(1, request.timeoutMs - (Date.now() - started))); }),
              new Promise<never>((_, reject) => { abortCredential = () => reject(new Error("cancelled")); controller.signal.addEventListener("abort", abortCredential, { once: true }); if (controller.signal.aborted) abortCredential(); }),
            ]);
          } finally { if (timer) clearTimeout(timer); if (abortCredential) controller.signal.removeEventListener("abort", abortCredential); }
        } catch { throw new Error("Credential resolution failed or exceeded the task deadline"); }
        if (typeof key !== "string" || !key || key.includes("\0")) throw new Error(`Missing credential: ${execution.credential.ref}`);
        redactor.add(key); processEnv[execution.credential.envVar] = key;
      }
      for (const value of Object.values(env)) if (/:\/\/[^\s/]+:[^\s/]+@/u.test(value)) redactor.add(value);
      if (logDir) {
        writeFileSync(path.join(logDir, "plan.json"), JSON.stringify(redactor.value(execution), null, 2) + "\n", { mode: 0o600, flag: "wx" });
        for (const file of ["stdout.log", "stderr.log", "events.jsonl"]) writeFileSync(path.join(logDir, file), "", { mode: 0o600, flag: "wx" });
      }
      for (const file of execution.files) { await mkdir(path.dirname(file.path), { recursive: true, mode: 0o700 }); await writeFile(file.path, file.content, { mode: file.mode ?? 0o600, flag: "wx" }); }
      emit("started", { adapter: execution.adapter, target: request.target.name });
      const remaining = request.timeoutMs - (Date.now() - started);
      if (remaining <= 0) { result.status = "timed_out"; result.error = "Task deadline exceeded before process start"; }
      else {
        const processResult = await runProcess({ ...execution.process, env: processEnv }, {
          signal: controller.signal, timeoutMs: remaining, maxOutputBytes: request.maxOutputBytes,
          // DSH grants its managed shells three seconds to close on SIGTERM.
          terminationGraceMs: request.terminationGraceMs ?? (adapter.id === "deepseek-harness" ? 4000 : undefined),
          onLine: (stream, line) => {
            if (logDir) appendFileSync(path.join(logDir, `${stream}.log`), redactor.text(line) + "\n", { mode: 0o600 });
            if (!line.trim()) return;
            if (stream === "stderr") { emit("diagnostic", { stream, text: line }); return; }
            try { for (const event of parser.push(JSON.parse(line))) emit(event.type, event.data); }
            catch { parseError ??= "Agent emitted malformed or unsupported JSON events"; emit("raw", { text: line }); }
          },
        });
        const parsed = parser.finish();
        Object.assign(result, { text: parsed.text, usage: parseError ? null : parsed.usage, cost: parsed.cost, sessionId: parsed.sessionId, responseModel: parsed.responseModel, exitCode: processResult.exitCode, signal: processResult.signal });
        if (options.signal?.aborted || (processResult.cancelled && !callbackError)) { result.status = "cancelled"; result.error = "Run cancelled"; }
        else if (processResult.timedOut) { result.status = "timed_out"; result.error = processResult.error; }
        else if (processResult.error || processResult.exitCode !== 0 || parseError || parsed.failed || !parsed.completed) result.error = processResult.error ?? parseError ?? parsed.error ?? (processResult.exitCode !== 0 ? `Agent process exited with ${processResult.signal ?? processResult.exitCode}` : "Agent ended without a terminal completion event");
        else { result.status = "completed"; result.error = null; }
      }
    }
  } catch (cause) {
    result.status = options.signal?.aborted ? "cancelled" : Date.now() - started >= request.timeoutMs ? "timed_out" : "failed";
    result.error = cause instanceof Error ? cause.message : "Runtime failed";
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (ownedState) await rm(execution.stateDir, { recursive: true, force: true }).catch(() => { result.status = "failed"; result.error = "Failed to clean up temporary runtime state"; });
  }
  // Ordered observers have a bounded drain; a broken observer cannot keep a run alive forever.
  async function drainCallbacks(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([callbackQueue, new Promise<void>(resolve => { timer = setTimeout(() => { callbackError = true; resolve(); }, 5000); })]);
    if (timer) clearTimeout(timer);
  }
  await drainCallbacks();
  if (callbackError) { result.status = "failed"; result.error = "Runtime event observer failed or did not settle"; }
  result.finishedAt = new Date().toISOString(); result.durationMs = Date.now() - started;
  const safe = redactor.value(result);
  try {
    emit(safe.status, { status: safe.status, error: safe.error });
    await drainCallbacks();
    if (callbackError) { safe.status = "failed"; safe.error = "Runtime event observer failed or did not settle"; }
    if (logDir) writeFileSync(path.join(logDir, "result.json"), JSON.stringify(safe, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  } catch { safe.status = "failed"; safe.error = "Failed to persist runtime result"; }
  return safe;
}
