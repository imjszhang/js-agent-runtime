export type Permission = "read-only" | "workspace-write" | "bypass";
export type Protocol = "responses" | "anthropic-messages" | "chat-completions";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type ApiBackend = {
  auth: "api-key"; model: string; provider: string; protocol: Protocol;
  baseURL: string; apiKeyEnv: string; reasoningEffort?: ReasoningEffort;
};
export type CodexLoginBackend = { auth: "chatgpt"; model: string; reasoningEffort?: ReasoningEffort; codexHome?: string; credentialsStore?: "auto" | "file" | "keyring" };
export type ClaudeLoginBackend = { auth: "claude-subscription"; model: string; claudeConfigDir?: string };
/** configured deliberately leaves model selection to the CLI's user settings. */
export type ClaudeConfigBackend = { auth: "claude-config"; model: string; claudeConfigDir?: string };
/** Extensions validate their own backend without expanding the built-in auth union. */
export type ExtensionBackend = { auth: string; model: string; [key: string]: unknown };
export type CursorLoginBackend = { auth: "cursor-login"; model: string };
export type CursorApiBackend = { auth: "cursor-api-key"; model: string; apiKeyEnv?: string };
export type Backend = ApiBackend | CodexLoginBackend | ClaudeLoginBackend | ClaudeConfigBackend | CursorLoginBackend | CursorApiBackend;
export type Harness = {
  adapter: string; executable: string; permission: Permission; contextMode?: "snapshot" | "project";
  /** Cursor-only native transport and login compatibility options. */
  useHttp1ForAgent?: boolean; nativeStallTimeoutMs?: number; useCurrentUserHomeForLogin?: boolean;
};
export type Target = { name: string; harness: Harness; backend: Backend | ExtensionBackend };
export type RunRequest = {
  runId: string; workspace: string; prompt: string; target: Target; timeoutMs: number;
  maxOutputBytes?: number; terminationGraceMs?: number; stateDir?: string;
};
export type PlannedFile = { path: string; content: string; mode?: 0o600 | 0o700; encoding?: "utf8" | "latin1" };
export type ProcessPlan = { executable: string; args: string[]; cwd: string; stdin: string; env: Record<string, string> };
export type AdapterPlan = {
  process: ProcessPlan; files: PlannedFile[];
  credential?: { ref: string; envVar: string };
};
export type ExecutionPlan = AdapterPlan & {
  schemaVersion: 1; runtimeVersion: string; adapter: { id: string; version: string };
  request: RunRequest; stateDir: string; planHash: string;
};
export type Usage = {
  inputTokens: number; outputTokens: number; totalTokens: number;
  cachedInputTokens: number | null; reasoningTokens: number | null;
};
export type EventType = "started" | "message" | "tool" | "usage" | "raw" | "diagnostic" | "completed" | "failed" | "cancelled" | "timed_out";
export type RuntimeEvent = { schemaVersion: 1; runId: string; sequence: number; time: string; type: EventType; data: unknown };
export type ParsedOutput = {
  completed: boolean; failed: boolean; text: string; usage: Usage | null;
  cost: { total: number; currency: string } | null;
  sessionId: string | null; responseModel: string | null; error: string | null;
};
export type OutputParser = {
  push(value: unknown): Array<{ type: EventType; data: unknown }>;
  finish(): ParsedOutput;
};
/** Registration is a trusted-code operation. Adapter output is checked before execution. */
export type Adapter = {
  id: string; version: string;
  validate(target: Target): void;
  plan(request: RunRequest, context: { stateDir: string }): AdapterPlan;
  createParser(request?: RunRequest): OutputParser;
  probeArgs?: string[];
};
export type RunStatus = "completed" | "failed" | "cancelled" | "timed_out";
export type RunResult = {
  schemaVersion: 1; runtimeVersion: string; runId: string; planHash: string;
  adapter: { id: string; version: string }; status: RunStatus;
  text: string; usage: Usage | null; cost: ParsedOutput["cost"];
  sessionId: string | null; responseModel: string | null;
  exitCode: number | null; signal: string | null; error: string | null;
  startedAt: string; finishedAt: string; durationMs: number;
};
export type RunOptions = {
  signal?: AbortSignal;
  onEvent?: (event: RuntimeEvent) => void | Promise<void>;
  resolveCredential?: (ref: string) => string | undefined | Promise<string | undefined>;
  /** New directory only. Contains runtime records, never application business files. */
  runDir?: string;
  /** Explicit operational environment. Credential and agent configuration overrides are rejected. */
  env?: Record<string, string>;
};
export type ProbeOptions = { checkExecutable?: boolean; checkLogin?: boolean; timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal };
export type ProbeResult = {
  schemaVersion: 1; adapter: string; executable: string;
  checks: Array<{ name: string; status: "passed" | "failed" | "unknown" | "skipped"; message: string }>;
  ok: boolean;
};
export type SnapshotFile = { path: string; sha256: string; size: number; mode: number };
export type Snapshot = { schemaVersion: 1; sha256: string; files: SnapshotFile[] };
