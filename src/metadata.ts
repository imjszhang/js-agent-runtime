import path from "node:path";
import { homedir } from "node:os";
import { nativeCodexProviderConfig } from "./codex-native.js";
import { assertCursorAgentVersion, cursorVersionProcess, cursorLoginProcess, parseCursorAccountStatus } from "./cursor.js";
import type { ExecutionPlan, ProcessPlan } from "./types.js";
import type { ProcessResult } from "./process.js";

export const builtInIds = new Set(["codex", "claude-code", "deepseek-harness", "opencode", "cursor-agent"]);

/** Metadata never receives a provider credential or a tool-shell preload. */
export function metadataProcess(execution: ExecutionPlan, stateDir: string, kind: "version" | "login", args?: string[]): ProcessPlan {
  const { request } = execution, backend = request.target.backend;
  if (execution.adapter.id === "cursor-agent") {
    const command = kind === "version" ? cursorVersionProcess(request, stateDir) : cursorLoginProcess(request, stateDir);
    // Match the executable selected by the frozen launch PATH, without routing
    // the native /usr/bin/env bash launcher through the tool-shell wrapper.
    const launchPath = execution.process.env.PATH;
    if (launchPath !== undefined) command.env.PATH = launchPath.split(path.delimiter)
      .filter(entry => entry !== path.join(execution.stateDir, "cursor-shell", "bin")).join(path.delimiter);
    return command;
  }
  const env = Object.fromEntries(Object.entries(execution.process.env).map(([key, value]) =>
    [key, value === execution.stateDir || value.startsWith(`${execution.stateDir}${path.sep}`) ? stateDir + value.slice(execution.stateDir.length) : value]));
  for (const key of ["SHELL", "ZDOTDIR", "BASH_ENV", "ENV", "NODE_OPTIONS", "CLAUDE_CODE_SHELL", "CLAUDE_CODE_SHELL_PREFIX", "CLAUDE_ENV_FILE"]) delete env[key];
  if (execution.credential) delete env[execution.credential.envVar];
  if (kind === "version") {
    env.HOME = stateDir; env.USERPROFILE = stateDir;
    if (execution.adapter.id === "codex") env.CODEX_HOME = path.join(stateDir, "codex-version");
    if (execution.adapter.id === "claude-code") env.CLAUDE_CONFIG_DIR = path.join(stateDir, "claude-version");
  }
  let command = args ?? ["--version"];
  if (kind === "login" && backend.auth === "chatgpt") {
    const config = {
      ...nativeCodexProviderConfig("js_agent_runtime_metadata"),
      cli_auth_credentials_store: backend.credentialsStore ?? "auto",
      sqlite_home: path.join(stateDir, "state"), log_dir: path.join(stateDir, "logs"),
      project_doc_max_bytes: 0, check_for_update_on_startup: false, "features.plugins": false,
      "features.apps": false, "features.hooks": false, "features.skip_host_skill_discovery": true,
      "features.skill_search": false, "features.skill_mcp_dependency_install": false, "analytics.enabled": false,
      "otel.log_user_prompt": false, "otel.exporter": "none", mcp_servers: {},
    };
    command = ["--no-daemon", "login", "status", ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])];
  } else if (kind === "login" && (backend.auth === "claude-subscription" || backend.auth === "claude-config")) {
    command = [...(backend.auth === "claude-config" ? [] : ["--safe-mode", "--restricted"]),
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", backend.auth === "claude-config" ? "user" : "",
      "--settings", '{"disableAllHooks":true}', "auth", "status", "--json"];
  }
  return { executable: execution.process.executable, args: command, cwd: stateDir, stdin: "", env };
}

export function processSucceeded(result: ProcessResult): boolean {
  return result.exitCode === 0 && result.signal === null && !result.error && !result.cancelled && !result.timedOut;
}
export function assertCompatibleVersion(execution: ExecutionPlan, version: string): void {
  if (execution.adapter.id === "cursor-agent") assertCursorAgentVersion(version);
  if (execution.adapter.id === "opencode" && !/(?:^|\s)v?2\.\d+\.\d+(?:[-+][\w.-]+)?(?:\s|$)/u.test(version))
    throw new Error("OpenCode requires @opencode/cli V2 (verified against 2.0.32)");
  if (execution.request.target.backend.auth === "claude-subscription") {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(version.trim());
    const [major, minor, patch] = match ? match.slice(1).map(Number) : [0, 0, 0];
    if (!(major! > 2 || (major === 2 && (minor! > 1 || (minor === 1 && patch! >= 296)))))
      throw new Error("Claude subscription requires Claude Code 2.1.296 or newer");
  }
}

/** Only verdicts leave this module; identity and native diagnostics remain private. */
export function loginVerdict(execution: ExecutionPlan, result: ProcessResult): { passed: boolean; message: string } {
  const backend = execution.request.target.backend;
  let passed = false;
  if (processSucceeded(result)) try {
    if (backend.auth === "chatgpt") passed = /^Logged in using ChatGPT\s*$/mu.test(`${result.stdout}\n${result.stderr}`);
    else if (backend.auth === "cursor-login") passed = parseCursorAccountStatus(result.stdout).credentialPresent;
    else if (backend.auth === "claude-config" || backend.auth === "claude-subscription") {
      const data = JSON.parse(result.stdout) as Record<string, unknown>;
      const expected = typeof backend.claudeConfigDir === "string" ? backend.claudeConfigDir : path.join(homedir(), ".claude");
      const directoryMatches = typeof data.configDirectory === "string" && path.resolve(data.configDirectory) === path.resolve(expected);
      passed = data.loggedIn === true && (backend.auth === "claude-config"
        ? data.configDirectory === undefined || directoryMatches
        : data.authMethod === "claude.ai" && data.apiProvider === "firstParty" && directoryMatches);
    }
  } catch { /* An explicit, structurally valid native verdict is required. */ }
  const message = backend.auth === "cursor-login"
    ? passed ? "Native Cursor reports complete login credentials; subscription and remote access are not verified" : "Native Cursor did not confirm complete login credentials"
    : backend.auth === "claude-config"
      ? passed ? "Local Claude CLI reports loggedIn=true using user settings; endpoint and model compatibility are not verified" : "Local Claude CLI did not confirm configured authentication"
      : backend.auth === "chatgpt"
        ? passed ? "Native CLI reports ChatGPT login" : "Native CLI did not confirm ChatGPT login"
        : passed ? "Native CLI reports Claude subscription login" : "Native CLI did not confirm Claude subscription login";
  return { passed, message };
}
