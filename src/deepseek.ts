import path from "node:path";
import { validateBackend } from "./validation.js";
import { createDeepseekParser } from "./deepseek-parser.js";
import type { Adapter, AdapterPlan, RunRequest } from "./types.js";

/** DSH's native Messages route, with caller-owned provider and credential selection. */
function deepseekPlan(request: RunRequest, state: string): AdapterPlan {
  const backend = validateBackend(request.target);
  if (backend.auth !== "api-key") throw new Error("DeepSeek Harness requires api-key authentication");
  const home = path.join(state, "dsh"), profile = path.join(home, "profiles", "headless");
  const patchPath = path.join(home, "runtime.patch.yml");
  const project = request.target.harness.contextMode === "project";
  const mode = request.target.harness.permission === "bypass" ? "danger-full-access" : request.target.harness.permission;
  const patches: Array<Record<string, unknown>> = [
    { id: "llm-deepseek", config: { baseURL: backend.baseURL.replace(/\/+$/u, ""), apiKeyEnv: "JS_AGENT_RUNTIME_API_KEY", models: [{ id: backend.model }] } },
    // Internal DSH registry identity is not the caller's provider name.
    { id: "agent-default-model", config: { provider: "deepseek-official", model: backend.model } },
    { id: "sandbox-policy", config: { mode, workspaceRoot: request.workspace } },
    { id: "approval", config: { policy: "never" } },
    { id: "permission", config: { presets: { [mode]: { sandbox: mode, approval: "never" } }, defaultPreset: mode } },
    { id: "session-persistence-jsonl", config: { root: path.join(home, "sessions"), compression: "none" } },
    { id: "skill-filesystem", config: { includeDefaultRoots: false, customSkillDirs: [path.join(request.workspace, ".agents", "skills")], watch: false } },
    project ? { id: "agent-instructions", config: { dshHome: home, projectRootMarkers: [], maxBytes: 65536,
      instructionFileCandidates: ["AGENTS.md", "CLAUDE.md"], localInstructionFileCandidates: ["AGENTS.local.md", "CLAUDE.local.md"] } }
      : { id: "agent-instructions", disabled: true },
  ];
  // Retain native file/shell/skill tools, but no alternate model routes, personal
  // profiles, plugin installation, telemetry or delegated usage outside this run.
  for (const id of [
    "hmr", "plugin-manager", "tool-plugin-manager", "config-editor", "settings",
    "credentials", "authorization", "deepseek-account", "llm-deepseek-account", "llm-pi-ai",
    "session-title-llm", "otel", "session-telemetry-otel",
    "web", "web-search-deepseek", "web-fetch-http", "tool-web", "mcp-resources",
    "tool-subagent", "tool-subagent-fork", "tool-subagent-control", "tool-subagent-list-agents", "tool-workflow", "workflow-ptc", "ptc-runtime",
  ]) patches.push({ id, disabled: true });
  if (request.target.harness.permission === "read-only") patches.push({ id: "tool-bash", disabled: true }, { id: "tool-pwsh", disabled: true });
  return {
    files: [
      { path: path.join(profile, "package.json"), content: JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } } }, null, 2) + "\n" },
      { path: path.join(profile, "cordis.yml"), content: "[]\n" },
      { path: path.join(profile, "cordis.patch.yml"), content: "[]\n" },
      { path: patchPath, content: JSON.stringify(patches, null, 2) + "\n" },
    ],
    process: {
      executable: request.target.harness.executable, args: ["--profile", "headless", "--patch", patchPath, "--json", "-"],
      cwd: request.workspace, stdin: request.prompt,
      env: { HOME: state, USERPROFILE: state, DSH_HOME: home, AGENTS_HOME: path.join(state, "agents"),
        XDG_CONFIG_HOME: path.join(state, ".config"), XDG_CACHE_HOME: path.join(state, ".cache"),
        XDG_DATA_HOME: path.join(state, ".local", "share"), XDG_STATE_HOME: path.join(state, ".local", "state"),
        GIT_CEILING_DIRECTORIES: request.workspace, DSH_PERMISSION_MODE: mode, DSH_TELEMETRY_DISABLED: "1", OTEL_SDK_DISABLED: "true", NO_COLOR: "1" },
    },
    credential: { ref: backend.apiKeyEnv, envVar: "JS_AGENT_RUNTIME_API_KEY" },
  };
}

export const deepseekAdapter: Adapter = {
  id: "deepseek-harness", version: "1", validate: target => { validateBackend(target); },
  plan: (request, context) => deepseekPlan(request, context.stateDir),
  createParser: createDeepseekParser, probeArgs: ["--version"],
};
