import * as fs from "node:fs/promises";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { TargetPlatform } from "../schema/types.js";
import type { HistoryEntryV1 } from "./types.js";
import type { AgentpackPaths } from "./paths.js";
import { canonicalJson, sha256Hex } from "./checksum.js";

const TARGETS = [
  "claude-code",
  "codex",
  "cursor",
  "chatgpt",
  "generic",
] as const satisfies readonly TargetPlatform[];

export const historyEntrySchema = z.object({
  id: z.string().min(1),
  action: z.enum([
    "install_begin",
    "install_commit",
    "install_rollback_recovery",
    "uninstall",
    "rollback",
  ]),
  timestamp: z.string().min(1),
  packId: z.string().min(1),
  packVersion: z.string().min(1),
  target: z.enum(TARGETS),
  profile: z.string().min(1),
  manifestPath: z.string().optional(),
  plannedFiles: z
    .array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }))
    .optional(),
  // Project-relative paths this install will CREATE fresh (no pre-existing
  // user file). Safe to unlink unconditionally on rollback. Optional for
  // backward compatibility with begin entries written before this field.
  createdPaths: z.array(z.string()).optional(),
  // Project-relative paths of pre-existing user files this install will
  // overwrite and therefore MUST be able to restore from backup on rollback.
  // A failed restore of any of these is a data-loss event, not a success.
  requiredBackups: z.array(z.string()).optional(),
  backupDir: z.string().optional(),
  rolledBackTo: z.string().optional(),
  recoveredBegin: z.string().optional(),
  actor: z.object({
    type: z.enum(["cli", "ci", "agent"]),
    id: z.string().optional(),
  }),
  result: z.enum(["success", "partial", "failed"]),
  error: z.string().optional(),
  previousEntryId: z.string(),
  entryChecksum: z.string().regex(/^[a-f0-9]{64}$/),
});

/**
 * Produce a sortable, monotonically-increasing ID. Crockford-Base32 ULID-like
 * (timestamp prefix + random). 26 chars for backwards compat with downstream
 * tools that expect ULID shape.
 */
export function newHistoryId(now: number = Date.now()): string {
  const tsHex = now.toString(16).padStart(12, "0").slice(-12);
  const rand = randomBytes(7).toString("hex").slice(0, 14);
  return (tsHex + rand).slice(0, 26);
}

/**
 * Compute the entry's `entryChecksum` — sha256(canonicalJson(entry minus
 * entryChecksum)). The function mutates `entry.entryChecksum` and returns
 * the entry.
 */
export function sealEntry(entry: HistoryEntryV1): HistoryEntryV1 {
  const sealed = { ...entry, entryChecksum: "" };
  const checksum = sha256Hex(canonicalJson(stripChecksum(sealed)));
  sealed.entryChecksum = checksum;
  return sealed;
}

function stripChecksum<T extends { entryChecksum: string }>(
  o: T,
): Omit<T, "entryChecksum"> {
  const { entryChecksum: _omit, ...rest } = o;
  return rest;
}

/**
 * Read every history entry. Returns an empty array if the file does not exist.
 * Lines that fail to parse are surfaced as errors (no silent skip).
 */
