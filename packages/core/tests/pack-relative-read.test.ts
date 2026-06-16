/**
 * Trust-boundary tests for readPackRelativeFile — the shared symlink-safe gate
 * every adapter uses for manifest-controlled pack-relative paths (prompt paths,
 * skill companion files). A malicious pack must not redirect a read to a file
 * outside the pack via a symlink (CWE-59 — commit security review on #40).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { readPackRelativeFile } from "../src/adapters/types.js";

let root: string;
let outside: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ap-pack-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "ap-secret-"));
  await fs.writeFile(path.join(outside, "secret.txt"), "TOP SECRET", "utf8");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe("readPackRelativeFile", () => {
  it("reads a real file inside the pack", async () => {
    await fs.writeFile(path.join(root, "prompt.md"), "hello", "utf8");
    expect(await readPackRelativeFile(root, "prompt.md")).toBe("hello");
  });

  it("reads a real file in a nested subdir", async () => {
    await fs.mkdir(path.join(root, "skills", "x"), { recursive: true });
    await fs.writeFile(path.join(root, "skills/x/body.md"), "nested", "utf8");
    expect(await readPackRelativeFile(root, "skills/x/body.md")).toBe("nested");
  });

  it("returns null for a symlink pointing OUTSIDE the pack (the exploit)", async () => {
    // A pack ships `leak.md` → /…/secret.txt. Following it would embed an
    // arbitrary host file into the exported/uploaded artifact.
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "leak.md"));
    expect(await readPackRelativeFile(root, "leak.md")).toBeNull();
  });

  it("returns null for a symlink even when it points INSIDE the pack", async () => {
    // Conservative: any symlink at the target is refused (matches readAtomFile).
    await fs.writeFile(path.join(root, "real.md"), "real", "utf8");
    await fs.symlink(path.join(root, "real.md"), path.join(root, "link.md"));
    expect(await readPackRelativeFile(root, "link.md")).toBeNull();
  });

  it("returns null for absolute, ~, and .. traversal paths", async () => {
    expect(await readPackRelativeFile(root, path.join(outside, "secret.txt"))).toBeNull();
    expect(await readPackRelativeFile(root, "~/secret.txt")).toBeNull();
    expect(await readPackRelativeFile(root, "../ap-secret/secret.txt")).toBeNull();
    expect(await readPackRelativeFile(root, "a/../../escape.txt")).toBeNull();
  });

  it("returns null for a missing file or a directory", async () => {
    await fs.mkdir(path.join(root, "adir"));
    expect(await readPackRelativeFile(root, "nope.md")).toBeNull();
    expect(await readPackRelativeFile(root, "adir")).toBeNull();
  });
});
