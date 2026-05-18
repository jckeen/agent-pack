import { createHash } from "node:crypto";

/**
 * Canonical JSON: recursively sort object keys, no whitespace, no trailing
 * newline. The output is the byte input to sha256 for hash-chain entries and
 * any other "checksum of a JSON shape" use case in this codebase.
 *
 * Anti-pattern check: do NOT use the default `JSON.stringify` directly — key
 * order is insertion-order which is fragile across writers (different node
 * versions, different ordering in tests vs. prod).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, canonicalReplacer(value), 0);
}

function canonicalReplacer(_root: unknown): (key: string, value: unknown) => unknown {
  return function (_key: string, val: unknown): unknown {
    if (val === null || typeof val !== "object") return val;
    if (Array.isArray(val)) return val;
    const out: Record<string, unknown> = {};
    const keys = Object.keys(val as Record<string, unknown>).sort();
    for (const k of keys) {
      out[k] = (val as Record<string, unknown>)[k];
    }
    return out;
  };
}

/**
 * sha256 of a UTF-8 string, hex lowercased.
 * The canonicalization spec pinned in the lockfile says encoding=utf-8.
 */
export function sha256Hex(input: string | Buffer): string {
  const h = createHash("sha256");
  h.update(input);
  return h.digest("hex");
}

/**
 * Normalize file content to LF line endings before hashing. Matches the
 * canonicalization spec in the lockfile. Trailing newline is preserved as-is
 * because adapter outputs already normalize the trailing newline.
 */
export function normalizeForHash(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

export function sha256OfFile(content: string): string {
  return sha256Hex(normalizeForHash(content));
}

/**
 * Sort an array of LockfileFileEntry-shaped objects deterministically. We sort
 * by path so the hash of the joined output is determinism-safe.
 */
export function sortByPath<T extends { path: string }>(arr: readonly T[]): T[] {
  return [...arr].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
