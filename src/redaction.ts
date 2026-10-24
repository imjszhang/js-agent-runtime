const sensitive = /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|secret|credential|credentials|client[-_]?secret)$/iu;
/** A per-run redactor. Secrets never enter serialized plan or result objects. */
export function createRedactor(secrets: string[] = []): { add(secret: string): void; text(value: string): string; value<T>(value: T): T } {
  const known = new Set<string>();
  const add = (secret: string): void => { if (secret) { known.add(secret); known.add(encodeURIComponent(secret)); known.add(Buffer.from(secret).toString("base64")); } };
  for (const secret of secrets) add(secret);
  const redactText = (value: string): string => {
    let result = value;
    for (const secret of [...known].sort((a, b) => b.length - a.length)) result = result.split(secret).join("[REDACTED]");
    return result
      .replace(/\bBearer\s+[^\s"'<>]+/giu, "Bearer [REDACTED]")
      .replace(/\bsk-[a-zA-Z0-9_-]{8,}/gu, "[REDACTED]")
      .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@")
      .replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)(?:["']?)\s*[=:]\s*["']?)([^\s,"';}]+)/giu, "$1[REDACTED]");
  };
  const visit = (value: unknown, depth = 0): unknown => {
    if (depth > 64) return "[TRUNCATED]";
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map(v => visit(v, depth + 1));
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sensitive.test(k) ? "[REDACTED]" : visit(v, depth + 1)]));
    return value;
  };
  return { add, text: redactText, value: <T>(value: T): T => visit(value) as T };
}
