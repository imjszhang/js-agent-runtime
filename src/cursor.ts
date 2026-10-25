import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createCursorParser } from "./cursor-parser.js";
import { planCursorShell } from "./cursor-shell.js";
import { cursorCommandPrefix, planCursorLauncher } from "./cursor-launcher.js";
import { planCursorRuntime } from "./cursor-runtime.js";
import { absolute, envName, keys, overlaps, record, text } from "./validation.js";
import type { Adapter, AdapterPlan, ProcessPlan, RunRequest, Target } from "./types.js";

/** Stream format reviewed against these builds. The stall preload remains bound to the first. */
export const CURSOR_AGENT_VERSIONS = ["2026.07.23-e383d2b", "2026.10.22-27dcf5f"] as const;
export const CURSOR_AGENT_VERSION = CURSOR_AGENT_VERSIONS[0];
export type CursorAuth = "cursor-login" | "cursor-api-key";
type CursorBackend = { auth: CursorAuth; model: string; apiKeyEnv?: string };
export type CursorAccountStatus = { auth: "cursor-login"; credentialPresent: boolean; verified: false };

export function validateCursorBackend(target: Target): CursorBackend {
  const backend = record(target.backend, "Cursor backend");
  if (target.harness.adapter !== "cursor-agent") throw new Error("Cursor authentication requires cursor-agent");
  if (backend.auth !== "cursor-login" && backend.auth !== "cursor-api-key") throw new Error("Cursor Agent requires cursor-login or cursor-api-key authentication");
  keys(backend, backend.auth === "cursor-login" ? ["auth", "model"] : ["auth", "model", "apiKeyEnv"], "Cursor backend");
  const model = text(backend.model, "backend.model");
  if (model === "configured") throw new Error("Cursor model configured is reserved for claude-config authentication");
  if (!["read-only", "workspace-write", "bypass"].includes(target.harness.permission)) throw new Error("Cursor Agent requires an explicit permission mode");
  if (target.harness.contextMode === "project") throw new Error("Cursor Agent does not support project context");
  if (backend.apiKeyEnv !== undefined) envName(backend.apiKeyEnv, "backend.apiKeyEnv");
  return { auth: backend.auth, model, ...(typeof backend.apiKeyEnv === "string" ? { apiKeyEnv: backend.apiKeyEnv } : {}) };
}

export function cursorCommonArgs(): string[] {
  return ["--disable-auto-update", "--disable-project-configs", "--endpoint", "https://api2.cursor.sh"];
}

