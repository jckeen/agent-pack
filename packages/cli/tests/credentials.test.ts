import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearCredentials,
  credentialsPath,
  getToken,
  maskToken,
  readCredentials,
  writeCredentials,
} from "../src/lib/credentials.js";

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wgcli-creds-"));
  process.env.WORKGRAPH_HOME = tmpDir;
  delete process.env.WORKGRAPH_TOKEN;
});
afterEach(async () => {
  delete process.env.WORKGRAPH_HOME;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("credentials", () => {
  it("credentialsPath resolves inside WORKGRAPH_HOME", () => {
    expect(credentialsPath()).toBe(path.join(tmpDir, "credentials.json"));
  });

  it("readCredentials returns empty object when file absent", async () => {
    const c = await readCredentials();
    expect(c).toEqual({ registries: {} });
  });

  it("roundtrips writeCredentials → readCredentials", async () => {
    await writeCredentials("https://r.example.com", {
      token: "wgp_live_" + "a".repeat(32),
      scopes: ["read:packs"],
      username: "alice",
    });
    const c = await readCredentials();
    expect(c.registries["https://r.example.com"]?.username).toBe("alice");
  });

  it("sets 0o600 mode on POSIX", async () => {
    if (process.platform === "win32") return;
    await writeCredentials("https://r.example.com", {
      token: "wgp_live_" + "a".repeat(32),
      scopes: ["read:packs"],
      username: "alice",
    });
    const stat = await fs.stat(credentialsPath());
    // Mode includes file-type bits; mask down to permissions.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("clearCredentials removes the registry entry", async () => {
    await writeCredentials("https://r.example.com", {
      token: "wgp_live_" + "b".repeat(32),
      scopes: [],
      username: "bob",
    });
    await clearCredentials("https://r.example.com");
    const c = await readCredentials();
    expect(c.registries["https://r.example.com"]).toBeUndefined();
  });

  it("getToken honors WORKGRAPH_TOKEN env override", async () => {
    process.env.WORKGRAPH_TOKEN = "wgp_live_envoverride000000000000000000";
    const t = await getToken("https://r.example.com");
    expect(t).toBe("wgp_live_envoverride000000000000000000");
  });

  it("getToken returns null when not logged in and no env", async () => {
    const t = await getToken("https://r.example.com");
    expect(t).toBeNull();
  });

  it("maskToken hides the body", () => {
    const t = "wgp_live_" + "a".repeat(28) + "1234";
    const m = maskToken(t);
    expect(m).toMatch(/^wgp_live_aaa…1234$/);
  });
});
