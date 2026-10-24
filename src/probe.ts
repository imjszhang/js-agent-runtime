import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertPlan, getAdapter } from "./plan.js";
import { baseEnvironment, runProcess } from "./process.js";
import { createRedactor } from "./redaction.js";
import { operationalEnvironment, prepareStateDirectories } from "./run.js";
import { integer, keys, record } from "./validation.js";
import { metadataProcess, processSucceeded, assertCompatibleVersion, loginVerdict } from "./metadata.js";
import type { ExecutionPlan, ProbeOptions, ProbeResult } from "./types.js";

/** No model requests. CLI version/login metadata commands require explicit opt-in. */
export async function probe(input: ExecutionPlan, options: ProbeOptions = {}): Promise<ProbeResult> {
  const execution = assertPlan(input);
  keys(record(options), ["checkExecutable", "checkLogin", "timeoutMs", "env", "signal"], "probe options");
  for (const flag of ["checkExecutable", "checkLogin"] as const) if (options[flag] !== undefined && typeof options[flag] !== "boolean") throw new Error(`${flag} must be boolean`);
  const timeoutMs = options.timeoutMs === undefined ? 10_000 : integer(options.timeoutMs, "probe timeoutMs", 1, 120_000);
  const result: ProbeResult = { schemaVersion: 1, adapter: execution.adapter.id, executable: execution.adapter.id === "cursor-agent" ? execution.request.target.harness.executable : execution.process.executable, checks: [], ok: true };
  if (!options.checkExecutable && !options.checkLogin) { result.checks.push({ name: "configuration", status: "passed", message: "Static configuration is valid; CLI/auth checks were not requested" }); return result; }
  const operational = operationalEnvironment(options.env), started = Date.now();
  const temporary = await mkdtemp(path.join(tmpdir(), "js-agent-runtime-probe-")), redactor = createRedactor();
  for (const value of Object.values({ ...baseEnvironment(), ...operational })) if (/:\/\/[^\s/]+:[^\s/]+@/u.test(value)) redactor.add(value);
  try {
    const invoke = async (kind: "version" | "login", args?: string[]) => {
      const command = metadataProcess(execution, temporary, kind, args);
      const env = { ...baseEnvironment(), ...operational, ...command.env };
      await prepareStateDirectories(env, temporary);
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) throw new Error("CLI metadata deadline exceeded");
      return runProcess({ ...command, env }, { timeoutMs: remaining, maxOutputBytes: 32_768, terminationGraceMs: 200, signal: options.signal });
    };
    // Login interpretation for these CLIs depends on a known native format.
    const versionRequired = options.checkExecutable || (options.checkLogin && (execution.adapter.id === "cursor-agent" || execution.request.target.backend.auth === "claude-subscription"));
    let versionPassed = true;
    if (versionRequired) {
      const args = getAdapter(execution.adapter.id).probeArgs;
      if (!args) { versionPassed = false; result.checks.push({ name: "executable", status: "unknown", message: "Adapter does not declare a metadata command" }); }
      else {
        try {
          const response = await invoke("version", args);
          if (!processSucceeded(response)) throw new Error("Executable metadata check failed");
          const version = response.stdout.trim() || response.stderr.trim();
          assertCompatibleVersion(execution, version);
          result.checks.push({ name: "executable", status: "passed", message: redactor.text(version.slice(0, 256) || "Executable responded successfully") });
        } catch (cause) {
          versionPassed = false;
          result.checks.push({ name: "executable", status: "failed", message: cause instanceof Error ? cause.message : "Executable metadata check failed" });
        }
      }
    }
    if (options.checkLogin) {
      const backend = execution.request.target.backend;
      if (backend.auth === "api-key" || backend.auth === "cursor-api-key") result.checks.push({ name: "login", status: "skipped", message: "API credentials are resolved only by run(); no provider request was made" });
      else if (["chatgpt", "claude-subscription", "claude-config", "cursor-login"].includes(backend.auth)) {
        if (!versionPassed) result.checks.push({ name: "login", status: "skipped", message: "Login check skipped after executable compatibility check failed" });
        else try {
          const verdict = loginVerdict(execution, await invoke("login"));
          result.checks.push({ name: "login", status: verdict.passed ? "passed" : "failed", message: verdict.message });
        } catch { result.checks.push({ name: "login", status: "failed", message: "Native login metadata check failed or exceeded its deadline" }); }
      } else result.checks.push({ name: "login", status: "unknown", message: "Extension login metadata is not implemented" });
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
  result.ok = !result.checks.some(c => c.status === "failed" || c.status === "unknown");
  return result;
}
