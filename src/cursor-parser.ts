import { realpathSync } from "node:fs";
import path from "node:path";
import type { EventType, OutputParser, RunRequest } from "./types.js";

function sameDirectory(reported: string, requested: string): boolean {
  const left = path.resolve(reported), right = path.resolve(requested);
  if (left === right) return true;
  try { return realpathSync.native(left) === realpathSync.native(right); } catch { return false; }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim() !== ""; }

/** Native result text is authoritative; assistant messages can repeat flushes. */
export function createCursorParser(request?: RunRequest): OutputParser {
  let error: string | null = null, sessionId: string | null = null, text = "";
  let initialized = false, terminal = false, completed = false;
  return {
    push(value) {
      const events: Array<{ type: EventType; data: unknown }> = [{ type: "raw", data: value }];
      const event = object(value);
      if (!event || typeof event.type !== "string") { error ??= "Cursor Agent emitted invalid event data"; return events; }
      if (terminal) error ??= "Cursor Agent emitted events after its terminal result";
      if (event.type === "system" && event.subtype === "init") {
        if (initialized || !nonempty(event.session_id)) error ??= "Cursor Agent emitted invalid or duplicate session initialization";
        else { initialized = true; sessionId = event.session_id; }
        if (request) {
          if (typeof event.cwd !== "string" || !path.isAbsolute(event.cwd) || !sameDirectory(event.cwd, request.workspace)) error ??= "Cursor Agent workspace did not match the requested run";
          if (event.apiKeySource !== (request.target.backend.auth === "cursor-login" ? "login" : "env")) error ??= "Cursor Agent authentication source did not match the target";
        }
      }
      if (event.session_id !== undefined && (sessionId === null || event.session_id !== sessionId)) error ??= "Cursor Agent emitted an inconsistent session ID";
      if (event.type === "assistant") events.push({ type: "message", data: event });
      if (event.type === "tool_call") events.push({ type: "tool", data: event });
      if (event.type === "error") {
        error ??= typeof event.message === "string" ? event.message : "Cursor Agent reported a stream error";
        events.push({ type: "diagnostic", data: event });
      }
      if (event.type === "result") {
        terminal = true;
        if (!initialized || event.session_id !== sessionId) error ??= "Cursor Agent result has no matching session";
        if (event.subtype !== "success" || event.is_error !== false || typeof event.result !== "string") error ??= typeof event.result === "string" ? event.result : "Cursor Agent did not return a successful terminal result";
        else { text = event.result; completed = true; }
        // Cursor can synthesize zero fields and omit retry/reasoning tokens.
        // Retain the event, without claiming complete usage or a billable cost.
        if (event.usage !== undefined) events.push({ type: "usage", data: event.usage });
      }
      return events;
    },
    finish() {
      if (!completed) error ??= "Cursor Agent ended without a terminal completion event";
      return { completed: completed && error === null, failed: error !== null, text, usage: null, cost: null, sessionId, responseModel: null, error };
    },
  };
}
