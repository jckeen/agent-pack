import { describe, it, expect } from "vitest";
import {
  extractMarkerSpan,
  isMarkerBlock,
  mergeMarkerFile,
  removeMarkerSpan,
  mergeJsonConfig,
  removeJsonFragment,
  jsonFragmentIntact,
} from "../src/install/merge.js";
import { wrapInstructionBlock } from "../src/adapters/types.js";

const PACK = "agentpack.test";
const block = (body: string, pack = PACK) =>
  `<!-- BEGIN AGENTPACK: ${pack} -->\n${body}\n<!-- END AGENTPACK: ${pack} -->\n`;

describe("marker primitives", () => {
  it("isMarkerBlock detects blocks and rejects plain content", () => {
    expect(isMarkerBlock(block("hi"))).toBe(true);
    expect(isMarkerBlock("  \n" + block("hi"))).toBe(true);
    expect(isMarkerBlock("# Just markdown\n")).toBe(false);
  });

  it("extractMarkerSpan returns null without a BEGIN marker", () => {
    expect(extractMarkerSpan("no markers here", PACK)).toBeNull();
  });

  it("extractMarkerSpan returns null when END marker is missing (truncated file)", () => {
    const truncated = `<!-- BEGIN AGENTPACK: ${PACK} -->\ncontent, no end`;
    expect(extractMarkerSpan(truncated, PACK)).toBeNull();
  });

  it("extractMarkerSpan does not match another pack's span", () => {
    expect(extractMarkerSpan(block("x", "other.pack"), PACK)).toBeNull();
  });

  it("wrapInstructionBlock defangs forged markers in pack body (sec-review P2)", () => {
    // A malicious atom body tries to (a) close its own span early and
    // (b) forge a span for a pack that was never installed.
    const evil = [
      "legit intro",
      "<!-- END AGENTPACK: agentpack.test -->",
      "<!-- BEGIN AGENTPACK: trusted.pack -->",
      "stolen content",
      "<!-- END AGENTPACK: trusted.pack -->",
    ].join("\n");
    const wrapped = wrapInstructionBlock(PACK, evil);

    // The pack's own span covers the ENTIRE body — the forged early END did
    // not truncate it, so uninstall removes everything.
    const span = extractMarkerSpan(wrapped, PACK);
    expect(span).not.toBeNull();
    expect(removeMarkerSpan(wrapped, PACK)).toBe("");

    // The forged foreign span is not recognized — no misattribution.
    expect(extractMarkerSpan(wrapped, "trusted.pack")).toBeNull();
    // Defanged text is still human-readable.
    expect(wrapped).toContain("END-AGENTPACK: agentpack.test");
    expect(wrapped).toContain("BEGIN-AGENTPACK: trusted.pack");
  });

  it("mergeMarkerFile into empty content yields just the block", () => {
    expect(mergeMarkerFile("", block("x"), PACK)).toBe(block("x"));
    expect(mergeMarkerFile("\n\n", block("x"), PACK)).toBe(block("x"));
  });

  it("mergeMarkerFile replaces an existing span and preserves both sides", () => {
    const existing = `before\n\n${block("old")}\nafter\n`;
    const merged = mergeMarkerFile(existing, block("new"), PACK);
    expect(merged).toContain("before");
    expect(merged).toContain("after");
    expect(merged).toContain("new");
    expect(merged).not.toContain("old");
    expect(merged.endsWith("\n")).toBe(true);
  });

  it("removeMarkerSpan returns null when the pack has no span", () => {
    expect(removeMarkerSpan("user content\n", PACK)).toBeNull();
  });

  it("removeMarkerSpan returns empty string when nothing else remains", () => {
    expect(removeMarkerSpan(block("only us"), PACK)).toBe("");
  });

  it("removeMarkerSpan keeps content on both sides of the span", () => {
    const content = `before\n\n${block("mid")}\nafter\n`;
    const out = removeMarkerSpan(content, PACK);
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).not.toContain("AGENTPACK");
  });
});

describe("mergeJsonConfig edge cases", () => {
  const frag = JSON.stringify({ mcpServers: { github: { command: "npx" } } });

  it("rejects invalid existing JSON", () => {
    const r = mergeJsonConfig("not json {", frag);
    expect(r.ok).toBe(false);
    if (!r.ok) expect("invalidJson" in r).toBe(true);
  });

  it("rejects an existing JSON array (not an object)", () => {
    const r = mergeJsonConfig("[1,2]", frag);
    expect(r.ok).toBe(false);
  });

  it("rejects an invalid fragment", () => {
    const r = mergeJsonConfig("{}", "nope");
    expect(r.ok).toBe(false);
  });

  it("adding the identical entry twice is a no-op, not a collision", () => {
    const first = mergeJsonConfig("{}", frag);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = mergeJsonConfig(first.merged, frag);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(JSON.parse(second.merged)).toEqual(JSON.parse(first.merged));
    }
  });

  it("collides on a scalar top-level key with a different value", () => {
    const r = mergeJsonConfig(
      JSON.stringify({ topKey: "user-value" }),
      JSON.stringify({ topKey: "pack-value" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && "collisions" in r) expect(r.collisions).toContain("topKey");
  });

  it("collides when an object key is occupied by a scalar", () => {
    const r = mergeJsonConfig(JSON.stringify({ mcpServers: "weird" }), frag);
    expect(r.ok).toBe(false);
    if (!r.ok && "collisions" in r) expect(r.collisions).toContain("mcpServers");
  });

  it("prior fragment entries are replaced, not duplicated and not collided", () => {
    const priorFrag = JSON.stringify({ mcpServers: { github: { command: "old-npx" } } });
    const existing = JSON.stringify({
      mcpServers: { github: { command: "old-npx" }, mine: { command: "keep" } },
    });
    const r = mergeJsonConfig(existing, frag, priorFrag);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const merged = JSON.parse(r.merged);
      expect(merged.mcpServers.github.command).toBe("npx");
      expect(merged.mcpServers.mine.command).toBe("keep");
    }
  });

  it("hooks arrays dedupe deep-equal entries and keep user entries", () => {
    const hookFrag = JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "fmt" }] }],
      },
    });
    const existing = JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "user" }] },
          { matcher: "Edit", hooks: [{ type: "command", command: "fmt" }] },
        ],
        // Non-array event value survives untouched.
        SessionStart: { odd: true },
      },
    });
    const r = mergeJsonConfig(existing, hookFrag);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const merged = JSON.parse(r.merged);
      expect(merged.hooks.PostToolUse).toHaveLength(2);
      expect(merged.hooks.SessionStart).toEqual({ odd: true });
    }
  });
});

