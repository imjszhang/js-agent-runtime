import { fileURLToPath } from "node:url";
import path from "node:path";
import type { RunRequest, McpServer, PlannedFile } from "./types.js";

export const mcpTokenEnv = (index: number): string => `JS_AGENT_RUNTIME_MCP_TOKEN_${index}`;
export function mcpCredentials(request: RunRequest): Array<{ ref: string; envVar: string }> {
  return (request.mcpServers ?? []).map((server, index) => ({ ref: server.bearerTokenRef, envVar: mcpTokenEnv(index) }));
}

/** Explicit MCP endpoints connect directly; preserve inherited proxy exclusions. */
export function withMcpNoProxy(request: RunRequest, env: Record<string, string>): Record<string, string> {
  if (!request.mcpServers?.length) return env;
  const values = [...(env.NO_PROXY ?? "").split(","), ...(env.no_proxy ?? "").split(","),
    ...request.mcpServers.map(server => new URL(server.url).hostname.replace(/^\[|\]$/gu, ""))];
  const noProxy = [...new Set(values.map(value => value.trim()).filter(Boolean))].join(",");
  return { ...env, NO_PROXY: noProxy, no_proxy: noProxy };
}

export function mcpBridgeArgs(server: McpServer, index: number): string[] {
  return [fileURLToPath(new URL("./mcp-stdio.js", import.meta.url)), JSON.stringify({ url: server.url, tokenEnv: mcpTokenEnv(index), ...(server.enabledTools !== undefined ? { enabledTools: server.enabledTools } : {}) })];
}

/** Claude's native Bash must never inherit model or MCP credentials. */
export function planMcpShell(request: RunRequest, stateDir: string, original?: string): { env: Record<string, string>; files: PlannedFile[] } {
  if (!request.mcpServers?.length) return { env: {}, files: [] };
  if (process.platform === "win32") throw new Error("Claude MCP shell credential isolation currently requires a POSIX host");
  const wrapper = path.join(stateDir, "claude-shell", "mcp-bash");
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const content = ["#!/bin/bash -p", "set -eu", `unset BASH_ENV ENV ${request.mcpServers.map((_, i) => mcpTokenEnv(i)).join(" ")}`,
    "while IFS= read -r runtime_env_name; do",
    "  case \"$runtime_env_name\" in *[Kk][Ee][Yy]*|*[Tt][Oo][Kk][Ee][Nn]*|*[Ss][Ee][Cc][Rr][Ee][Tt]*|*[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]*) unset \"$runtime_env_name\" ;; esac",
    "done < <(compgen -e)",
    `exec ${quote(original ?? "/bin/bash")} ${original ? "" : "--noprofile --norc "}\"$@\"`, ""].join("\n");
  return { env: { CLAUDE_CODE_SHELL: wrapper }, files: [{ path: wrapper, content, mode: 0o700 }] };
}
