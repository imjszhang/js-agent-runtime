import path from "node:path";

const CURSOR_VERSION = "2026.07.23-e383d2b";
const CURSOR_BUNDLE_SHA256 = "39a3fbb76b3382d2ffa82f6a158f292ae4fe0ba06162795dcbbacde325ca9853";
const STALL_ANCHOR = "const n=null!==(t=be(null==e?void 0:e.failTimeoutMs))&&void 0!==t?t:3e4,r=be(null==e?void 0:e.advisoryTimeoutMs)";

type CursorRuntimePlan = {
  env: Record<string, string>;
  files: Array<{ path: string; content: string; mode?: 0o600 | 0o700 }>;
  compatibility: {
    id: string;
    version: string;
    sourceSha256: string;
    nativeStallTimeoutMs: number;
  };
};

/**
 * The pinned Cursor CLI resets its 30-second stall timer only after a complete
 * inbound protocol message. A large image frame can therefore be cancelled
 * while its bytes are still arriving. This opt-in preload changes that one
 * default in memory; it does not modify the installation, task deadline,
 * transport, model, permissions, or image data.
 *
 * Planning does not inspect an installation or start a process. At execution,
 * both the complete original bundle hash and the unique source anchor must
 * match before any native code runs. The adapter's independent version gate
 * remains required. Only the actual Cursor invocation receives this plan,
 * never metadata probes. Its files must be protected like the shell wrapper.
 */
export function planCursorRuntime(home: string, nativeStallTimeoutMs: number): CursorRuntimePlan {
  if (!path.isAbsolute(home) || /[\u0000-\u001f\u007f]/u.test(home)) throw new Error("Cursor Agent 临时 HOME 必须是绝对路径");
  if (!Number.isInteger(nativeStallTimeoutMs) || nativeStallTimeoutMs < 30_000 || nativeStallTimeoutMs > 300_000) {
    throw new Error("Cursor Agent nativeStallTimeoutMs 必须是 30000–300000 的整数");
  }
  const preload = path.join(path.resolve(home), "cursor-runtime", "preload.cjs");
  // NODE_OPTIONS is parsed by Node, not by a shell. Quoting the complete path
  // preserves spaces, quotes, and backslashes without inheriting other options.
  const nodeOption = `--require=${JSON.stringify(preload)}`;
  const replacement = STALL_ANCHOR.replace(":3e4,", `:${String(nativeStallTimeoutMs)},`);
  const id = `cursor-${CURSOR_VERSION}-stall-${String(nativeStallTimeoutMs)}-v1`;
  const content = [
    '"use strict";',
    "(() => {",
    '  const fs = require("node:fs");',
    '  const path = require("node:path");',
    '  const crypto = require("node:crypto");',
    '  const Module = require("node:module");',
    `  const expectedSha256 = ${JSON.stringify(CURSOR_BUNDLE_SHA256)};`,
    `  const anchor = ${JSON.stringify(STALL_ANCHOR)};`,
    `  const replacement = ${JSON.stringify(replacement)};`,
    `  const ownedNodeOption = ${JSON.stringify(nodeOption)};`,
    `  const compatibilityId = ${JSON.stringify(id)};`,
    '  const fail = (reason) => { throw new Error("Cursor runtime compatibility " + compatibilityId + ": " + reason); };',
    '  if (!process.argv[1] || path.basename(process.argv[1]) !== "index.js") fail("expected the pinned Cursor index.js entry point");',
    "  const entry = fs.realpathSync(process.argv[1]);",
    '  if (path.basename(entry) !== "index.js") fail("unexpected resolved entry point");',
    '  const originalLoader = Module._extensions[".js"];',
    '  if (typeof originalLoader !== "function") fail("JavaScript loader unavailable");',
    '  Module._extensions[".js"] = function cursorRuntimeLoader(module, filename) {',
    "    if (fs.realpathSync(filename) !== entry) return originalLoader(module, filename);",
    "    // Restore before validation/compilation, including all error paths, so",
    "    // native imports never run through a persistent loader interception.",
    '    Module._extensions[".js"] = originalLoader;',
    "    const bytes = fs.readFileSync(filename);",
    '    if (crypto.createHash("sha256").update(bytes).digest("hex") !== expectedSha256) fail("unrecognized bundle SHA-256; refusing to run");',
    '    const source = bytes.toString("utf8");',
    "    const position = source.indexOf(anchor);",
    '    if (position < 0 || source.indexOf(anchor, position + anchor.length) >= 0) fail("expected exactly one stall timeout anchor");',
    '    const options = process.env.NODE_OPTIONS || "";',
    "    const optionPosition = options.indexOf(ownedNodeOption);",
    "    const optionEnd = optionPosition + ownedNodeOption.length;",
    '    if (optionPosition < 0 || (optionPosition > 0 && !/\\s/u.test(options[optionPosition - 1])) || (optionEnd < options.length && !/\\s/u.test(options[optionEnd])) || options.indexOf(ownedNodeOption, optionEnd) >= 0) fail("preload option could not be removed safely");',
    "    const remainingOptions = (options.slice(0, optionPosition) + options.slice(optionEnd)).trim();",
    "    if (remainingOptions) process.env.NODE_OPTIONS = remainingOptions;",
    "    else delete process.env.NODE_OPTIONS;",
    "    module._compile(source.slice(0, position) + replacement + source.slice(position + anchor.length), filename);",
    "  };",
    "})();",
    "",
  ].join("\n");
  return {
    env: { NODE_OPTIONS: nodeOption },
    files: [{ path: preload, content, mode: 0o600 }],
    compatibility: { id, version: CURSOR_VERSION, sourceSha256: CURSOR_BUNDLE_SHA256, nativeStallTimeoutMs },
  };
}
