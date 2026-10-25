import path from "node:path";

type CursorLauncherPlan = {
  executable: string;
  args: string[];
  files: Array<{ path: string; content: string; mode: 0o700 }>;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Windows installs start `node.exe` with the sibling `index.js`. Other native executables are launched directly. */
export function cursorCommandPrefix(executable: string): string[] {
  if (process.platform !== "win32") return [];
  if (path.win32.basename(executable).toLowerCase() !== "node.exe") return [];
  return [path.win32.join(path.win32.dirname(executable), "index.js")];
}

/**
 * The official Cursor launcher uses /usr/bin/env bash. Running it directly with
 * our tool-shell wrappers first in PATH would apply the tool environment to the
 * native agent itself, losing its authentication context and trusted preload.
 * Use the system interpreter only for this entry point; keep PATH unchanged so
 * later agent shell calls still go through the isolated tool wrappers.
 * Planning does not resolve an executable, read credentials or start a process.
 */
export function planCursorLauncher(home: string, executable: string): CursorLauncherPlan {
  if (!path.isAbsolute(home) || /[\u0000-\u001f\u007f]/u.test(home)) {
    throw new Error("Cursor Agent launcher HOME 必须是无控制字符的绝对路径");
  }
  if (executable.trim() === "" || /[\u0000-\u001f\u007f]/u.test(executable)) {
    throw new Error("Cursor Agent executable 不能为空或包含控制字符");
  }
  if (process.platform === "win32") {
    return { executable, args: cursorCommandPrefix(executable), files: [] };
  }
  const launcherPath = path.join(path.resolve(home), "cursor-launcher.sh");
  const content = [
    "#!/bin/bash -p",
    "set -eu",
    `cursor_native_executable=${shellQuote(executable)}`,
    'if ! cursor_native_launcher=$(command -v -- "$cursor_native_executable"); then',
    "  printf '%s\\n' 'Cursor Agent native launcher not found' >&2",
    "  exit 127",
    "fi",
    'case "$cursor_native_launcher" in',
    "  /*) ;;",
    '  *) cursor_native_launcher="$PWD/$cursor_native_launcher" ;;',
    "esac",
    'if [ ! -f "$cursor_native_launcher" ] || [ ! -x "$cursor_native_launcher" ]; then',
    "  printf '%s\\n' 'Cursor Agent native launcher is not an executable file' >&2",
    "  exit 126",
    "fi",
    // macOS Bash requires long options before short options.
    'exec /bin/bash --noprofile --norc -p "$cursor_native_launcher" "$@"',
    "",
  ].join("\n");
  return {
    executable: "/bin/bash",
    args: ["-p", launcherPath],
    files: [{ path: launcherPath, content, mode: 0o700 }],
  };
}