/** Returns references and state locations only; never reads native credentials. */
export function cursorEnvironment(stateDir: string, auth: CursorAuth, useCurrentUserHomeForLogin = false): Record<string, string> {
  const home = absolute(stateDir, "Cursor stateDir");
  if (auth !== "cursor-login" && auth !== "cursor-api-key") throw new Error("Unsupported Cursor authentication mode");
  if (auth === "cursor-login" && process.platform !== "darwin" && process.platform !== "win32") throw new Error("Cursor native login requires macOS Keychain or Windows user credentials; use cursor-api-key on other POSIX platforms");
  if (auth === "cursor-login" && process.platform === "win32" && !useCurrentUserHomeForLogin) throw new Error("Cursor native login on Windows requires harness.useCurrentUserHomeForLogin; the runtime does not copy the user credential file");
  const realHome = auth === "cursor-login" && useCurrentUserHomeForLogin;
  return {
    HOME: realHome ? homedir() : home,
    USERPROFILE: realHome ? homedir() : home,
    ...(realHome && process.platform === "win32" ? { APPDATA: process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming") } : {}),
    CURSOR_CONFIG_DIR: path.join(home, ".cursor"), CURSOR_DATA_DIR: path.join(home, ".cursor-data"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"),
    NODE_COMPILE_CACHE: path.join(home, ".cache", "cursor-compile-cache"),
    AGENT_CLI_CREDENTIAL_STORE: auth === "cursor-login" ? "default" : "memory",
    CURSOR_AGENT_DISABLE_DEBUG_LOG: "1", DIRENV_DISABLE: "1", NO_OPEN_BROWSER: "1", NO_COLOR: "1", NODE_USE_ENV_PROXY: "1", CI: "1",
  };
}

export function assertCursorAgentVersion(version: string): void {
  const trimmed = version.trim();
  if (!(CURSOR_AGENT_VERSIONS as readonly string[]).includes(trimmed)) throw new Error(`Cursor Agent requires a reviewed version (${CURSOR_AGENT_VERSIONS.join(", ")})`);
}

/** Never return native identity, token values, or raw authentication diagnostics. */
export function parseCursorAccountStatus(stdout: string): CursorAccountStatus {
  let value: Record<string, unknown>;
  try { value = record(JSON.parse(stdout), "Cursor status"); } catch { throw new Error("Cursor Agent returned invalid login metadata"); }
  if (typeof value.isAuthenticated !== "boolean" || typeof value.hasAccessToken !== "boolean" || typeof value.hasRefreshToken !== "boolean") throw new Error("Cursor Agent returned invalid login metadata");
  const authenticated = value.status === "authenticated" && value.isAuthenticated && value.hasAccessToken && value.hasRefreshToken;
  const partial = value.status === "partially-authenticated" && !value.isAuthenticated && value.hasAccessToken && !value.hasRefreshToken;
  const absent = value.status === "unauthenticated" && !value.isAuthenticated && !value.hasAccessToken && !value.hasRefreshToken;
  if (!authenticated && !partial && !absent) throw new Error("Cursor Agent returned inconsistent login metadata");
  return { auth: "cursor-login", credentialPresent: authenticated, verified: false };
}

/** Probes use the original CLI with isolated HOME and no preload or credential. */
export function cursorVersionProcess(request: RunRequest, stateDir: string): ProcessPlan {
  return { executable: request.target.harness.executable, args: [...cursorCommandPrefix(request.target.harness.executable), ...cursorCommonArgs(), "--version"], cwd: stateDir, stdin: "", env: cursorEnvironment(stateDir, "cursor-api-key") };
}

export function cursorLoginProcess(request: RunRequest, stateDir: string): ProcessPlan {
  const backend = validateCursorBackend(request.target);
  if (backend.auth !== "cursor-login") throw new Error("Cursor login metadata requires cursor-login authentication");
  return { executable: request.target.harness.executable, args: [...cursorCommandPrefix(request.target.harness.executable), ...cursorCommonArgs(), "status", "--format", "json"], cwd: stateDir, stdin: "", env: cursorEnvironment(stateDir, backend.auth, request.target.harness.useCurrentUserHomeForLogin) };
}

function named(filePath: string, base: string): boolean {
  return path.basename(filePath) === base;
}

/** Project hooks load separately from CLI permissions; never delete user input. */
export async function assertCursorWorkspace(workspace: string): Promise<void> {
  try { await lstat(path.join(workspace, ".cursor")); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return; throw cause; }
  throw new Error("Cursor workspace must not contain a .cursor file or directory");
}

export function planCursor(request: RunRequest, stateDir: string): AdapterPlan {
  const backend = validateCursorBackend(request.target), home = path.resolve(stateDir), workspace = request.workspace;
  if (overlaps(home, workspace)) throw new Error("Cursor Agent stateDir must not overlap workspace");
  if (/[\u0000-\u001f\u007f*?()\[\]{}]/u.test(home + workspace)) throw new Error("Cursor Agent paths contain unsupported permission pattern characters");
  const bypass = request.target.harness.permission === "bypass", writable = request.target.harness.permission !== "read-only";
  const shell = planCursorShell(home), launcher = planCursorLauncher(home, request.target.harness.executable);
  const runtime = request.target.harness.nativeStallTimeoutMs === undefined ? undefined : planCursorRuntime(home, request.target.harness.nativeStallTimeoutMs);
  const tools = ["glob_tool_call", "grep_tool_call", "read_tool_call", "ls_tool_call", ...(writable ? ["shell_tool_call", "delete_tool_call", "edit_tool_call", "write_shell_stdin_tool_call"] : [])];
  const plan: AdapterPlan = {
    files: [
      { path: path.join(home, ".cursor", "cli-config.json"), content: JSON.stringify({
        version: 1, editor: { vimMode: false },
        ...(request.target.harness.useHttp1ForAgent === undefined ? {} : { network: { useHttp1ForAgent: request.target.harness.useHttp1ForAgent } }),
        approvalMode: "allowlist",
        permissions: {
          // Shell(*) makes the pinned native CLI select insecure_none. Let its
          // sandbox preapprove only commands within the declared policy.
          allow: [`Read(${workspace}/**)`, ...(writable ? [`Write(${workspace}/**)`] : [])],
          deny: [`Read(${home}/**)`, `Write(${home}/**)`, `Write(${workspace}/.cursor/**)`, "Mcp(*:*)", "WebFetch(*)"],
        }, sandbox: { mode: "enabled", networkAccess: "user_config_only" },
      }, null, 2) + "\n" },
      { path: path.join(home, ".cursor", "sandbox.json"), content: JSON.stringify({
        type: writable ? "workspace_readwrite" : "workspace_readonly", additionalReadonlyPaths: [path.join(home, "cursor-shell")],
        networkPolicy: { default: "deny", allow: [], deny: [] }, networkPolicyStrict: true,
      }, null, 2) + "\n" },
      ...shell.files, ...launcher.files, ...(runtime?.files ?? []),
      ...(runtime ? [{ path: path.join(home, "cursor-runtime", "compatibility.json"), content: JSON.stringify(runtime.compatibility, null, 2) + "\n" }] : []),
    ],
    process: {
      executable: launcher.executable,
      args: [...launcher.args, ...cursorCommonArgs(), "-p", "--output-format", "stream-json", "--model", backend.model, "--sandbox", "enabled", "--trust", "--disable-indexing", "--disable-codebase-ref", "--allowed-tools", tools.join(","), ...(writable ? [] : ["--mode", "ask"])],
      cwd: workspace, stdin: request.prompt,
      env: { ...cursorEnvironment(home, backend.auth, request.target.harness.useCurrentUserHomeForLogin), ...shell.env, ...runtime?.env, GIT_CEILING_DIRECTORIES: workspace },
    },
    ...(backend.auth === "cursor-api-key" ? { credential: { ref: backend.apiKeyEnv ?? "CURSOR_API_KEY", envVar: "CURSOR_API_KEY" } } : {}),
  };
  if (bypass) {
    const args = plan.process.args;
    args[args.indexOf("--sandbox") + 1] = "disabled";
    args.splice(args.indexOf("--allowed-tools"), 2);
    args.push("--force");
    plan.process.env.PATH = process.env.PATH ?? (process.platform === "win32" ? "" : "/usr/bin:/bin");
    plan.process.env.SHELL = process.platform === "win32"
      ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "/bin/bash";
    for (const file of plan.files) {
      if (named(file.path, "cli-config.json")) {
        const config = record(JSON.parse(file.content));
        config.permissions = { allow: ["Read(*)", "Write(*)", "Shell(*)", "WebFetch(*)"], deny: ["Mcp(*:*)"] };
        config.sandbox = { mode: "disabled" };
        file.content = JSON.stringify(config, null, 2) + "\n";
      }
      if (named(file.path, "sandbox.json")) file.content = JSON.stringify({ type: "insecure_none", networkPolicy: { default: "allow", allow: [], deny: [] } }) + "\n";
    }
  }
  return plan;
}

export const cursorAdapter: Adapter = {
  id: "cursor-agent", version: "2", validate: target => { validateCursorBackend(target); },
  plan: (request, context) => planCursor(request, context.stateDir), createParser: createCursorParser,
  probeArgs: [...cursorCommonArgs(), "--version"],
};
