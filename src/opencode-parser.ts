import path from "node:path";
import type { ProcessResult } from "./process.js";
import type { EventType, OutputParser, ParsedOutput, RunRequest, Usage } from "./types.js";

// Keep this route identity independent of the caller's provider label.
const PROVIDER = "js_agent_runtime";
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown): string | null => typeof value === "string" ? value : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
type Event = { type: EventType; data: unknown };
type MessageContent = { ordinals: Map<string, number>; blocks: Map<number, string>; projected: Map<string, string> };

/** V2 reconciliation emits only a missing suffix under a projected block ID. */
function appendContent(messages: Map<string, MessageContent>, message: string, id: string, value: string, kind: "text" | "reasoning"): boolean {
  let content = messages.get(message);
  if (content === undefined) { content = { ordinals: new Map(), blocks: new Map(), projected: new Map() }; messages.set(message, content); }
  const prefix = `prt_${message.replace(/^msg_/u, "")}_${kind}-`, suffix = id.startsWith(prefix) ? id.slice(prefix.length) : "";
  if (/^\d+$/u.test(suffix)) {
    const ordinal = Number(suffix);
    if (!Number.isSafeInteger(ordinal)) return false;
    const previous = content.projected.get(id);
    if (previous !== undefined) return previous === value;
    content.projected.set(id, value);
    content.blocks.set(ordinal, (content.blocks.get(ordinal) ?? "") + value);
    return true;
  }
  let ordinal = content.ordinals.get(id);
  if (ordinal === undefined) { ordinal = content.ordinals.size; content.ordinals.set(id, ordinal); }
  content.blocks.set(ordinal, value);
  return true;
}
function contentText(content: MessageContent | undefined): string {
  return content === undefined ? "" : [...content.blocks].sort(([left], [right]) => left - right).map(([, value]) => value).join("");
}
function readUsage(value: unknown): Usage | null {
  const tokens = record(value); if (tokens === null) return null;
  const input = count(tokens.input), output = count(tokens.output), reasoning = count(tokens.reasoning), cache = record(tokens.cache);
  const read = count(cache?.read), write = count(cache?.write);
  if (input === null || output === null || reasoning === null || read === null || write === null) return null;
  // Native V2 counters exclude both cache input and reasoning output.
  const inputTokens = input + read + write, outputTokens = output + reasoning;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cachedInputTokens: read, reasoningTokens: reasoning };
}
function createStream(): { parser: OutputParser; recoverable(): boolean } {
  const textParts = new Map<string, MessageContent>(), reasoningParts = new Map<string, MessageContent>(), steps = new Map<string, Usage | null>();
  const stepDefinitions = new Map<string, string>(), completedMessages = new Set<string>();
  let sessionId: string | null = null, error: string | null = null, latestTextMessage: string | null = null, finalStepMessage: string | null = null, lastStepReason: string | null = null;
  let invalid = false, delegated = false;
  const fail = (message: string): void => { invalid = true; error ??= message; };
  const parser: OutputParser = {
    push(value) {
      const events: Event[] = [{ type: "raw", data: value }], event = record(value);
      if (event === null || typeof event.type !== "string") { fail("OpenCode emitted a malformed JSON event"); return events; }
      const currentSession = string(event.sessionID), tracked = ["step_start", "step_finish", "text", "reasoning", "tool_use"].includes(event.type);
      if (tracked && !currentSession) fail("OpenCode emitted an event without a session ID");
      if (currentSession) {
        if (sessionId !== null && sessionId !== currentSession) fail("OpenCode emitted events from multiple sessions");
        sessionId ??= currentSession;
      }
      const part = record(event.part), id = string(part?.id), message = string(part?.messageID);
      if (tracked && !message) fail("OpenCode emitted an event without an assistant message ID");
      if (["text", "reasoning", "tool_use"].includes(event.type) && lastStepReason === "stop" && (message === null || !completedMessages.has(message))) fail("OpenCode emitted a new message after the final stop step without starting a new step");
      if (event.type === "step_start") lastStepReason = null;
      else if (event.type === "text" || event.type === "reasoning") {
        const value = string(part?.text);
        if (!id || !message || value === null) { fail("OpenCode emitted a malformed content event"); return events; }
        if (!appendContent(event.type === "text" ? textParts : reasoningParts, message, id, value, event.type)) fail("OpenCode emitted conflicting content reconciliation");
        if (event.type === "text") { latestTextMessage = message; events.push({ type: "message", data: { text: contentText(textParts.get(message)), messageId: message } }); }
      } else if (event.type === "tool_use") {
        if (part?.tool === "subagent" || part?.tool === "task") delegated = true;
        events.push({ type: "tool", data: value });
      } else if (event.type === "step_finish") {
        if (!id || !message || typeof part?.reason !== "string") { fail("OpenCode emitted a malformed step finish event"); return events; }
        const key = `${message}\u0000${id}`, definition = JSON.stringify([part.reason, part.tokens]);
        const previous = stepDefinitions.get(key);
        if (previous !== undefined && previous !== definition) fail("OpenCode emitted a conflicting duplicate step finish");
        stepDefinitions.set(key, definition);
        lastStepReason = part.reason; finalStepMessage = message; completedMessages.add(message);
        const usage = readUsage(part.tokens); steps.set(key, usage);
        if (usage !== null && previous === undefined) events.push({ type: "usage", data: usage });
      } else if (event.type === "error") {
        const failure = record(event.error);
        fail(string(failure?.message) ?? string(record(failure?.data)?.message) ?? string(event.error) ?? "OpenCode reported an error");
      }
      return events;
    },
    finish() {
      let usage: Usage | null = null;
      if (!invalid && steps.size > 0 && !delegated && [...steps.values()].every(step => step !== null)) {
        usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
        for (const step of steps.values()) if (step !== null) {
          usage.inputTokens += step.inputTokens; usage.outputTokens += step.outputTokens; usage.totalTokens += step.totalTokens;
          usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + (step.cachedInputTokens ?? 0);
          usage.reasoningTokens = (usage.reasoningTokens ?? 0) + (step.reasoningTokens ?? 0);
        }
      }
      const completed = !invalid && lastStepReason === "stop", outputMessage = lastStepReason === "stop" ? finalStepMessage : latestTextMessage;
      return { completed, failed: invalid || !completed, text: outputMessage === null ? "" : contentText(textParts.get(outputMessage)), usage, cost: null, sessionId, responseModel: null,
        error: error ?? (completed ? null : `OpenCode ended without a terminal stop step${lastStepReason === null ? "" : ` (${lastStepReason})`}`) };
    },
  };
  return { parser, recoverable: () => !invalid && (lastStepReason === null || lastStepReason === "tool-calls") };
}
export function createOpenCodeParser(): OutputParser { return createStream().parser; }

