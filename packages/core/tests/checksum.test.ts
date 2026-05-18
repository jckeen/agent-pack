import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { canonicalJson, sha256Hex, normalizeForHash, sortByPath } from "../src/install/checksum.js";

describe("canonicalJson", () => {
  it("recursively sorts object keys", () => {
    const a = canonicalJson({ b: 1, a: { d: 4, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 4 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("handles nested arrays of objects", () => {
    const out = canonicalJson([{ z: 1, a: 2 }, { b: 3 }]);
    expect(out).toBe('[{"a":2,"z":1},{"b":3}]');
  });

  it("handles null + primitives", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson("hello")).toBe('"hello"');
    expect(canonicalJson(42)).toBe("42");
  });
});

describe("sha256Hex", () => {
  it("returns 64-hex-char lowercase digest", () => {
    const h = sha256Hex("hello");
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(h).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("matches openssl/coreutils sha256", () => {
    const content = "the quick brown fox";
    const ourHash = sha256Hex(content);
    const sysHash = execSync(`printf '%s' "${content}" | sha256sum`)
      .toString()
      .split(/\s+/)[0];
    expect(ourHash).toBe(sysHash);
  });
});

describe("normalizeForHash", () => {
  it("converts CRLF → LF before hashing", () => {
    const a = sha256Hex(normalizeForHash("a\r\nb\r\nc"));
    const b = sha256Hex(normalizeForHash("a\nb\nc"));
    expect(a).toBe(b);
  });
});

describe("sortByPath", () => {
  it("sorts deterministically", () => {
    const arr = [{ path: "z" }, { path: "a" }, { path: "m" }];
    expect(sortByPath(arr).map((x) => x.path)).toEqual(["a", "m", "z"]);
  });

  it("does not mutate input", () => {
    const arr = [{ path: "z" }, { path: "a" }];
    sortByPath(arr);
    expect(arr.map((x) => x.path)).toEqual(["z", "a"]);
  });
});
