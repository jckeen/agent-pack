// Pure parser for CLAUDE.md / AGENTS.md instruction files. No I/O.
//
// Splits a Markdown instruction document into top-level `## ` sections, with a
// fence-aware line scan so a `##` inside a fenced code block is never treated
// as a section boundary. The leading `# ` title (before any `##`) is captured
// separately and is NOT emitted as a section. Body text between the `# ` title
// and the first `## ` section (the "preamble") is captured as a synthetic
// leading section so no content is silently dropped. YAML frontmatter is
// stripped and `@import` directives are surfaced as warnings (they cannot be
// represented as pack atoms — the imported pack is self-contained).

export interface ParsedSection {
  /** The `## ` heading text (without the leading `## `). */
  heading: string;
  /** The raw markdown body of the section (everything after the heading line). */
  body: string;
  /** Heading depth — always 2 for top-level sections. */
  level: number;
  /** 1-based line number of the heading in the (frontmatter-stripped) text. */
  lineStart: number;
}

export interface ParseWarning {
  /** 1-based line number in the original input text. */
  line: number;
  message: string;
}

export interface ParsedClaudeMd {
  /** The leading `# ` title, or null if the document has none. */
  title: string | null;
  sections: ParsedSection[];
  warnings: ParseWarning[];
}

const FENCE_RE = /^\s*(```+|~~~+)/;
const IMPORT_RE = /^@\S/;

/**
 * Strip a leading YAML frontmatter block delimited by `---`. Returns the body
 * after the closing `---` plus the number of lines removed (so downstream line
 * numbers can be reported against the original input where it matters).
 */
function stripFrontmatter(lines: string[]): { body: string[]; offset: number } {
  if (lines.length === 0 || lines[0]!.trim() !== "---") {
    return { body: lines, offset: 0 };
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      return { body: lines.slice(i + 1), offset: i + 1 };
    }
  }
  // No closing delimiter — treat the whole thing as body (don't swallow it).
  return { body: lines, offset: 0 };
}

export function parseClaudeMd(text: string): ParsedClaudeMd {
  const warnings: ParseWarning[] = [];
  const rawLines = text.split(/\r?\n/);
  const { body: lines, offset } = stripFrontmatter(rawLines);

  let title: string | null = null;
  let inFence: string | null = null; // the fence marker that opened the block

  // First pass: detect the title (first `# ` before any `##`), collecting
  // section boundaries with fence awareness.
  interface Boundary {
    heading: string;
    lineStart: number; // 1-based, within `lines`
  }
  const boundaries: Boundary[] = [];
  const bodyLines: (string | null)[] = []; // null = line removed (@import)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const marker = fenceMatch[1]!.startsWith("`") ? "```" : "~~~";
      if (inFence === null) {
        inFence = marker;
      } else if (inFence === marker) {
        inFence = null;
      }
      bodyLines.push(line);
      continue;
    }

    if (inFence === null) {
      // `@import` directive — warn + strip from the body.
      if (IMPORT_RE.test(line)) {
        warnings.push({
          line: offset + i + 1,
          message: `@import directive dropped (not representable as an atom): ${line.trim()}`,
        });
        bodyLines.push(null);
        continue;
      }

      // Title: first `# ` that we haven't already claimed, and only before any
      // `## ` section has opened.
      if (title === null && boundaries.length === 0 && /^#\s+\S/.test(line)) {
        title = line.replace(/^#\s+/, "").trim();
        bodyLines.push(null);
        continue;
      }

      // Top-level section boundary.
      if (/^##\s+\S/.test(line)) {
        boundaries.push({
          heading: line.replace(/^##\s+/, "").trim(),
          lineStart: i + 1,
        });
        bodyLines.push(line);
        continue;
      }
    }

    bodyLines.push(line);
  }

  // Capture the preamble: lines between the title and the first `## ` boundary.
  // bodyLines[i] is null for stripped lines (title, @import); the preamble
  // occupies indices 0..(boundaries[0].lineStart - 2) inclusive (0-based), i.e.
  // all bodyLines before the first `##` heading line.
  const preambleEnd =
    boundaries.length > 0 ? boundaries[0]!.lineStart - 1 : bodyLines.length;
  const preambleText = bodyLines
    .slice(0, preambleEnd)
    .filter((l): l is string => l !== null)
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");

  // Second pass: slice bodies between boundaries.
  const sections: ParsedSection[] = [];

  // Synthetic leading section for preamble text, so no content is silently
  // dropped. Use the document title as the heading; fall back to "Overview".
  if (preambleText.length > 0) {
    sections.push({
      heading: title ?? "Overview",
      body: preambleText,
      level: 2,
      lineStart: offset + 1,
    });
  }

  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b]!.lineStart; // 1-based index of heading line
    const end = b + 1 < boundaries.length ? boundaries[b + 1]!.lineStart - 1 : lines.length;
    // Body is the lines AFTER the heading line, up to (not including) the next
    // heading. Drop @import-removed lines (null), preserve everything else.
    const slice = bodyLines
      .slice(start, end)
      .filter((l): l is string => l !== null)
      .join("\n")
      .replace(/^\n+/, "")
      .replace(/\s+$/, "");
    sections.push({
      heading: boundaries[b]!.heading,
      body: slice,
      level: 2,
      lineStart: offset + start,
    });
  }

  return { title, sections, warnings };
}