export type OpenCodeInspectionResult = ParsedOutput & { events: Event[] };
/** Only a clean stream missing its final stop can be recovered from durable state. */
export function parseOpenCodeInspection(request: RunRequest, run: ProcessResult, inspection: ProcessResult): OpenCodeInspectionResult {
  const stream = createStream(), rawEvents: unknown[] = [];
  let malformed = false;
  for (const line of run.stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try { const event: unknown = JSON.parse(line); rawEvents.push(event); stream.parser.push(event); } catch { malformed = true; }
  }
  const streamed = stream.parser.finish(), events: Event[] = [];
  const failed = (error: string): OpenCodeInspectionResult => ({ ...streamed, completed: false, failed: true, usage: null, cost: null, error, events });
  let exported: unknown;
  try { exported = JSON.parse(inspection.stdout); } catch { events.push({ type: "raw", data: { source: "opencode-session-export", stdout: inspection.stdout } }); }
  if (exported !== undefined) events.push({ type: "raw", data: { source: "opencode-session-export", export: exported } });
  if (inspection.timedOut) return failed("OpenCode session inspection timed out");
  if (inspection.cancelled) return failed("OpenCode session inspection cancelled");
  if (inspection.error !== null) return failed(`OpenCode session inspection failed: ${inspection.error}`);
  if (inspection.exitCode !== 0) return failed(`OpenCode session inspection exited with ${inspection.signal ?? String(inspection.exitCode)}`);
  if (run.timedOut || run.cancelled || run.error !== null || run.exitCode !== 0) return failed(run.error ?? "OpenCode process failed");
  if (malformed) return failed("OpenCode emitted malformed JSON events");
  if (!streamed.completed && !stream.recoverable()) return failed(streamed.error ?? "OpenCode emitted an invalid event stream");
  if (streamed.sessionId === null) return failed("OpenCode session inspection cannot verify a missing session ID");
  const data = record(exported), info = record(data?.info), location = record(info?.location), model = record(info?.model);
  if (info?.id !== streamed.sessionId) return failed("OpenCode session export does not match the executed session");
  if (model?.providerID !== PROVIDER || model.id !== request.target.backend.model) return failed("OpenCode session export backend does not match the target");
  if (typeof location?.directory !== "string" || !path.isAbsolute(location.directory) || path.resolve(location.directory) !== request.workspace) return failed("OpenCode session export workspace does not match the task");
  if (!Array.isArray(data?.messages)) return failed("OpenCode session export has no message history");
  const messages = data.messages.map(record);
  if (messages.some(message => message === null)) return failed("OpenCode session export has malformed messages");
  const users = messages.filter(message => message?.type === "user");
  if (users.length !== 1 || users[0]?.text !== request.prompt) return failed("OpenCode session export input does not match the task");
  const assistants = messages.filter((message): message is Record<string, unknown> => message?.type === "assistant"), final = assistants.at(-1), idle = messages.at(-1);
  if (info.outcome !== "succeeded" || idle?.type !== "idle" || idle.outcome !== "succeeded" || count(record(info.time)?.idle) === null) return failed("OpenCode session export has no successful native terminal outcome");
  if (final === undefined || final.finish !== "stop" || count(record(final.time)?.completed) === null || final.error !== undefined) return failed("OpenCode session export has no completed final stop message");
  const assistantIds = new Set(assistants.map(message => string(message.id))), streamedText = new Map<string, MessageContent>();
  if (assistantIds.has(null) || assistantIds.has("") || assistantIds.size !== assistants.length) return failed("OpenCode session export has malformed assistant IDs");
  let delegated = false;
  for (const raw of rawEvents) {
    const event = record(raw), part = record(event?.part), messageID = string(part?.messageID);
    if (["step_start", "step_finish", "text", "reasoning", "tool_use"].includes(string(event?.type) ?? "") && (messageID === null || !assistantIds.has(messageID))) return failed("OpenCode session export does not contain an emitted assistant message");
    if (event?.type === "text" && messageID !== null && typeof part?.id === "string" && typeof part.text === "string") appendContent(streamedText, messageID, part.id, part.text, "text");
    if (event?.type === "tool_use" && (part?.tool === "subagent" || part?.tool === "task")) delegated = true;
  }
  const textBlocks = (message: Record<string, unknown>): string[] => Array.isArray(message.content) ? message.content.flatMap((item: unknown) => {
    const block = record(item); return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }) : [];
  for (const message of assistants) {
    const ownModel = record(message.model);
    if (ownModel?.providerID !== PROVIDER || ownModel.id !== request.target.backend.model) return failed("OpenCode session export contains an unexpected assistant backend");
    if (message.error !== undefined || count(record(message.time)?.completed) === null) return failed("OpenCode session export contains an unfinished or failed assistant message");
    const content = streamedText.get(string(message.id) ?? ""), full = textBlocks(message);
    if (content !== undefined && [...content.blocks].some(([ordinal, value]) => !(full[ordinal]?.startsWith(value) ?? false))) return failed("OpenCode session export text does not match the emitted output");
    if (Array.isArray(message.content) && message.content.some((item: unknown) => { const tool = record(item); return tool?.type === "tool" && (tool.name === "subagent" || tool.name === "task"); })) delegated = true;
  }
  const usage = delegated ? null : readUsage(info.tokens), text = textBlocks(final).join("");
  if (usage !== null) events.push({ type: "usage", data: usage });
  events.push({ type: "message", data: { source: "opencode-session-export", text, messageId: final.id } });
  // Custom model cost=0 is synthesized by the CLI, not evidence of a free call.
  return { ...streamed, completed: true, failed: false, text, usage, cost: null, error: null, events };
}
