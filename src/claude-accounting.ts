import type { Usage } from "./types.js";

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * Response snapshots and stream deltas may repeat the same API request. Only a
 * native result is a run total: summing visible responses can omit compaction,
 * retries or delegated work. A zero output placeholder is not complete usage
 * when text, reasoning or a tool call was actually observed.
 */
export function createClaudeAccounting(): { observe(event: Record<string, unknown>): void; usage(): Usage | null } {
  let visibleOutput = false, terminal: Record<string, unknown> | undefined;
  const observeBlock = (value: unknown): void => {
    const block = object(value);
    if (block?.type === "tool_use" || [block?.text, block?.thinking, block?.partial_json].some(value => typeof value === "string" && value.length > 0)) visibleOutput = true;
  };
  return {
    observe(event) {
      if (event.type === "assistant") {
        const message = object(event.message);
        if (Array.isArray(message?.content)) message.content.forEach(observeBlock);
      }
      if (event.type === "stream_event") {
        const stream = object(event.event);
        if (stream?.type === "content_block_start") observeBlock(stream.content_block);
        if (stream?.type === "content_block_delta") observeBlock(stream.delta);
      }
      if (event.type === "result" && (event.parent_tool_use_id === undefined || event.parent_tool_use_id === null)) {
        terminal = object(event.usage);
        if (typeof event.result === "string" && event.result.length > 0) visibleOutput = true;
      }
    },
    usage() {
      if (!terminal) return null;
      const input = count(terminal.input_tokens), output = count(terminal.output_tokens);
      if (input === null || output === null || (output === 0 && visibleOutput)) return null;
      const cached = count(terminal.cache_read_input_tokens), created = count(terminal.cache_creation_input_tokens);
      const actualInput = input + (cached ?? 0) + (created ?? 0);
      return { inputTokens: actualInput, outputTokens: output, totalTokens: actualInput + output, cachedInputTokens: cached, reasoningTokens: count(terminal.reasoning_output_tokens) };
    },
  };
}
