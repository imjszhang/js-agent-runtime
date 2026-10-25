import path from "node:path";
import { tmpdir } from "node:os";
import { builtInAdapters } from "./adapters.js";
import { hashObject } from "./snapshot.js";
import { absolute, envName, keys, name, nativeExecutable, overlaps, record, text, validateRequest } from "./validation.js";
import type { Adapter, AdapterPlan, ExecutionPlan, RunRequest } from "./types.js";

export const RUNTIME_VERSION = "0.2.0";
const adapters = new Map(builtInAdapters.map(a => [a.id, a]));
export function registerAdapter(adapter: Adapter): () => void {
  name(adapter.id, "adapter.id"); text(adapter.version, "adapter.version");
  if (adapters.has(adapter.id)) throw new Error(`Adapter already registered: ${adapter.id}`);
  if (typeof adapter.validate !== "function" || typeof adapter.plan !== "function" || typeof adapter.createParser !== "function") throw new Error("Adapter must implement validate, plan and createParser");
  adapters.set(adapter.id, adapter);
  return () => { if (adapters.get(adapter.id) === adapter) adapters.delete(adapter.id); };
}
export function getAdapter(id: string): Adapter {
  const adapter = adapters.get(id); if (!adapter) throw new Error(`Unknown adapter: ${id}`); return adapter;
}
export function listAdapters(): Array<{ id: string; version: string }> { return [...adapters.values()].map(({ id, version }) => ({ id, version })); }
function validateAdapterPlan(p: AdapterPlan, request: RunRequest, state: string): void {
  const raw = record(p, "adapter plan"); keys(raw, ["process", "files", "credential"], "adapter plan");
  const proc = record(p.process, "process"); keys(proc, ["executable", "args", "cwd", "stdin", "env"], "process");
  nativeExecutable(proc.executable, "process.executable");
  if (proc.cwd !== request.workspace || proc.stdin !== request.prompt) throw new Error("Adapter must retain the requested workspace and prompt");
  if (!Array.isArray(proc.args) || !proc.args.every(a => typeof a === "string" && !a.includes("\0"))) throw new Error("Adapter args must be a string array");
  for (const [key, value] of Object.entries(record(proc.env, "process.env"))) { envName(key, "environment key"); if (typeof value !== "string" || value.includes("\0")) throw new Error("Invalid process environment"); }
  if (!Array.isArray(p.files)) throw new Error("Adapter files must be an array");
  const seen = new Set<string>();
  for (const file of p.files) {
    keys(record(file), ["path", "content", "mode", "encoding"], "planned file");
    const target = absolute(file.path, "planned file path");
    if (!target.startsWith(`${state}${path.sep}`) || seen.has(target)) throw new Error("Adapter files must be unique files inside stateDir");
    seen.add(target);
    if (typeof file.content !== "string" || (file.mode !== undefined && file.mode !== 0o600 && file.mode !== 0o700)) throw new Error("Invalid planned file");
    if (file.encoding !== undefined && file.encoding !== "utf8" && file.encoding !== "latin1") throw new Error("Invalid planned file encoding");
  }
  if (p.credential) { keys(record(p.credential), ["ref", "envVar"], "credential"); envName(p.credential.ref, "credential.ref"); envName(p.credential.envVar, "credential.envVar"); if (p.process.env[p.credential.envVar] !== undefined) throw new Error("Credential value must not appear in a plan"); }
}
/** Synchronous, serializable and side-effect free: does not inspect auth or disk. */
export function plan(value: RunRequest): ExecutionPlan {
  const request = validateRequest(value), adapter = getAdapter(request.target.harness.adapter);
  adapter.validate(request.target);
  const stateDir = request.stateDir ?? path.join(tmpdir(), "js-agent-runtime", `${request.runId}-${hashObject(request.workspace).slice(0, 12)}`);
  if (overlaps(stateDir, request.workspace)) throw new Error("stateDir must not overlap workspace");
  const planned = adapter.plan(request, { stateDir });
  validateAdapterPlan(planned, request, stateDir);
  const body = { schemaVersion: 1 as const, runtimeVersion: RUNTIME_VERSION, adapter: { id: adapter.id, version: adapter.version }, request, stateDir, ...planned };
  return { ...body, planHash: hashObject(body) };
}
export function assertPlan(value: ExecutionPlan): ExecutionPlan {
  const canonical = plan(value.request);
  if (hashObject(value) !== hashObject(canonical)) throw new Error("Execution plan was modified or its adapter changed; create a new plan");
  return canonical;
}