export async function readHistory(p: AgentpackPaths): Promise<HistoryEntryV1[]> {
  let raw: string;
  try {
    raw = await fs.readFile(p.historyFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const out: HistoryEntryV1[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `history.jsonl line ${i + 1} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const result = historyEntrySchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `history.jsonl line ${i + 1} failed schema validation: ${result.error.issues
          .map((iss) => iss.message)
          .join("; ")}`,
      );
    }
    out.push(result.data as HistoryEntryV1);
  }
  return out;
}

/**
 * Append a single entry to history.jsonl. **Concurrency-safe** via mtime
 * file lock — single-writer guarantee for the hash chain.
 *
 * Caller is responsible for filling in `previousEntryId` and `entryChecksum`
 * via `sealEntry()`; this function only writes.
 */
export async function appendHistoryEntry(
  p: AgentpackPaths,
  entry: HistoryEntryV1,
): Promise<void> {
  await withProjectLock(p, async () => {
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(p.historyFile, line, { encoding: "utf8" });
  });
}

const MAX_ERROR_LEN = 512;
// Strip C0 controls (except \t \n \r), DEL, C1 controls, and the unicode
// line/paragraph separators that some JSONL readers treat as line breaks.
// Built via RegExp constructor so the source file holds no literal control
// chars (which trip up some editors and diff tools).
// Allowed: TAB (U+0009), LF (U+000A), CR (U+000D). Everything else in C0/C1
// and the unicode line/paragraph separators is stripped.
const CONTROL_CHAR_RX = new RegExp(
  "[" +
    "\u0000-\u0008" +
    "\u000B\u000C" +
    "\u000E-\u001F" +
    "\u007F-\u009F" +
    "\u2028\u2029" +
    "]",
  "g",
);

/**
 * High-level: take a partial entry (no previousEntryId, no entryChecksum),
 * compute the chain pointer + checksum under lock, append, return the sealed
 * entry. This is the function callers use.
 *
 * Truncates `error` to MAX_ERROR_LEN bytes and strips C0/C1 control chars
 * (except \t \n \r) so an attacker-influenced error message cannot bloat or
 * smuggle data into the immortalized chain. See security-reviewer #5.
 */
export async function recordHistory(
  p: AgentpackPaths,
  partial: Omit<HistoryEntryV1, "previousEntryId" | "entryChecksum">,
): Promise<HistoryEntryV1> {
  return withProjectLock(p, async () => {
    const tail = await readHistoryTailUnlocked(p);
    const prevId = tail?.id ?? "";
    const sanitized = {
      ...partial,
      error: partial.error ? sanitizeError(partial.error) : partial.error,
    };
    const seeded: HistoryEntryV1 = sealEntry({
      ...sanitized,
      previousEntryId: prevId,
      entryChecksum: "",
    });
    const line = JSON.stringify(seeded) + "\n";
    await fs.appendFile(p.historyFile, line, { encoding: "utf8" });
    return seeded;
  });
}

function sanitizeError(s: string): string {
  const cleaned = s.replace(CONTROL_CHAR_RX, "");
  if (Buffer.byteLength(cleaned, "utf8") <= MAX_ERROR_LEN) return cleaned;
  return cleaned.slice(0, MAX_ERROR_LEN - 1) + "…";
}

async function readHistoryTailUnlocked(
  p: AgentpackPaths,
): Promise<HistoryEntryV1 | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(p.historyFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return undefined;
  const tail = lines[lines.length - 1];
  if (tail === undefined) return undefined;
  const parsed = historyEntrySchema.parse(JSON.parse(tail));
  return parsed as HistoryEntryV1;
}

/**
 * Verify the hash chain. Returns `{ ok: true }` if every entry's
 * `previousEntryId` matches the prior entry's id AND every entry's
 * `entryChecksum` matches sha256(canonicalJson(entry minus entryChecksum)).
 * Returns `{ ok: false, brokeAt }` on first failure.
 */
export function verifyChain(
  entries: readonly HistoryEntryV1[],
): { ok: true } | { ok: false; brokeAt: number; reason: string } {
  let expectedPrev = "";
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e === undefined) continue;
    if (e.previousEntryId !== expectedPrev) {
      return {
        ok: false,
        brokeAt: i,
        reason: `entry ${i} previousEntryId=\`${e.previousEntryId}\` expected \`${expectedPrev}\``,
      };
    }
    const recomputed = sha256Hex(canonicalJson(stripChecksum(e)));
    if (recomputed !== e.entryChecksum) {
      return {
        ok: false,
        brokeAt: i,
        reason: `entry ${i} entryChecksum mismatch (stored=${e.entryChecksum.slice(0, 12)}…, recomputed=${recomputed.slice(0, 12)}…)`,
      };
    }
    expectedPrev = e.id;
  }
  return { ok: true };
}

