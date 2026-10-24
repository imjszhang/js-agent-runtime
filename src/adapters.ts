import path from "node:path";
import { homedir } from "node:os";
import { createParser } from "./parsers.js";
import { nativeCodexProviderConfig } from "./codex-native.js";
import { deepseekAdapter } from "./deepseek.js";
import { overlaps, validateBackend } from "./validation.js";
import type { Adapter, AdapterPlan, RunRequest } from "./types.js";

function environment(state: string): Record<string, string> {
  return { HOME: state, USERPROFILE: state, XDG_CONFIG_HOME: path.join(state, ".config"), XDG_CACHE_HOME: path.join(state, ".cache"), XDG_DATA_HOME: path.join(state, ".local/share"), XDG_STATE_HOME: path.join(state, ".local/state"), NO_COLOR: "1" };
}
function codexPlan(request: RunRequest, stateDir: string): AdapterPlan {
  const b = validateBackend(request.target), subscription = b.auth === "chatgpt";
  if (b.auth !== "api-key" && b.auth !== "chatgpt") throw new Error("Invalid Codex authentication");
  const authDir = b.auth === "chatgpt" ? b.codexHome ?? path.join(homedir(), ".codex") : path.join(stateDir, "codex");
  if (subscription && (overlaps(authDir, request.workspace) || overlaps(authDir, stateDir))) throw new Error("Codex authentication directory must not overlap workspace or temporary state");
  const env = { ...environment(stateDir), CODEX_HOME: authDir, GIT_CEILING_DIRECTORIES: request.workspace };
  const config: Record<string, unknown> = {
    approval_policy: "never", cli_auth_credentials_store: subscription ? "auto" : "file",
    "shell_environment_policy.inherit": "core", "shell_environment_policy.ignore_default_excludes": false,
    "shell_environment_policy.exclude": ["*KEY*", "*TOKEN*", "*SECRET*", "*PASSWORD*", "CODEX_HOME"],
    project_doc_max_bytes: 0, project_root_markers: [], check_for_update_on_startup: false, "features.plugins": false, "features.hooks": false,
    "features.apps": false, "features.memories": false, "features.skip_host_skill_discovery": true,
    "features.skill_search": false, "features.skill_mcp_dependency_install": false,
    "agents.enabled": false, "analytics.enabled": false, "feedback.enabled": false,
    "history.persistence": "none", web_search: "disabled", mcp_servers: {},
    sqlite_home: path.join(stateDir, "codex-state"), log_dir: path.join(stateDir, "codex-logs"),
    [`projects.${JSON.stringify(request.workspace)}.trust_level`]: "untrusted",
  };
  if (b.auth === "chatgpt") {
    Object.assign(config, nativeCodexProviderConfig("js_agent_runtime_chatgpt"), {
      default_permissions: "js_agent_runtime",
      "permissions.js_agent_runtime.extends": request.target.harness.permission === "workspace-write" ? ":workspace" : ":read-only",
    });
  } else Object.assign(config, {
    model_provider: "js_agent_runtime", "model_providers.js_agent_runtime.name": "js-agent-runtime",
    "model_providers.js_agent_runtime.base_url": b.baseURL.replace(/\/+$/u, ""),
    "model_providers.js_agent_runtime.env_key": "JS_AGENT_RUNTIME_API_KEY",
    "model_providers.js_agent_runtime.wire_api": "responses", "model_providers.js_agent_runtime.requires_openai_auth": false,
  });
  if (b.reasoningEffort !== undefined) config.model_reasoning_effort = b.reasoningEffort;
  const args = ["--no-daemon", "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", ...(subscription ? [] : ["--sandbox", request.target.harness.permission]), "--model", b.model];
  for (const [key, value] of Object.entries(config)) args.push("-c", `${key}=${JSON.stringify(value)}`);
  if (subscription) args.push("-c", `permissions.js_agent_runtime.filesystem={ ${JSON.stringify(authDir)} = "deny" }`);
  args.push("-");
  return { files: [], process: { executable: request.target.harness.executable, args, cwd: request.workspace, stdin: request.prompt, env }, ...(b.auth === "api-key" ? { credential: { ref: b.apiKeyEnv, envVar: "JS_AGENT_RUNTIME_API_KEY" } } : {}) };
}
function claudePlan(request: RunRequest, stateDir: string): AdapterPlan {
  const b = validateBackend(request.target), configured = b.auth === "claude-config", native = b.auth === "claude-subscription" || configured;
  if (b.auth !== "api-key" && b.auth !== "claude-subscription" && b.auth !== "claude-config") throw new Error("Invalid Claude authentication");
  const bypass = request.target.harness.permission === "bypass";
  const projectContext = request.target.harness.contextMode === "project";
  const authDir = b.auth !== "api-key" ? b.claudeConfigDir ?? path.join(homedir(), ".claude") : path.join(stateDir, "claude");
  if (native && (overlaps(authDir, request.workspace) || overlaps(authDir, stateDir))) throw new Error("Claude authentication directory must not overlap workspace or temporary state");
  const env: Record<string, string> = {
    ...environment(stateDir), GIT_CEILING_DIRECTORIES: request.workspace, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
    // Claude 2.1.296 forces permissionMode=default when scrub=1, even with
    // explicit allowedTools. The opt-in native-config bypass must remain bypass.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: configured && bypass ? "0" : "1",
    CLAUDE_CODE_TMPDIR: path.join(stateDir, "tmp"), CLAUDE_CODE_DEBUG_LOGS_DIR: path.join(stateDir, "claude-debug.log"),
    ...(configured ? {} : { ANTHROPIC_BASE_URL: b.auth === "api-key" ? b.baseURL.replace(/\/+$/u, "").replace(/\/v1$/u, "") : "https://api.anthropic.com" }),
  };
  // Explicitly setting the default directory changes native macOS Keychain identity.
  if (configured || (b.auth === "claude-subscription" && b.claudeConfigDir === undefined)) { env.HOME = homedir(); env.USERPROFILE = homedir(); }
  if (b.auth === "api-key" || b.claudeConfigDir !== undefined) env.CLAUDE_CONFIG_DIR = authDir;
  const tools = (request.target.harness.permission !== "read-only" ? "Read,Glob,Grep,Edit,Write,Bash" : "Read,Glob,Grep") + (projectContext ? ",Skill" : "");
  const settingsPath = path.join(stateDir, "settings.json");
  const protectedPaths = native ? [authDir, path.join(path.dirname(authDir), ".claude.json"), path.join(homedir(), "Library/Keychains")] : [];
  const settings = {
    disableAllHooks: true,
    permissions: bypass ? { defaultMode: "bypassPermissions" } : { defaultMode: "dontAsk", blockReadsOutsideWorkingDirectories: true },
    ...(bypass ? { sandbox: { enabled: false } } : request.target.harness.permission === "workspace-write" ? { sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false, excludedCommands: [],
      filesystem: { denyRead: protectedPaths, denyWrite: [...protectedPaths, settingsPath] },
      credentials: { envVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"].map(name => ({ name, mode: "deny" })) },
    } } : {}),
  };
  return {
    files: [{ path: settingsPath, content: JSON.stringify(settings, null, 2) + "\n", mode: 0o600 }],
    process: { executable: request.target.harness.executable,
      args: ["-p", "--output-format", "stream-json", "--verbose", ...(native ? [] : ["--bare"]),
        ...(configured || bypass ? [] : ["--safe-mode", "--restricted"]), ...(projectContext ? [] : ["--disable-slash-commands"]), "--no-chrome", "--no-session-persistence",
        "--permission-mode", bypass ? "bypassPermissions" : "dontAsk", "--permission-prompts", "none", "--tools", tools, "--allowedTools", tools,
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", settingsPath, "--setting-sources", projectContext ? "user,project,local" : configured ? "user" : "",
        ...(configured && b.model === "configured" ? [] : ["--model", b.model])],
      cwd: request.workspace, stdin: request.prompt, env },
    ...(b.auth === "api-key" ? { credential: { ref: b.apiKeyEnv, envVar: "ANTHROPIC_API_KEY" } } : {}),
  };
}
export const builtInAdapters: Adapter[] = [
  deepseekAdapter,
  { id: "codex", version: "2", validate: target => { validateBackend(target); }, plan: (request, c) => codexPlan(request, c.stateDir), createParser: () => createParser("codex"), probeArgs: ["--version"] },
  { id: "claude-code", version: "2", validate: target => { validateBackend(target); }, plan: (request, c) => claudePlan(request, c.stateDir), createParser: () => createParser("claude-code"), probeArgs: ["--version"] },
];
