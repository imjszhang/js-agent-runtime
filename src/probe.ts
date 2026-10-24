import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { nativeCodexProviderConfig } from "./codex-native.js";
import { assertPlan, getAdapter } from "./plan.js";
import { baseEnvironment, runProcess } from "./process.js";
import { createRedactor } from "./redaction.js";
import { operationalEnvironment, prepareStateDirectories } from "./run.js";
import { integer, keys, record } from "./validation.js";
import type { ExecutionPlan, ProbeOptions, ProbeResult } from "./types.js";

/** No model requests. CLI version/login metadata commands require explicit opt-in. */
export async function probe(input: ExecutionPlan, options: ProbeOptions = {}): Promise<ProbeResult> {
  const execution = assertPlan(input);
  keys(record(options), ["checkExecutable", "checkLogin", "timeoutMs", "env", "signal"], "probe options");
  for (const flag of ["checkExecutable", "checkLogin"] as const) if (options[flag] !== undefined && typeof options[flag] !== "boolean") throw new Error(`${flag} must be boolean`);
  const timeoutMs = options.timeoutMs === undefined ? 10_000 : integer(options.timeoutMs, "probe timeoutMs", 1, 120_000);
  const result: ProbeResult = { schemaVersion: 1, adapter: execution.adapter.id, executable: execution.process.executable, checks: [], ok: true };
  if (!options.checkExecutable && !options.checkLogin) { result.checks.push({ name: "configuration", status: "passed", message: "Static configuration is valid; CLI/auth checks were not requested" }); return result; }
  const temporary = await mkdtemp(path.join(tmpdir(), "js-agent-runtime-probe-")), redactor = createRedactor();
  try {
    const probeEnv = Object.fromEntries(Object.entries(execution.process.env).map(([key, value]) => [key, value.startsWith(execution.stateDir) ? temporary + value.slice(execution.stateDir.length) : value]));
    const env = { ...baseEnvironment(), ...operationalEnvironment(options.env), ...probeEnv };
    await prepareStateDirectories(env, temporary);
    const invoke = (args: string[]) => runProcess({ ...execution.process, args, cwd: temporary, stdin: "", env }, { timeoutMs, maxOutputBytes: 32_768, terminationGraceMs: 200, signal: options.signal });
    if (options.checkExecutable) {
      const args = getAdapter(execution.adapter.id).probeArgs;
      if (!args) result.checks.push({ name: "executable", status: "unknown", message: "Adapter does not declare a metadata command" });
      else {
        const r = await invoke(args);
        const passed = r.exitCode === 0 && !r.error && !r.cancelled && !r.timedOut;
        result.checks.push({ name: "executable", status: passed ? "passed" : "failed", message: passed ? redactor.text(r.stdout.trim().slice(0, 256) || "Executable responded successfully") : "Executable metadata check failed" });
      }
    }
    if (options.checkLogin) {
      const backend = execution.request.target.backend;
      if (backend.auth === "api-key") result.checks.push({ name: "login", status: "skipped", message: "API credentials are resolved only by run(); no provider request was made" });
      else if (backend.auth === "chatgpt") {
        const provider = `js_agent_probe_${randomUUID().replaceAll("-", "")}`;
        const config: Record<string, unknown> = {
          ...nativeCodexProviderConfig(provider),
          cli_auth_credentials_store: "auto", sqlite_home: path.join(temporary, "state"), log_dir: path.join(temporary, "logs"),
          project_doc_max_bytes: 0, check_for_update_on_startup: false, "features.plugins": false,
          "features.apps": false, "features.hooks": false, "features.skip_host_skill_discovery": true,
          "features.skill_search": false, "features.skill_mcp_dependency_install": false, "analytics.enabled": false,
          "otel.log_user_prompt": false, "otel.exporter": "none", mcp_servers: {},
        };
        const r = await invoke(["--no-daemon", "login", "status", ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])]);
        const passed = r.exitCode === 0 && !r.error && /^Logged in using ChatGPT\s*$/mu.test(`${r.stdout}\n${r.stderr}`);
        result.checks.push({ name: "login", status: passed ? "passed" : "failed", message: passed ? "Native CLI reports ChatGPT login" : "Native CLI did not confirm ChatGPT login" });
      } else if (backend.auth === "claude-config") {
        // Let the CLI resolve its own settings/auth. Never parse settings or echo
        // identity metadata, and never equate its labels with an endpoint claim.
        const r = await invoke(["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "user", "--settings", '{"disableAllHooks":true}', "auth", "status", "--json"]);
        let passed = false;
        try {
          const data = JSON.parse(r.stdout) as Record<string, unknown>;
          const expected = typeof backend.claudeConfigDir === "string" ? backend.claudeConfigDir : path.join(homedir(), ".claude");
          passed = r.exitCode === 0 && !r.error && !r.cancelled && !r.timedOut && data.loggedIn === true &&
            (data.configDirectory === undefined || (typeof data.configDirectory === "string" && path.resolve(data.configDirectory) === path.resolve(expected)));
        } catch { /* Only an explicit CLI verdict is evidence. */ }
        result.checks.push({ name: "login", status: passed ? "passed" : "failed", message: passed ? "Local Claude CLI reports loggedIn=true using user settings; endpoint and model compatibility are not verified" : "Local Claude CLI did not confirm configured authentication" });
      } else if (backend.auth === "claude-subscription") {
        const r = await invoke(["--safe-mode", "--restricted", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "auth", "status", "--json"]);
        let passed = false;
        try { const data = JSON.parse(r.stdout) as Record<string, unknown>; const expected = typeof backend.claudeConfigDir === "string" ? backend.claudeConfigDir : path.join(homedir(), ".claude"); passed = r.exitCode === 0 && !r.error && data.loggedIn === true && data.authMethod === "claude.ai" && data.apiProvider === "firstParty" && typeof data.configDirectory === "string" && path.resolve(data.configDirectory) === path.resolve(expected); } catch { /* Metadata remains unknown, never expose its raw output. */ }
        result.checks.push({ name: "login", status: passed ? "passed" : "failed", message: passed ? "Native CLI reports Claude subscription login" : "Native CLI did not confirm Claude subscription login" });
      } else result.checks.push({ name: "login", status: "unknown", message: "Extension login metadata is not implemented" });
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
  result.ok = !result.checks.some(c => c.status === "failed" || c.status === "unknown");
  return result;
}
