import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { absolute } from "./validation.js";
import type { Snapshot, SnapshotFile } from "./types.js";

export function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b, "en")).map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  const result = JSON.stringify(value); if (result === undefined) throw new Error("Value is not JSON serializable"); return result;
}
export function hashObject(value: unknown): string { return sha256(stableStringify(value)); }
/** Ignores credential and dependency directories; never follows symbolic links. */
export async function snapshotDirectory(root: string, options: { exclude?: string[]; maxFiles?: number; maxBytes?: number } = {}): Promise<Snapshot> {
  root = absolute(root, "snapshot root");
  const stat = await lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("snapshot root must be a real directory");
  const files: SnapshotFile[] = [];
  const ignored = new Set([".git", "node_modules", ".env", ...(options.exclude ?? [])]);
  let bytes = 0;
  async function visit(relative: string): Promise<void> {
    for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      if (ignored.has(key) || ignored.has(entry.name) || entry.name.startsWith(".env.")) continue;
      const file = path.join(root, key), s = await lstat(file);
      if (s.isSymbolicLink()) throw new Error(`Snapshot refuses symbolic link: ${key}`);
      if (s.isDirectory()) await visit(key);
      else if (s.isFile()) {
        bytes += s.size;
        if (files.length >= (options.maxFiles ?? 100_000) || bytes > (options.maxBytes ?? 1_073_741_824)) throw new Error("Snapshot limits exceeded");
        const data = await readFile(file);
        files.push({ path: key, sha256: sha256(data), size: data.byteLength, mode: s.mode & 0o777 });
      } else throw new Error(`Snapshot refuses special file: ${key}`);
    }
  }
  await visit("");
  return { schemaVersion: 1, sha256: hashObject(files), files };
}
