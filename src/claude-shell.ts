import path from "node:path";
import type { PlannedFile } from "./types.js";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Default native login must retain HOME for the macOS Keychain namespace.
 * Claude's shell snapshot explicitly sources absolute startup files, so merely
 * changing the shell child's HOME or using --noprofile does not isolate it.
 * Only the default subscription mode needs this trusted initialization bridge;
 * explicit auth directories already have an isolated HOME, and claude-config
 * deliberately permits native user configuration.
 */
export function planClaudeSubscriptionShell(authDir: string, stateDir: string): { env: Record<string, string>; files: PlannedFile[] } {
  if (process.platform !== "darwin") throw new Error("Default Claude subscription login requires macOS shell isolation; use an explicit claudeConfigDir on this platform");
  const directory = path.join(stateDir, "claude-shell");
  const wrapper = path.join(directory, "subscription-bash"), profile = path.join(directory, "profile.sb");
  const originalHome = path.dirname(authDir);
  const blocked = [".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile", ".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"];
  const policy = ["(version 1)", "(allow default)", "(deny file-read*", ...blocked.map(name => `  (literal ${JSON.stringify(path.join(originalHome, name))})`), ")", ""].join("\n");
  const script = ["#!/bin/bash -p", "set -eu", "unset BASH_ENV ENV", `export HOME=${quote(stateDir)}`, `export USERPROFILE=${quote(stateDir)}`, `export ZDOTDIR=${quote(stateDir)}`,
    `exec /usr/bin/sandbox-exec -f ${quote(profile)} /bin/bash --noprofile --norc "$@"`, ""].join("\n");
  return { env: { CLAUDE_CODE_SHELL: wrapper }, files: [{ path: profile, content: policy, mode: 0o600 }, { path: wrapper, content: script, mode: 0o700 }] };
}
