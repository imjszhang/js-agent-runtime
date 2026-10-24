import path from "node:path";
import { validateBackend } from "./validation.js";
import { createOpenCodeParser } from "./opencode-parser.js";
import type { Adapter, AdapterPlan, ProcessPlan, RunRequest } from "./types.js";

export { parseOpenCodeInspection } from "./opencode-parser.js";

const KEY_ENV = "JS_AGENT_RUNTIME_API_KEY";
export const OPENCODE_PROVIDER = "js_agent_runtime";

/** V2 merges the invocation overlay into its environment: unset with tombstones. */
const SHELL_ENV_PLUGIN = `export default {
  id: "js-agent-runtime.shell-environment",
  setup: async (ctx) => {
    await ctx.shell.hook("create.before", (invocation) => {
      for (const name of Object.keys(invocation.env)) {
        if (/KEY|TOKEN|SECRET|PASSWORD|AUTH|OPENCODE_CONFIG_CONTENT/i.test(name)) invocation.env[name] = undefined;
      }
    });
  },
};
`;

/** The supported wire format and plugin contract are @opencode/cli V2. */
function opencodePlan(request: RunRequest, stateDir: string): AdapterPlan {
  const backend = validateBackend(request.target);
  if (backend.auth !== "api-key") throw new Error("OpenCode requires api-key authentication");
  if (backend.protocol !== "chat-completions") throw new Error("OpenCode requires a chat-completions backend");
  if (request.target.harness.contextMode === "project") throw new Error("OpenCode does not support project context");
  if (request.target.harness.permission === "bypass") throw new Error("OpenCode does not support bypass permission");
  const home = path.join(stateDir, "opencode"), configDir = path.join(home, "config"), pluginDir = path.join(home, "shell-environment");
  const permissions = [
    { action: "*", resource: "*", effect: "deny" },
    ...["read", "glob", "grep", ...(request.target.harness.permission === "workspace-write" ? ["edit", "shell"] : [])]
      .map(action => ({ action, resource: "*", effect: "allow" })),
    { action: "external_directory", resource: "*", effect: "deny" },
  ];
  const model = `${OPENCODE_PROVIDER}/${backend.model}`;
  const config = {
    model, default_agent: "build", update: "disable", share: "disabled", snapshots: false, formatter: false, lsp: false, warming: false,
    mcp: { servers: {} }, instructions: [], skills: [], permissions,
    agents: { build: { permissions }, title: { disabled: true }, summary: { disabled: true } },
    policies: [
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: OPENCODE_PROVIDER, effect: "allow" },
      { action: "integration.use", resource: "mcp:*", effect: "deny" },
      { action: "integration.use", resource: "skill:*", effect: "deny" },
      { action: "integration.use", resource: "plugin:*", effect: "deny" },
      { action: "integration.use", resource: `plugin:${pluginDir}`, effect: "allow" },
    ],
    plugins: ["-opencode.config.instruction", "-opencode.config.skill", "-opencode.config.compatibility", "-opencode.skill", pluginDir],
    providers: {
      [OPENCODE_PROVIDER]: {
        name: "js-agent-runtime isolated backend", env: [KEY_ENV], package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: backend.baseURL.replace(/\/+$/u, ""), timeout: request.timeoutMs },
        models: { [backend.model]: { name: backend.model, capabilities: { tools: true } } },
      },
    },
  };
  return {
    files: [
      { path: path.join(configDir, "opencode.json"), content: JSON.stringify(config, null, 2) + "\n" },
      { path: path.join(pluginDir, "package.json"), content: JSON.stringify({ name: "js-agent-runtime-shell-environment", private: true, type: "module", exports: "./index.mjs" }, null, 2) + "\n" },
      { path: path.join(pluginDir, "index.mjs"), content: SHELL_ENV_PLUGIN },
    ],
    process: {
      executable: request.target.harness.executable,
      args: ["run", "--standalone", "--format", "json", "--thinking", "--model", model, "--agent", "build"],
      cwd: request.workspace, stdin: request.prompt,
      env: {
        HOME: home, USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
        XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"),
        GIT_CEILING_DIRECTORIES: request.workspace, PWD: request.workspace, NO_COLOR: "1",
        OPENCODE_CONFIG_DIR: configDir, OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_PRUNE: "1",
        OPENCODE_FILEWATCHER_DISABLE: "1", OPENCODE_DISABLE_FFF: "1", DO_NOT_TRACK: "1", DISABLE_TELEMETRY: "1",
      },
    },
    credential: { ref: backend.apiKeyEnv, envVar: KEY_ENV },
  };
}

/** Reads the current isolated session without a provider credential. */
export function planOpenCodeInspection(request: RunRequest, stateDir: string, sessionId: string): ProcessPlan {
  if (!/^ses_[A-Za-z0-9]+$/u.test(sessionId)) throw new Error("Invalid OpenCode session ID for inspection");
  return { ...opencodePlan(request, stateDir).process, args: ["session", "export", "--standalone", sessionId], stdin: "" };
}

export const opencodeAdapter: Adapter = {
  id: "opencode", version: "1", validate: target => { validateBackend(target); },
  plan: (request, context) => opencodePlan(request, context.stateDir), createParser: createOpenCodeParser, probeArgs: ["--version"],
};
