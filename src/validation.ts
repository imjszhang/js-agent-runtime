import path from "node:path";
import type { Backend, RunRequest, Target } from "./types.js";

export function record(value: unknown, label = "value"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}
export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} must be a non-empty single-line string`);
  return value;
}
export function name(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(result) || result.includes("..")) throw new Error(`${label} must be a safe identifier`);
  return result;
}
export function absolute(value: unknown, label: string): string {
  const result = text(value, label);
  if (!path.isAbsolute(result)) throw new Error(`${label} must be absolute`);
  return path.resolve(result);
}
export function integer(value: unknown, label: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
  return value;
}
export function envName(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(result)) throw new Error(`${label} must be an environment variable name`);
  return result;
}
export function overlaps(a: string, b: string): boolean {
  const inside = (parent: string, child: string): boolean => { const r = path.relative(parent, child); return r === "" || (!r.startsWith(`..${path.sep}`) && r !== ".." && !path.isAbsolute(r)); };
  return inside(a, b) || inside(b, a);
}
export function validateTarget(value: unknown): Target {
  const raw = record(value, "target"); keys(raw, ["name", "harness", "backend"], "target");
  const h = record(raw.harness, "harness"); keys(h, ["adapter", "executable", "permission", "contextMode", "useHttp1ForAgent", "nativeStallTimeoutMs", "useCurrentUserHomeForLogin"], "harness");
  if (h.permission !== "read-only" && h.permission !== "workspace-write" && h.permission !== "bypass") throw new Error("harness.permission must be read-only, workspace-write or bypass");
  if (h.permission === "bypass" && h.adapter !== "claude-code" && h.adapter !== "deepseek-harness" && h.adapter !== "cursor-agent") throw new Error("bypass permission is only supported by Claude Code, DeepSeek Harness or Cursor Agent");
  if (h.contextMode !== undefined && (typeof h.contextMode !== "string" || !["snapshot", "project"].includes(h.contextMode))) throw new Error("Invalid harness.contextMode");
  if (h.contextMode === "project" && h.adapter !== "claude-code" && h.adapter !== "deepseek-harness") throw new Error("project context requires Claude Code or DeepSeek Harness");
  for (const key of ["useHttp1ForAgent", "nativeStallTimeoutMs", "useCurrentUserHomeForLogin"] as const) {
    if (h[key] === undefined) continue;
    if (h.adapter !== "cursor-agent") throw new Error(`harness.${key} requires Cursor Agent`);
    if (key === "nativeStallTimeoutMs") integer(h[key], `harness.${key}`, 30_000, 300_000);
    else if (typeof h[key] !== "boolean") throw new Error(`harness.${key} must be boolean`);
  }
  return { name: name(raw.name, "target.name"), harness: { ...h, adapter: name(h.adapter, "harness.adapter"), executable: text(h.executable, "harness.executable"), permission: h.permission } as Target["harness"], backend: structuredClone(record(raw.backend, "backend")) as Target["backend"] };
}
export function validateBackend(target: Target): Backend {
  const raw = record(target.backend, "backend");
  const deepseek = target.harness.adapter === "deepseek-harness";
  if (deepseek && raw.auth !== "api-key") throw new Error("DeepSeek Harness requires api-key authentication");
  if (target.harness.adapter === "opencode" && raw.auth !== "api-key") throw new Error("OpenCode requires api-key authentication");
  if (target.harness.adapter === "cursor-agent" && raw.auth !== "cursor-login" && raw.auth !== "cursor-api-key") throw new Error("Cursor Agent requires native cursor-login or cursor-api-key authentication");
  if (target.harness.contextMode === "project" && !deepseek && raw.auth !== "claude-config") throw new Error("project context requires claude-config authentication");
  const model = text(raw.model, "backend.model");
  if (model === "configured" && raw.auth !== "claude-config") throw new Error("model configured is reserved for claude-config authentication");
  if (target.harness.permission === "bypass" && target.harness.adapter === "claude-code" && raw.auth !== "claude-config" && raw.auth !== "api-key") throw new Error("Claude bypass permission requires claude-config or api-key authentication");
  const effort = (): void => { if (raw.reasoningEffort !== undefined && (typeof raw.reasoningEffort !== "string" || !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(raw.reasoningEffort))) throw new Error("Unsupported reasoningEffort"); };
  if (raw.auth === "api-key") {
    keys(raw, ["auth", "model", "provider", "protocol", "baseURL", "apiKeyEnv", "reasoningEffort"], "API backend");
    name(raw.provider, "backend.provider"); envName(raw.apiKeyEnv, "backend.apiKeyEnv");
    const endpoint = text(raw.baseURL, "backend.baseURL");
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || endpoint.trim() !== endpoint) throw new Error("backend.baseURL must be an HTTP(S) endpoint without credentials, query or fragment");
    const protocol = target.harness.adapter === "codex" ? "responses" : target.harness.adapter === "opencode" ? "chat-completions" : "anthropic-messages";
    if (raw.protocol !== protocol) throw new Error(`${target.harness.adapter} requires ${protocol}`);
    if (raw.reasoningEffort !== undefined && target.harness.adapter !== "codex") {
      if (target.harness.adapter !== "claude-code") throw new Error("reasoningEffort is only supported by Codex or Claude Code API backends");
      if (!["low", "high", "max"].includes(String(raw.reasoningEffort))) throw new Error("Claude Code API reasoningEffort must be low, high or max");
    }
    effort();
  } else if (raw.auth === "chatgpt") {
    keys(raw, ["auth", "model", "reasoningEffort", "codexHome", "credentialsStore"], "ChatGPT backend");
    if (target.harness.adapter !== "codex") throw new Error("chatgpt auth requires Codex");
    if (raw.codexHome !== undefined) absolute(raw.codexHome, "backend.codexHome");
    if (raw.credentialsStore !== undefined && (typeof raw.credentialsStore !== "string" || !["auto", "file", "keyring"].includes(raw.credentialsStore))) throw new Error("credentialsStore must be auto, file or keyring");
    effort();
  } else if (raw.auth === "claude-subscription" || raw.auth === "claude-config") {
    keys(raw, ["auth", "model", "claudeConfigDir"], "Claude native backend");
    if (target.harness.adapter !== "claude-code") throw new Error(`${raw.auth} auth requires Claude Code`);
    if (raw.claudeConfigDir !== undefined) absolute(raw.claudeConfigDir, "backend.claudeConfigDir");
  } else if (raw.auth === "cursor-login" || raw.auth === "cursor-api-key") {
    keys(raw, raw.auth === "cursor-login" ? ["auth", "model"] : ["auth", "model", "apiKeyEnv"], "Cursor backend");
    if (target.harness.adapter !== "cursor-agent") throw new Error("Cursor authentication requires Cursor Agent");
    if (raw.apiKeyEnv !== undefined) envName(raw.apiKeyEnv, "backend.apiKeyEnv");
  } else throw new Error("Unsupported built-in backend.auth");
  return { ...raw, model } as Backend;
}
export function validateRequest(value: unknown): RunRequest {
  const raw = record(value, "request"); keys(raw, ["runId", "workspace", "prompt", "target", "timeoutMs", "maxOutputBytes", "terminationGraceMs", "stateDir"], "request");
  if (typeof raw.prompt !== "string" || !raw.prompt.trim() || raw.prompt.includes("\0")) throw new Error("prompt must be non-empty text without NUL");
  const result: RunRequest = { runId: name(raw.runId, "runId"), workspace: absolute(raw.workspace, "workspace"), prompt: raw.prompt, target: validateTarget(raw.target), timeoutMs: integer(raw.timeoutMs, "timeoutMs", 1, 2_147_483_647) };
  if (raw.maxOutputBytes !== undefined) result.maxOutputBytes = integer(raw.maxOutputBytes, "maxOutputBytes", 1024, 134_217_728);
  if (raw.terminationGraceMs !== undefined) result.terminationGraceMs = integer(raw.terminationGraceMs, "terminationGraceMs", 0, 30_000);
  if (raw.stateDir !== undefined) result.stateDir = absolute(raw.stateDir, "stateDir");
  return result;
}
