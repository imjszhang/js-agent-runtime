/** Native MCP stdio transport with an explicit HTTP upstream and tool policy. */
import { pathToFileURL } from "node:url";
import { createRedactor } from "./redaction.js";

type Rpc = { jsonrpc: "2.0"; id?: string | number; method?: string; params?: Record<string, unknown>; result?: any; error?: unknown };
type BridgeConfig = { url: string; tokenEnv: string; enabledTools?: string[] };
const MAX_BYTES = 16 * 1024 * 1024;
const TIMEOUT = 390_000;

export function validateBridgeConfig(value: unknown): BridgeConfig {
  const c = value as BridgeConfig;
  if (!c || typeof c.url !== "string" || typeof c.tokenEnv !== "string" || !/^JS_AGENT_RUNTIME_MCP_TOKEN_\d+$/u.test(c.tokenEnv)) throw new Error("Invalid MCP bridge configuration");
  const url = new URL(c.url);
  if (!/^https?:$/u.test(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || /[\s\\]/u.test(c.url)) throw new Error("Invalid MCP upstream URL");
  if (c.enabledTools !== undefined && (!Array.isArray(c.enabledTools) || c.enabledTools.some(name => typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(name)))) throw new Error("Invalid MCP tool policy");
  return c;
}

export class McpHttpBridge {
  private session?: string;
  private protocol?: string;
  private initialized = false;
  private sequence = 0;
  private known = new Set<string>();
  private active = new Map<string | number, AbortController>();
  private ready: Promise<unknown> = Promise.resolve();
  private redactor: ReturnType<typeof createRedactor>;
  constructor(private config: BridgeConfig, private token: string) { this.redactor = createRedactor([token]); }
  private sanitize(value: any, depth = 0): any {
    if (depth > 64) return "[TRUNCATED]";
    if (typeof value === "string") return this.redactor.text(value);
    if (Array.isArray(value)) return value.map(item => this.sanitize(item, depth + 1));
    // Preserve JSON Schema property names and types while removing known secrets
    // from descriptions, tool results and nested strings before native inference.
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.redactor.text(key), this.sanitize(item, depth + 1)]));
    return value;
  }
  private permitted(name: string): boolean { return this.config.enabledTools === undefined || this.config.enabledTools.includes(name); }
  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      ...(this.session ? { "Mcp-Session-Id": this.session } : {}), ...(this.protocol ? { "MCP-Protocol-Version": this.protocol } : {}) };
  }
  private async post(message: Rpc, signal: AbortSignal): Promise<Rpc | undefined> {
    const response = await fetch(this.config.url, { method: "POST", headers: this.headers(), body: JSON.stringify(message), redirect: "error", signal });
    if (!response.ok) { await response.body?.cancel(); throw new Error("MCP upstream request failed"); }
    if (message.method === "initialize") this.session = response.headers.get("mcp-session-id") ?? undefined;
    if (message.id === undefined || response.status === 202 || response.status === 204) { await response.body?.cancel(); return; }
    if (!response.body) throw new Error("Missing MCP upstream response");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    const sse = response.headers.get("content-type")?.includes("text/event-stream");
    let buffer = "", bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) throw new Error("MCP response exceeds size limit");
        buffer += decoder.decode(value, { stream: true });
        if (sse) {
          buffer = buffer.replace(/\r\n/gu, "\n");
          let split;
          while ((split = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, split); buffer = buffer.slice(split + 2);
            const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            const parsed = JSON.parse(data) as Rpc;
            if (parsed.id === message.id && ("result" in parsed || "error" in parsed)) return parsed;
          }
        }
      }
      if (!sse) {
        const parsed = JSON.parse(buffer + decoder.decode()) as Rpc;
        if (parsed.id === message.id && ("result" in parsed || "error" in parsed)) return parsed;
      }
      throw new Error("Invalid MCP upstream response");
    } finally { await reader.cancel().catch(() => {}); }
  }
  private async catalog(signal: AbortSignal): Promise<any[]> {
    const tools: any[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const reply = await this.post({ jsonrpc: "2.0", id: `runtime-list-${++this.sequence}`, method: "tools/list", params: cursor ? { cursor } : {} }, signal);
      if (!reply?.result || !Array.isArray(reply.result.tools)) throw new Error("Invalid MCP tool catalog");
      for (const tool of reply.result.tools) {
        if (typeof tool?.name !== "string" || tools.some(t => t.name === tool.name)) throw new Error("Invalid MCP tool catalog");
        tools.push(tool);
      }
      cursor = reply.result.nextCursor;
      if (cursor === undefined) { this.known = new Set(tools.map(t => t.name)); return tools.filter(t => this.permitted(t.name)); }
      if (typeof cursor !== "string" || cursors.has(cursor)) throw new Error("Invalid MCP catalog cursor");
      cursors.add(cursor);
    }
    throw new Error("MCP catalog exceeds page limit");
  }
  async handle(message: Rpc): Promise<Rpc | undefined> {
    const id = message.id;
    if (message.method === "notifications/cancelled") {
      const requestId = message.params?.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") this.active.get(requestId)?.abort();
      return;
    }
    if (id === undefined) {
      if (message.method === "notifications/initialized" && this.initialized) {
        this.ready = this.post({ jsonrpc: "2.0", method: message.method }, AbortSignal.timeout(5000)).catch(() => {});
        await this.ready;
      }
      return;
    }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT);
    if (this.active.has(id)) { clearTimeout(timer); return { jsonrpc: "2.0", id, error: { code: -32600, message: "Duplicate request ID" } }; }
    this.active.set(id, controller);
    try {
      let result: any;
      if (message.method === "initialize") {
        if (this.initialized) throw new Error("MCP already initialized");
        const reply = await this.post({ jsonrpc: "2.0", id, method: "initialize", params: {
          protocolVersion: message.params?.protocolVersion, capabilities: {}, clientInfo: { name: "js-agent-runtime", version: "0.2.3-mcp.1" },
        } }, controller.signal);
        if (!reply?.result?.protocolVersion) throw new Error("MCP initialization failed");
        this.protocol = reply.result.protocolVersion; this.initialized = true;
        result = { protocolVersion: this.protocol, capabilities: { tools: {} }, serverInfo: { name: "js-agent-runtime-mcp", version: "0.2.3-mcp.1" } };
      } else if (message.method === "ping") result = {};
      else {
        if (!this.initialized) throw new Error("MCP is not initialized");
        await this.ready;
        if (message.method === "tools/list") result = { tools: await this.catalog(controller.signal) };
        else if (message.method === "tools/call") {
          const name = message.params?.name;
          if (typeof name !== "string" || !this.permitted(name)) throw new Error("MCP tool is not allowed");
          if (!this.known.has(name)) await this.catalog(controller.signal);
          if (!this.known.has(name)) throw new Error("Unknown MCP tool");
          const reply = await this.post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: message.params?.arguments ?? {} } }, controller.signal);
          if (!reply || reply.error || !("result" in reply)) throw new Error("MCP tool request failed");
          result = reply.result;
        } else return { jsonrpc: "2.0", id, error: { code: -32601, message: "MCP method is not supported" } };
      }
      return { jsonrpc: "2.0", id, result: this.sanitize(result) };
    } catch {
      return { jsonrpc: "2.0", id, error: { code: -32000, message: controller.signal.aborted ? "MCP request cancelled or timed out" : "MCP request failed or denied" } };
    } finally { clearTimeout(timer); this.active.delete(id); }
  }
  async close(): Promise<void> {
    for (const request of this.active.values()) request.abort();
    if (this.session) await fetch(this.config.url, { method: "DELETE", headers: this.headers(), redirect: "error", signal: AbortSignal.timeout(2000) }).then(r => r.body?.cancel()).catch(() => {});
    this.session = undefined; this.token = "";
  }
}

async function main(): Promise<void> {
  const config = validateBridgeConfig(JSON.parse(process.argv[2] ?? "null"));
  const token = process.env[config.tokenEnv]; delete process.env[config.tokenEnv];
  if (!token || /[\r\n]/u.test(token)) throw new Error("Missing MCP credential");
  const bridge = new McpHttpBridge(config, token);
  let buffer = "", closing = false;
  const close = async () => { if (closing) return; closing = true; process.stdin.pause(); await bridge.close(); process.exit(0); };
  process.once("SIGTERM", () => { void close(); }); process.once("SIGINT", () => { void close(); });
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_BYTES) { void close(); return; }
    let split;
    while ((split = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as Rpc;
        if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") throw new Error();
        void bridge.handle(message).then(reply => { if (reply && !closing) process.stdout.write(JSON.stringify(reply) + "\n"); });
      } catch { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid MCP request" } }) + "\n"); }
    }
  });
  process.stdin.once("end", () => { void close(); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.stderr.write("MCP bridge failed\n"); process.exitCode = 1; });
