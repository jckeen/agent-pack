/**
 * Marker-block and JSON-config merge semantics.
 *
 * The BEGIN/END markers exist so packs can coexist with user-owned content
 * and with each other in shared files (CLAUDE.md, AGENTS.md). Before this
 * module, the planner treated every shared file as whole-file-owned: any
 * project that already had a CLAUDE.md hit a hard conflict, and two packs
 * could never share an instruction file — which broke the README's core
 * coexistence promise for every real-world project.
 *
 * Merge strategies:
 *  - "marker": the planned content is a single `<!-- BEGIN AGENTPACK: id -->`
 *    block. Merging appends the block to existing content (or replaces the
 *    pack's previous block in place). Uninstall removes only the span.
 *  - "json": the planned content is a JSON config fragment (hooks /
 *    mcpServers). Merging deep-adds our entries into the existing config.
 *    Uninstall removes only our entries.
 */

export interface MergeRecord {
  /** Project-relative path of the merged file. */
  path: string;
  strategy: "marker" | "json";
  /** The pack's contribution — the marker block or JSON fragment. */
  fragment: string;
  /** sha256(normalizeForHash(fragment)) — drift detection checks THIS. */
  fragmentSha256: string;
}

const beginMarker = (packId: string) =>
  new RegExp(`<!--\\s*BEGIN AGENTPACK:\\s*${escapeRe(packId)}\\s*-->`);
const endMarker = (packId: string) =>
  new RegExp(`<!--\\s*END AGENTPACK:\\s*${escapeRe(packId)}\\s*-->`);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the planned file content is a single AgentPack marker block. */
export function isMarkerBlock(content: string): boolean {
  return /^<!--\s*BEGIN AGENTPACK:/.test(content.trimStart());
}

/**
 * Extract this pack's marker span from a file. Returns null when the file
 * has no span for `packId`.
 */
export function extractMarkerSpan(
  content: string,
  packId: string,
): { before: string; span: string; after: string } | null {
  const beginM = beginMarker(packId).exec(content);
  if (!beginM || beginM.index === undefined) return null;
  const afterBegin = content.slice(beginM.index);
  const endM = endMarker(packId).exec(afterBegin);
  if (!endM || endM.index === undefined) return null;
  const spanEnd = beginM.index + endM.index + endM[0].length;
  return {
    before: content.slice(0, beginM.index),
    span: content.slice(beginM.index, spanEnd),
    after: content.slice(spanEnd),
  };
}

/**
 * Merge a planned marker block into existing file content. Replaces the
 * pack's previous span in place when present; otherwise appends the block
 * after the existing content.
 */
export function mergeMarkerFile(
  existing: string,
  plannedBlock: string,
  packId: string,
): string {
  const block = plannedBlock.trimEnd();
  const found = extractMarkerSpan(existing, packId);
  if (found) {
    const merged = `${found.before}${block}${found.after}`;
    return merged.endsWith("\n") ? merged : `${merged}\n`;
  }
  const base = existing.trimEnd();
  if (base === "") return `${block}\n`;
  return `${base}\n\n${block}\n`;
}

/**
 * Remove this pack's marker span. Returns the remaining content, or null
 * when the file had no span for the pack. An empty-after-removal file is
 * returned as "" — the caller decides whether to delete it.
 */
export function removeMarkerSpan(content: string, packId: string): string | null {
  const found = extractMarkerSpan(content, packId);
  if (!found) return null;
  const remainder = `${found.before.trimEnd()}\n\n${found.after.trimStart()}`.trim();
  return remainder === "" ? "" : `${remainder}\n`;
}

// ---------------------------------------------------------------------------
// JSON config merge
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const DUNDER_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * True when any object in the tree carries a prototype-pollution key.
 * Plain-object assignment (`out[k] = v` with k === "__proto__") would set
 * the prototype instead of an own property, silently dropping or polluting —
 * so configs containing these keys are REFUSED outright rather than mangled
 * (codex re-review P1-4).
 */
function hasDunderKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasDunderKeys);
  if (value && typeof value === "object") {
    for (const k of Object.getOwnPropertyNames(value)) {
      if (DUNDER_KEYS.has(k)) return true;
      if (hasDunderKeys((value as Json)[k])) return true;
    }
  }
  return false;
}

function parseJsonObject(raw: string): Json | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    if (hasDunderKeys(v)) return null;
    return v as Json;
  } catch {
    return null;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    // Null-prototype object: assignment can never hit a setter or mutate
    // the prototype chain, whatever the key is.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const k of Object.keys(value as Json).sort()) {
      out[k] = sortKeys((value as Json)[k]);
    }
    return out;
  }
  return value;
}

function stringifyConfig(value: Json): string {
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}

export type JsonMergeResult =
  | { ok: true; merged: string }
  | { ok: false; collisions: string[] }
  | { ok: false; invalidJson: true };

/**
 * Merge our JSON fragment into an existing JSON config.
 *
 *  - `hooks.<Event>` arrays: our entries are appended (deep-equal duplicates
 *    skipped). Entries from `priorFragment` (a previous install of this pack)
 *    are removed first, so re-installs replace rather than accumulate.
 *  - Object maps (`mcpServers`): our keys are added. A key that already
 *    exists with different content and is NOT owned by our prior fragment is
 *    a collision.
 *  - Scalar/other keys: set when absent; collision when present and different.
 */