/**
 * mtime-based file lock with a nonce sentinel inside the lockdir. Acquires
 * by atomic mkdir; writes a random nonce; on stale-cleanup, re-reads the
 * nonce immediately before rmdir to confirm we're not stomping a freshly-
 * acquired lock (the classic "two-stale-cleaners" race the security audit
 * flagged in finding #4).
 *
 * Phase 2 ships with this hand-rolled lock to avoid the proper-lockfile
 * dependency in @agentpack/core. The contract is "single user, single host,
 * cooperative concurrent CLI invocations." Phase 3 may swap in
 * proper-lockfile if multi-host workflows arrive.
 */
/**
 * Per-async-context set of project roots whose lock is currently held by
 * the calling async flow. Reentrant within the same flow (so an outer
 * `applyInstall` can call inner `recordHistory` without deadlocking) but
 * NOT across independent async flows (concurrent `recordHistory` calls in
 * the same process still serialize through the on-disk mkdir). Same async
 * context = same logical request; different awaited Promises spawned in
 * parallel get independent stores.
 */
const LOCK_CTX = new AsyncLocalStorage<Set<string>>();

export async function withProjectLock<T>(
  p: AgentpackPaths,
  fn: () => Promise<T>,
): Promise<T> {
  const key = p.projectRoot;
  const inherited = LOCK_CTX.getStore();
  if (inherited && inherited.has(key)) {
    // Reentrant call within the same async flow — outer scope already
    // serialized; do NOT re-acquire the file lock (would deadlock).
    return await fn();
  }
  const held = new Set(inherited ?? []);
  held.add(key);
  return LOCK_CTX.run(held, () => withFileLock(p, fn));
}

async function withFileLock<T>(p: AgentpackPaths, fn: () => Promise<T>): Promise<T> {
  const lockDir = p.historyLockFile;
  const start = Date.now();
  const timeoutMs = 10_000;
  // A live holder heartbeats every HEARTBEAT_MS by touching its nonce file
  // (write same content, mtime updates). Stale detection waits 3× the
  // heartbeat interval to tolerate slow disk + scheduler jitter. Together,
  // a process that's actively working — even on a very long install —
  // cannot have its lock stolen, while a crashed holder is reclaimed in
  // bounded time. From codex P1 review (iter-5).
  const HEARTBEAT_MS = 5_000;
  const staleMs = HEARTBEAT_MS * 3 + 5_000; // 20s grace
  await fs.mkdir(p.agentpackDir, { recursive: true });
  let nonce = "";
  while (true) {
    try {
      await fs.mkdir(lockDir);
      nonce = randomBytes(8).toString("hex");
      await fs.writeFile(`${lockDir}/nonce`, nonce, "utf8");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        // Stale check reads the NONCE FILE's mtime, not the lockDir's.
        // The heartbeat refreshes the nonce file; writing to a child does
        // not bubble mtime to its parent dir on POSIX, so reading lockDir
        // would still see the original mkdir time and falsely declare the
        // lock stale. From codex P1 review (iter-5 round 4).
        const stat = await fs.stat(`${lockDir}/nonce`);
        if (Date.now() - stat.mtimeMs > staleMs) {
          // Read the nonce, then re-read it after a tiny pause. If both
          // reads agree, the holder is genuinely abandoned.
          const before = await fs.readFile(`${lockDir}/nonce`, "utf8").catch(() => "");
          await sleep(50);
          const after = await fs.readFile(`${lockDir}/nonce`, "utf8").catch(() => "");
          if (before === after) {
            await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
            continue;
          }
        }
      } catch {
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Could not acquire .agentpack/.lock within ${timeoutMs}ms — another agentpack CLI may be running.`,
        );
      }
      await sleep(50);
    }
  }
  // Heartbeat: re-write the nonce file every HEARTBEAT_MS so its mtime
  // stays current (this is the signal the stale-check above reads).
  // unref() so this timer doesn't keep the process alive after fn returns.
  const heartbeat = setInterval(() => {
    fs.writeFile(`${lockDir}/nonce`, nonce, "utf8").catch(() => {
      /* lock holder may have already been reclaimed; bail silently */
    });
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    // Only remove the lock if the nonce inside still matches the one we
    // wrote — otherwise another process has already acquired.
    try {
      const cur = await fs.readFile(`${lockDir}/nonce`, "utf8").catch(() => "");
      if (cur === nonce) {
        await fs.rm(lockDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore — nothing to do.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