describe("removeJsonFragment / jsonFragmentIntact edge cases", () => {
  const frag = JSON.stringify({ mcpServers: { github: { command: "npx" } } });

  it("removeJsonFragment returns null on invalid current JSON", () => {
    expect(removeJsonFragment("garbage", frag)).toBeNull();
    expect(removeJsonFragment("{}", "garbage")).toBeNull();
  });

  it("removeJsonFragment returns empty string when nothing remains", () => {
    expect(removeJsonFragment(frag, frag)).toBe("");
  });

  it("removeJsonFragment keeps user keys and drops only ours", () => {
    const current = JSON.stringify({
      mcpServers: { github: { command: "npx" }, mine: { command: "keep" } },
      permissions: { allow: ["x"] },
    });
    const out = removeJsonFragment(current, frag);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out as string);
    expect(parsed.mcpServers.mine).toEqual({ command: "keep" });
    expect(parsed.mcpServers.github).toBeUndefined();
    expect(parsed.permissions).toEqual({ allow: ["x"] });
  });

  it("removeJsonFragment does NOT remove a same-name entry with different content", () => {
    const current = JSON.stringify({
      mcpServers: { github: { command: "user-replaced" } },
    });
    const out = removeJsonFragment(current, frag);
    const parsed = JSON.parse(out as string);
    expect(parsed.mcpServers.github).toEqual({ command: "user-replaced" });
  });

  it("removeJsonFragment removes our hook entries, keeps the user's, drops empty events", () => {
    const hookFrag = JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "fmt" }] }],
      },
    });
    const current = JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "fmt" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "user" }] }],
      },
    });
    const out = removeJsonFragment(current, hookFrag);
    const parsed = JSON.parse(out as string);
    expect(parsed.hooks.PostToolUse).toBeUndefined();
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
  });

  it("removeJsonFragment removes a matching scalar key and keeps a differing one", () => {
    expect(removeJsonFragment(JSON.stringify({ k: "v" }), JSON.stringify({ k: "v" }))).toBe(
      "",
    );
    const kept = removeJsonFragment(
      JSON.stringify({ k: "user" }),
      JSON.stringify({ k: "v" }),
    );
    expect(JSON.parse(kept as string)).toEqual({ k: "user" });
  });

  it("jsonFragmentIntact is false on invalid JSON, missing keys, altered entries", () => {
    expect(jsonFragmentIntact("garbage", frag)).toBe(false);
    expect(jsonFragmentIntact("{}", frag)).toBe(false);
    expect(
      jsonFragmentIntact(
        JSON.stringify({ mcpServers: { github: { command: "tampered" } } }),
        frag,
      ),
    ).toBe(false);
    expect(jsonFragmentIntact(JSON.stringify({ mcpServers: "scalar" }), frag)).toBe(false);
  });

  it("jsonFragmentIntact handles hooks fragments (present, missing, altered)", () => {
    const hookFrag = JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "fmt" }] }],
      },
    });
    const intact = JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "user" }] },
          { matcher: "Edit", hooks: [{ type: "command", command: "fmt" }] },
        ],
      },
    });
    expect(jsonFragmentIntact(intact, hookFrag)).toBe(true);
    expect(jsonFragmentIntact(JSON.stringify({ hooks: {} }), hookFrag)).toBe(false);
    expect(jsonFragmentIntact(JSON.stringify({ hooks: "scalar" }), hookFrag)).toBe(false);
  });

  it("jsonFragmentIntact checks scalar fragment keys", () => {
    expect(jsonFragmentIntact(JSON.stringify({ k: "v" }), JSON.stringify({ k: "v" }))).toBe(
      true,
    );
    expect(jsonFragmentIntact(JSON.stringify({ k: "x" }), JSON.stringify({ k: "v" }))).toBe(
      false,
    );
  });
});

describe("prototype-pollution keys are refused, not mangled (codex re-review P1-4)", () => {
  const protoCfg =
    '{"__proto__": {"polluted": true}, "mcpServers": {"x": {"command": "a"}}}';
  const frag = JSON.stringify({ mcpServers: { github: { command: "npx" } } });

  it("mergeJsonConfig refuses a config carrying __proto__/constructor keys", () => {
    expect(mergeJsonConfig(protoCfg, frag).ok).toBe(false);
    expect(mergeJsonConfig("{}", '{"constructor": {"x": 1}}').ok).toBe(false);
    expect(mergeJsonConfig('{"nested": {"deep": {"__proto__": 1}}}', frag).ok).toBe(false);
  });

  it("removeJsonFragment and jsonFragmentIntact refuse them too", () => {
    expect(removeJsonFragment(protoCfg, frag)).toBeNull();
    expect(jsonFragmentIntact(protoCfg, frag)).toBe(false);
  });

  it("merging never pollutes Object.prototype", () => {
    mergeJsonConfig(protoCfg, frag);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