export function mergeJsonConfig(
  existingRaw: string,
  fragmentRaw: string,
  priorFragmentRaw?: string,
): JsonMergeResult {
  const existing = parseJsonObject(existingRaw);
  const fragment = parseJsonObject(fragmentRaw);
  if (!existing || !fragment) return { ok: false, invalidJson: true };
  const prior = priorFragmentRaw ? parseJsonObject(priorFragmentRaw) : null;

  // Start from existing minus our prior contribution.
  const base = prior ? removeFragment(existing, prior) : existing;
  const collisions: string[] = [];

  for (const [key, fragVal] of Object.entries(fragment)) {
    const curVal = base[key];
    if (key === "hooks" && isObj(fragVal)) {
      const cur = isObj(curVal) ? (curVal as Json) : {};
      const out: Json = { ...cur };
      for (const [evt, entries] of Object.entries(fragVal as Json)) {
        const curList = Array.isArray(out[evt]) ? (out[evt] as unknown[]) : [];
        const addList = Array.isArray(entries) ? entries : [];
        const next = [...curList];
        for (const e of addList) {
          if (!next.some((x) => deepEqual(x, e))) next.push(e);
        }
        out[evt] = next;
      }
      base[key] = out;
    } else if (isObj(fragVal)) {
      const cur = isObj(curVal) ? (curVal as Json) : curVal === undefined ? {} : null;
      if (cur === null) {
        collisions.push(key);
        continue;
      }
      const out: Json = { ...cur };
      for (const [name, val] of Object.entries(fragVal as Json)) {
        if (name in out && !deepEqual(out[name], val)) {
          collisions.push(`${key}.${name}`);
          continue;
        }
        out[name] = val;
      }
      base[key] = out;
    } else {
      if (curVal !== undefined && !deepEqual(curVal, fragVal)) {
        collisions.push(key);
        continue;
      }
      base[key] = fragVal;
    }
  }
  if (collisions.length > 0) return { ok: false, collisions };
  return { ok: true, merged: stringifyConfig(base) };
}

/**
 * Remove our fragment's entries from the current config. Returns the
 * remaining config serialized, "" when nothing remains, or null when the
 * current content is not valid JSON.
 */
export function removeJsonFragment(currentRaw: string, fragmentRaw: string): string | null {
  const current = parseJsonObject(currentRaw);
  const fragment = parseJsonObject(fragmentRaw);
  if (!current || !fragment) return null;
  const out = removeFragment(current, fragment);
  if (Object.keys(out).length === 0) return "";
  return stringifyConfig(out);
}

/**
 * True when every entry of our fragment is still present (deep-equal) in the
 * current config — the fragment-level "no drift" check for json merges.
 */
export function jsonFragmentIntact(currentRaw: string, fragmentRaw: string): boolean {
  const current = parseJsonObject(currentRaw);
  const fragment = parseJsonObject(fragmentRaw);
  if (!current || !fragment) return false;
  for (const [key, fragVal] of Object.entries(fragment)) {
    const curVal = current[key];
    if (key === "hooks" && isObj(fragVal)) {
      if (!isObj(curVal)) return false;
      for (const [evt, entries] of Object.entries(fragVal as Json)) {
        const curList = Array.isArray((curVal as Json)[evt])
          ? ((curVal as Json)[evt] as unknown[])
          : [];
        for (const e of Array.isArray(entries) ? entries : []) {
          if (!curList.some((x) => deepEqual(x, e))) return false;
        }
      }
    } else if (isObj(fragVal)) {
      if (!isObj(curVal)) return false;
      for (const [name, val] of Object.entries(fragVal as Json)) {
        if (!deepEqual((curVal as Json)[name], val)) return false;
      }
    } else if (!deepEqual(curVal, fragVal)) {
      return false;
    }
  }
  return true;
}

function removeFragment(current: Json, fragment: Json): Json {
  const out: Json = {};
  for (const [key, curVal] of Object.entries(current)) {
    const fragVal = fragment[key];
    if (fragVal === undefined) {
      out[key] = curVal;
      continue;
    }
    if (key === "hooks" && isObj(fragVal) && isObj(curVal)) {
      const events: Json = {};
      for (const [evt, curList] of Object.entries(curVal as Json)) {
        const fragList = (fragVal as Json)[evt];
        if (!Array.isArray(curList) || !Array.isArray(fragList)) {
          if (curList !== undefined) events[evt] = curList;
          continue;
        }
        const remaining = curList.filter((x) => !fragList.some((e) => deepEqual(x, e)));
        if (remaining.length > 0) events[evt] = remaining;
      }
      if (Object.keys(events).length > 0) out[key] = events;
    } else if (isObj(fragVal) && isObj(curVal)) {
      const rest: Json = {};
      for (const [name, val] of Object.entries(curVal as Json)) {
        const fv = (fragVal as Json)[name];
        if (fv !== undefined && deepEqual(fv, val)) continue;
        rest[name] = val;
      }
      if (Object.keys(rest).length > 0) out[key] = rest;
    } else if (!deepEqual(curVal, fragVal)) {
      out[key] = curVal;
    }
  }
  return out;
}

function isObj(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Paths the planner treats as JSON-mergeable configs. */
export const JSON_MERGE_PATHS = new Set([
  ".claude/settings.json",
  ".mcp.json",
  ".cursor/mcp.json",
  ".codex/hooks.json",
]);
