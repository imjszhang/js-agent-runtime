import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ProcessPlan } from "./types.js";

export type ProcessOptions = { signal?: AbortSignal; timeoutMs: number; maxOutputBytes?: number; terminationGraceMs?: number; onLine?: (stream: "stdout" | "stderr", line: string) => void };
export type ProcessResult = { stdout: string; stderr: string; exitCode: number | null; signal: string | null; timedOut: boolean; cancelled: boolean; error: string | null };
const active = new Map<number, () => void>();
let parentTimer: NodeJS.Timeout | undefined;
function terminateGroups(): void { for (const stop of active.values()) stop(); }
function parentSignal(signal: NodeJS.Signals, own: () => void): void {
  terminateGroups();
  if (process.listeners(signal).some(listener => listener !== own)) return;
  if (parentTimer) clearTimeout(parentTimer);
  parentTimer = setTimeout(() => {
    process.removeListener("SIGTERM", onTerm); process.removeListener("SIGINT", onInt);
    try { process.kill(process.pid, signal); } catch { process.exit(signal === "SIGINT" ? 130 : 143); }
  }, 10);
}
const onTerm = (): void => parentSignal("SIGTERM", onTerm);
const onInt = (): void => parentSignal("SIGINT", onInt);
function register(pid: number, stop: () => void): () => void {
  if (!active.size) { process.on("exit", terminateGroups); process.prependListener("SIGTERM", onTerm); process.prependListener("SIGINT", onInt); }
  active.set(pid, stop);
  return () => { active.delete(pid); if (!active.size) { process.removeListener("exit", terminateGroups); process.removeListener("SIGTERM", onTerm); process.removeListener("SIGINT", onInt); } };
}
const allowedInherited = ["PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "COMSPEC", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
export function baseEnvironment(): Record<string, string> {
  return Object.fromEntries(allowedInherited.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
}
/** No shell interpolation. POSIX children own a process group, including renderer descendants. */
export async function runProcess(processPlan: ProcessPlan, options: ProcessOptions): Promise<ProcessResult> {
  if (process.platform === "win32") throw new Error("Process-group isolation currently requires POSIX (macOS/Linux)");
  const empty = (): ProcessResult => ({ stdout: "", stderr: "", exitCode: null, signal: null, timedOut: false, cancelled: false, error: null });
  if (options.signal?.aborted) return { ...empty(), cancelled: true, error: "Run cancelled before process start" };
  return new Promise(resolve => {
    const result = empty();
    const child = spawn(processPlan.executable, processPlan.args, { cwd: processPlan.cwd, env: processPlan.env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let finished = false, terminating = false, bytes = 0;
    const limit = options.maxOutputBytes ?? 16_777_216, grace = options.terminationGraceMs ?? 500;
    const buffers = { stdout: "", stderr: "" }, decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let killTimer: NodeJS.Timeout | undefined, closeTimer: NodeJS.Timeout | undefined;
    const signalGroup = (signal: NodeJS.Signals): void => { if (child.pid) { try { process.kill(-child.pid, signal); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ESRCH") result.error ??= "Could not signal child process group"; } } };
    let unregister = (): void => {};
    const line = (stream: "stdout" | "stderr", value: string): void => {
      try { options.onLine?.(stream, value); } catch { result.error ??= "Process output consumer failed"; terminate(); }
    };
    const finish = (): void => {
      if (finished) return; finished = true;
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer); if (closeTimer) clearTimeout(closeTimer);
      options.signal?.removeEventListener("abort", abort);
      signalGroup("SIGKILL"); unregister();
      for (const stream of ["stdout", "stderr"] as const) { buffers[stream] += decoders[stream].end(); if (buffers[stream]) line(stream, buffers[stream]); }
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      resolve(result);
    };
    const terminate = (): void => {
      if (finished || terminating) return; terminating = true; signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), grace);
      closeTimer = setTimeout(finish, grace + 500);
    };
    const abort = (): void => { result.cancelled = true; result.error ??= "Run cancelled"; terminate(); };
    const timer = setTimeout(() => { result.timedOut = true; result.error ??= `Process timed out after ${options.timeoutMs} ms`; terminate(); }, Math.max(1, options.timeoutMs));
    const capture = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const remaining = Math.max(0, limit - bytes); bytes += chunk.length;
      if (remaining) {
        const value = decoders[stream].write(chunk.subarray(0, remaining)); result[stream] += value; buffers[stream] += value;
        let index: number;
        while ((index = buffers[stream].indexOf("\n")) >= 0) { const value = buffers[stream].slice(0, index).replace(/\r$/u, ""); buffers[stream] = buffers[stream].slice(index + 1); line(stream, value); }
      }
      if (bytes > limit) { result.error ??= `Process output exceeded ${limit} bytes`; terminate(); }
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk)); child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.stdin.on("error", (cause: NodeJS.ErrnoException) => { if (cause.code !== "EPIPE" && cause.code !== "ERR_STREAM_DESTROYED") result.error ??= "Failed to write agent input"; });
    child.on("error", cause => { result.error ??= `Cannot start executable (${(cause as NodeJS.ErrnoException).code ?? "unknown"})`; finish(); });
    child.on("exit", (code, signal) => {
      result.exitCode = code; result.signal = signal;
      // A descendant may keep the pipes open after its parent exits.
      signalGroup("SIGTERM"); if (!closeTimer) closeTimer = setTimeout(finish, grace + 500);
    });
    child.on("close", (code, signal) => { result.exitCode = code; result.signal = signal; finish(); });
    if (child.pid) unregister = register(child.pid, () => signalGroup("SIGKILL"));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdin.end(processPlan.stdin);
  });
}
