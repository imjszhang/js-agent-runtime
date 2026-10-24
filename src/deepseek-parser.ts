import type { EventType, OutputParser, ParsedOutput, Usage } from "./types.js";

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown): string | null => typeof value === "string" ? value : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
function stepUsage(value: unknown): Usage | null {
  const data = object(value); if (!data) return null;
  const input = count(data.inputTokens), output = count(data.outputTokens);
  if (input === null || output === null) return null;
  const cached = count(data.cacheReadTokens), prompt = input + (cached ?? 0) + (count(data.cacheWriteTokens) ?? 0);
  return { inputTokens: prompt, outputTokens: output, totalTokens: count(data.totalTokens) ?? prompt + output,
    cachedInputTokens: cached, reasoningTokens: count(data.reasoningTokens) };
}
function aggregate(steps: Array<Usage | null>): Usage | null {
  if (!steps.length || steps.some(step => step === null)) return null;
  const sum: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
  for (const step of steps) {
    if (!step) return null;
    sum.inputTokens += step.inputTokens; sum.outputTokens += step.outputTokens; sum.totalTokens += step.totalTokens;
    for (const key of ["cachedInputTokens", "reasoningTokens"] as const) sum[key] = sum[key] === null || step[key] === null ? null : sum[key] + step[key];
  }
  return sum;
}

/** Headless JSON projection: a final answer alone is not proof of completion. */
export function createDeepseekParser(): OutputParser {
  const result: ParsedOutput = { completed: false, failed: false, text: "", usage: null, cost: null, sessionId: null, responseModel: null, error: null };
  const steps: Array<Usage | null> = [], stepKeys = new Set<string>(), turns = new Set<number>();
  let final = false, completedTurn = false;
  const fail = (message: string): void => { result.failed = true; result.error ??= message; };
  return {
    push(value) {
      const events: Array<{ type: EventType; data: unknown }> = [{ type: "raw", data: value }];
      const e = object(value);
      if (!e || typeof e.type !== "string") { fail("DeepSeek Harness emitted an event without a type"); return events; }
      if (final) { fail("DeepSeek Harness emitted an event after final"); return events; }
      if (e.type === "session") {
        if (typeof e.sessionId !== "string" || !e.sessionId || result.sessionId !== null) fail("DeepSeek Harness emitted an invalid or duplicate session");
        else result.sessionId = e.sessionId;
      } else if (e.type === "text") {
        result.text = string(e.text) ?? result.text;
        events.push({ type: "message", data: { text: result.text } });
      } else if (e.type === "tool_call" || e.type === "tool_result") {
        // A failed tool call may be recovered by a later step.
        events.push({ type: "tool", data: e });
      } else if (e.type === "status" && e.phase === "step_end") {
        const key = JSON.stringify([e.turn, e.step]);
        if (!Number.isSafeInteger(e.turn) || !Number.isSafeInteger(e.step) || stepKeys.has(key) || turns.has(e.turn as number)) fail("DeepSeek Harness emitted an invalid or duplicate step completion");
        stepKeys.add(key);
        const usage = stepUsage(e.usage); steps.push(usage);
        if (usage) events.push({ type: "usage", data: usage });
      } else if (e.type === "status" && e.phase === "turn_end") {
        if (!Number.isSafeInteger(e.turn) || turns.has(e.turn as number)) fail("DeepSeek Harness emitted an invalid or duplicate turn completion");
        turns.add(e.turn as number);
        const reason = object(e.reason);
        completedTurn = reason?.kind === "completed";
        if (!completedTurn) fail(string(object(reason?.error)?.message) ?? `DeepSeek Harness turn ended: ${String(reason?.kind ?? "unknown")}`);
      } else if (e.type === "final") {
        final = true;
        if (typeof e.text !== "string" || !completedTurn || result.sessionId === null) fail("DeepSeek Harness ended without a valid session and completed turn");
        result.text = string(e.text) ?? result.text;
        events.push({ type: "message", data: { text: result.text } });
      } else if (e.type === "error") fail(string(e.message) ?? "DeepSeek Harness reported an error");
      return events;
    },
    finish() {
      result.completed = final && completedTurn && result.sessionId !== null && !result.failed;
      result.usage = result.completed ? aggregate(steps) : null;
      if (!result.completed) result.error ??= "DeepSeek Harness ended without a terminal completion event";
      return structuredClone(result);
    },
  };
}
