import type { EventType, OutputParser, ParsedOutput, Usage } from "./types.js";
import { createClaudeAccounting } from "./claude-accounting.js";

const object = (x: unknown): Record<string, unknown> | undefined => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : undefined;
const string = (x: unknown): string | null => typeof x === "string" ? x : null;
const count = (x: unknown): number | null => typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null;
function usage(x: unknown, claude: boolean): Usage | null {
  const r = object(x); if (!r) return null;
  const input = count(r.input_tokens), output = count(r.output_tokens);
  if (input === null || output === null) return null;
  const cache = count(claude ? r.cache_read_input_tokens : r.cached_input_tokens);
  const actualInput = input + (claude ? (cache ?? 0) + (count(r.cache_creation_input_tokens) ?? 0) : 0);
  return { inputTokens: actualInput, outputTokens: output, totalTokens: actualInput + output, cachedInputTokens: cache, reasoningTokens: count(r.reasoning_output_tokens) };
}
export function createParser(kind: "codex" | "claude-code"): OutputParser {
  const result: ParsedOutput = { completed: false, failed: false, text: "", usage: null, cost: null, sessionId: null, responseModel: null, error: null };
  const accounting = createClaudeAccounting();
  let streamedText = "", claudeTerminal = false;
  return {
    push(value) {
      const events: Array<{ type: EventType; data: unknown }> = [];
      const e = object(value); if (!e || typeof e.type !== "string") throw new Error("Agent emitted an event without a type");
      events.push({ type: "raw", data: value });
      if (kind === "codex") {
        if (e.type === "thread.started") result.sessionId = string(e.thread_id);
        if (e.type === "item.started" || e.type === "item.updated") {
          const item = object(e.item);
          if (item && item.type !== "agent_message" && item.type !== "reasoning") events.push({ type: "tool", data: { phase: e.type, item } });
        }
        if (e.type === "item.completed") {
          const item = object(e.item);
          if (item?.type === "agent_message") { result.text = string(item.text) ?? ""; events.push({ type: "message", data: { text: result.text } }); }
          else if (item?.type !== "reasoning") events.push({ type: "tool", data: e.item });
        }
        if (e.type === "turn.completed") { result.completed = true; result.usage = usage(e.usage, false); }
        if (e.type === "turn.failed" || e.type === "error") {
          result.failed = true; result.error ??= string(object(e.error)?.message) ?? string(e.message) ?? string(e.error) ?? "Codex reported a failure";
        }
      } else {
        // Nested agent output is observable but cannot finish or replace the
        // root response. Its usage is already covered by the root run total.
        const child = e.parent_tool_use_id !== undefined && e.parent_tool_use_id !== null && e.parent_tool_use_id !== "";
        if (child) {
          if (e.type === "assistant") {
            const content = object(e.message)?.content;
            if (Array.isArray(content)) for (const block of content) if (object(block)?.type === "tool_use") events.push({ type: "tool", data: block });
          }
          if (e.type === "stream_event") {
            const stream = object(e.event), block = object(stream?.content_block);
            if (stream?.type === "content_block_start" && block?.type === "tool_use") events.push({ type: "tool", data: { phase: "started", ...block } });
          }
          return events;
        }
        if (claudeTerminal && ["assistant", "stream_event", "result"].includes(e.type)) {
          result.completed = false; result.failed = true;
          result.error ??= "Claude Code emitted output after its terminal result";
          return events;
        }
        accounting.observe(e);
        result.sessionId = string(e.session_id) ?? result.sessionId;
        if (e.type === "stream_event") {
          const stream = object(e.event);
          if (stream?.type === "message_start") {
            streamedText = "";
            result.responseModel = string(object(stream.message)?.model) ?? result.responseModel;
          }
          if (stream?.type === "content_block_delta") {
            const delta = object(stream.delta);
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              streamedText += delta.text; result.text = streamedText;
              events.push({ type: "message", data: { text: streamedText, delta: delta.text } });
            }
          }
          if (stream?.type === "content_block_start" && object(stream.content_block)?.type === "tool_use")
            events.push({ type: "tool", data: { phase: "started", ...object(stream.content_block) } });
        }
        if (e.type === "assistant") {
          const message = object(e.message); result.responseModel = string(message?.model) ?? result.responseModel;
          if (Array.isArray(message?.content)) {
            const parts: string[] = [];
            for (const block of message.content) {
              const b = object(block);
              if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
              if (b?.type === "tool_use") events.push({ type: "tool", data: b });
            }
            if (parts.length) { result.text = parts.join("\n"); events.push({ type: "message", data: { text: result.text } }); }
          }
        }
        if (e.type === "result") {
          claudeTerminal = true;
          if (e.subtype === "success" && e.is_error !== true) result.completed = true;
          else {
            const errors = Array.isArray(e.errors) ? e.errors.filter((value): value is string => typeof value === "string").join("; ") : "";
            result.failed = true; result.error ??= string(e.result) ?? (errors || `Claude Code result: ${String(e.subtype)}`);
          }
          result.text = string(e.result) ?? result.text;
          result.usage = accounting.usage();
          const total = count(e.total_cost_usd); if (total !== null) result.cost = { total, currency: "USD" };
          const models = object(e.modelUsage); if (models) result.responseModel = Object.keys(models).length === 1 ? Object.keys(models)[0] ?? null : null;
        }
        if (e.type === "error") { result.completed = false; result.failed = true; result.error ??= string(e.message) ?? "Claude Code reported a failure"; }
      }
      result.responseModel = string(e.model) ?? result.responseModel;
      if (e.type === "turn.completed" || e.type === "result") if (result.usage) events.push({ type: "usage", data: result.usage });
      return events;
    },
    finish: () => {
      if (kind === "claude-code") result.usage = accounting.usage();
      return structuredClone(result);
    },
  };
}
