// Canonical JSON Schema parity (#166, #168): schemas/AGENTPACK.schema.json is
// what editors and registry clients validate against, so it must not approve
// manifests the runtime zod schema (agentpack.schema.ts) refuses. These tests
// pin the two findings from the #160 codex review:
//   - #166: an atom with BOTH `path` and `body`, or with `variants: {}` as its
//     only source, must be rejected (the runtime superRefine rejects both).
//   - #168: variant `path` entries obey the same trust rules as `atom.path`
//     (no `~`, no absolute paths, no `..` traversal, no Windows-reserved
//     names, no NUL) — the runtime routes them through `atomPathSchema`.
// Plus the #190 review follow-ups: `variants: {}` alongside a default
// `path`/`body` is runtime-valid and must stay schema-valid, and NUL-bearing
// paths are rejected by both validators.
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { agentPackManifestSchema } from "../src/index.js";

const SCHEMA_PATH = path.resolve(__dirname, "../../../schemas/AGENTPACK.schema.json");
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;

const ajv = new Ajv2020({ allErrors: true });
const validateJson = ajv.compile(schema);

function manifest(atomOverrides: Record<string, unknown>): Record<string, unknown> {
  return {
    agentpack: "1.0",
    metadata: {
      id: "agentpack.schema-parity",
      name: "Schema Parity Fixture",
      slug: "schema-parity",
      description: "In-memory manifest for canonical JSON schema tests.",
      version: "0.1.0",
      publisher: "agentpack",
    },
    compatibility: { targets: { generic: { status: "supported" } } },
    profiles: { full: { include: ["*"] } },
    atoms: [
      {
        id: "instruction:house-style",
        type: "instruction",
        name: "House Style",
        description: "A plain instruction atom.",
        risk_level: "low",
        ...atomOverrides,
      },
    ],
  };
}

/** Both validators must agree — the JSON schema may never be MORE permissive
 * than the runtime. (It may be less detailed, but these fixtures are cases
 * where divergence bit: schema-approved packs the CLI then refused.) */
function expectBoth(m: Record<string, unknown>, valid: boolean): void {
  expect(validateJson(m), JSON.stringify(validateJson.errors)).toBe(valid);
  expect(agentPackManifestSchema.safeParse(m).success).toBe(valid);
}

describe("canonical JSON schema — default source combinations (#166)", () => {
  it("accepts a plain path atom", () => {
    expectBoth(manifest({ path: "atoms/instructions/house-style.md" }), true);
  });

  it("accepts a body-only atom", () => {
    expectBoth(manifest({ body: "Inline body." }), true);
  });

  it("accepts a variant-only atom with at least one entry", () => {
    expectBoth(manifest({ variants: { codex: { body: "Codex body." } } }), true);
  });

  it("accepts a default path plus foreign-target variants", () => {
    expectBoth(
      manifest({
        path: "atoms/instructions/house-style.md",
        variants: { codex: { path: "atoms/instructions/house-style.codex.md" } },
      }),
      true,
    );
  });

  it("rejects an atom with both `path` and `body`", () => {
    expectBoth(
      manifest({ path: "atoms/instructions/house-style.md", body: "also inline" }),
      false,
    );
  });

  it("rejects a variant-only atom whose variants map is empty", () => {
    expectBoth(manifest({ variants: {} }), false);
  });

  it("accepts a default path with an empty variants map (runtime-valid, #190 review)", () => {
    // `variants: {}` is not a source, but the atom doesn't need it to be one
    // when a default `path` exists — the runtime superRefine accepts this, so
    // the JSON schema's minProperties must not fire unconditionally.
    expectBoth(manifest({ path: "atoms/instructions/house-style.md", variants: {} }), true);
  });

  it("accepts a body-only atom with an empty variants map", () => {
    expectBoth(manifest({ body: "Inline body.", variants: {} }), true);
  });

  it("rejects an atom with no source at all", () => {
    expectBoth(manifest({}), false);
  });

  it("rejects a variant that sets both `path` and `body`", () => {
    expectBoth(
      manifest({
        variants: { codex: { path: "atoms/instructions/x.md", body: "also inline" } },
      }),
      false,
    );
  });

  it("rejects a variant that sets neither `path` nor `body`", () => {
    expectBoth(manifest({ variants: { codex: {} } }), false);
  });
});

describe("canonical JSON schema — atom path trust rules on variant paths (#168)", () => {
  const badPaths = [
    "../outside.md",
    "atoms/../../outside.md",
    "/etc/passwd",
    "C:\\Windows\\system32\\drivers\\etc\\hosts",
    "~/dotfiles/CLAUDE.md",
    "",
    "atoms/CON.md",
    "atoms/nul/skill.md",
    // NUL truncates in C filesystem APIs — a path-smuggling primitive both
    // validators must reject (#190 review).
    "atoms/hou\u0000se.md",
    "atoms/skills\u0000/../../../etc/passwd",
  ];

  for (const bad of badPaths) {
    it(`rejects variant path ${JSON.stringify(bad)}`, () => {
      expectBoth(manifest({ variants: { codex: { path: bad } } }), false);
    });

    it(`rejects default atom path ${JSON.stringify(bad)}`, () => {
      expectBoth(manifest({ path: bad }), false);
    });
  }

  it("still accepts ordinary nested pack-relative paths", () => {
    expectBoth(
      manifest({
        variants: { "claude-code": { path: "atoms/skills/deploy/SKILL.md" } },
      }),
      true,
    );
  });

  it("accepts filenames that merely contain dots or reserved-looking substrings", () => {
    // "console.md" starts with "con" but is not the reserved basename;
    // "notes..md" contains ".." but not as a traversal segment.
    expectBoth(manifest({ path: "atoms/console.md" }), true);
    expectBoth(manifest({ path: "atoms/notes..md" }), true);
  });
});
