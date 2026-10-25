import path from "node:path";
import { CURSOR_SHELL_WIN_EXE } from "./cursor-shell-win-exe.js";

type CursorShellPlan = {
  env: Record<string, string>;
  files: Array<{ path: string; content: string; mode?: 0o600 | 0o700; encoding?: "utf8" | "latin1" }>;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Cursor Agent 2026.07.23-e383d2b selects bash/zsh using PATH, and its native
 * shell environment filter removes only ELECTRON_RUN_AS_NODE. Put trusted
 * wrappers first so both shell-state capture and model shell calls lose the
 * harness credentials before a shell can inspect or snapshot its environment.
 *
 * This is a shell boundary, not a process-wide sandbox. Native account/team
 * hooks, plugins and direct native child-process calls can bypass PATH shell
 * selection. The adapter must separately enable native sandbox/permissions,
 * prevent candidate writes to these files, and allow the sandbox to read this
 * directory so its interpreter can open the wrappers. No files are read and no
 * processes are started while planning. The current host PATH is captured in
 * the plan; recreate the plan after changing PATH. Tool binaries remain live
 * host inputs and are not frozen by the plan hash.
 */
function windowsShell(isolatedHome: string): CursorShellPlan {
  const bin = path.join(isolatedHome, "cursor-shell", "bin");
  const inheritedPath = process.env.PATH ?? "";
  if (/[\u0000\r\n]/u.test(inheritedPath)) throw new Error("Cursor Agent PATH 包含无效字符");
  const exe = CURSOR_SHELL_WIN_EXE.toString("latin1");
  return {
    env: { PATH: inheritedPath === "" ? bin : `${bin}${path.delimiter}${inheritedPath}` },
    files: [
      { path: path.join(bin, "powershell.exe"), content: exe, mode: 0o700, encoding: "latin1" },
      { path: path.join(bin, "pwsh.exe"), content: exe, mode: 0o700, encoding: "latin1" },
    ],
  };
}

export function planCursorShell(home: string): CursorShellPlan {
  if (!path.isAbsolute(home) || /[\u0000-\u001f\u007f]/u.test(home)) throw new Error("Cursor Agent 临时 HOME 必须是绝对路径");
  const isolatedHome = path.resolve(home);
  if (process.platform === "win32") return windowsShell(isolatedHome);
  const bin = path.join(isolatedHome, "cursor-shell", "bin");
  const inheritedPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  if (/[\u0000\r\n]/u.test(inheritedPath)) throw new Error("Cursor Agent PATH 包含无效字符");
  const script = (shell: "bash" | "zsh"): string => [
    // Privileged startup ignores BASH_ENV and imported shell functions before
    // this trusted script has a chance to clear the inherited environment.
    "#!/bin/bash -p",
    "set -eu",
    "while IFS= read -r cursor_env_name; do",
    "  case \"$cursor_env_name\" in",
    "    HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy) continue ;;",
    "    *[Kk][Ee][Yy]*|*[Tt][Oo][Kk][Ee][Nn]*|*[Ss][Ee][Cc][Rr][Ee][Tt]*|*[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]*|*[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]*|*[Pp][Rr][Oo][Xx][Yy]*)",
    "      unset -v \"$cursor_env_name\" ;;",
    "  esac",
    "done < <(compgen -e)",
    "unset BASH_ENV ENV CDPATH GLOBIGNORE NODE_OPTIONS NODE_PATH",
    "export -n SHELLOPTS BASHOPTS 2>/dev/null || true",
    `export HOME=${shellQuote(isolatedHome)}`,
    `export USERPROFILE=${shellQuote(isolatedHome)}`,
    `export ZDOTDIR=${shellQuote(isolatedHome)}`,
    `export SHELL=${shellQuote(path.join(bin, "bash"))}`,
    // Use absolute system executables to avoid recursively finding ourselves.
    shell === "bash" ? 'exec /bin/bash --noprofile --norc "$@"' : 'exec /bin/zsh -f "$@"',
    "",
  ].join("\n");
  return {
    env: {
      PATH: `${bin}${path.delimiter}${inheritedPath}`,
      SHELL: path.join(bin, "bash"),
      ZDOTDIR: isolatedHome,
    },
    files: (["bash", "zsh"] as const).map((shell) => ({ path: path.join(bin, shell), content: script(shell), mode: 0o700 })),
  };
}
