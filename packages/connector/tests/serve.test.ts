import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";

// serve.ts is the CLI entrypoint: it runs main() at module top-level, which
// validates the token, loads the catalog, builds the app, and binds a port.
// We mock @hono/node-server's serve() so no real socket is bound and the
// startup callback is invoked synchronously with a fixed port — letting us
// drive the entrypoint in-process (so v8 counts its coverage) without a
// listener leaking across tests. Each test resets the module cache and
// re-imports, since serve.ts has no exports and does its work on import.

const serveMock = vi.fn();

vi.mock("@hono/node-server", () => ({ serve: serveMock }));

const EXAMPLE = path.resolve(__dirname, "../../../examples/pr-quality");
const VALID_TOKEN = "test-token-minimum-16chars";

const ORIGINAL_TOKEN = process.env["AGENTPACK_CONNECTOR_TOKEN"];
const ORIGINAL_PORT = process.env["AGENTPACK_CONNECTOR_PORT"];
const ORIGINAL_ARGV = process.argv;

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("serve.ts entrypoint", () => {
  beforeEach(() => {
    serveMock.mockReset();
    vi.resetModules();
    process.argv = [process.argv[0]!, "serve.ts", EXAMPLE];
  });

  afterEach(() => {
    restoreEnv("AGENTPACK_CONNECTOR_TOKEN", ORIGINAL_TOKEN);
    restoreEnv("AGENTPACK_CONNECTOR_PORT", ORIGINAL_PORT);
    process.argv = ORIGINAL_ARGV;
    vi.restoreAllMocks();
  });

  it("binds the server and prints the startup banner with a valid token", async () => {
    process.env["AGENTPACK_CONNECTOR_TOKEN"] = VALID_TOKEN;
    process.env["AGENTPACK_CONNECTOR_PORT"] = "0";

    const banner: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      banner.push(String(chunk));
      return true;
    });
    // Invoke the listening callback the way @hono/node-server would.
    serveMock.mockImplementation(
      (_opts: unknown, cb?: (info: { port: number }) => void) => {
        cb?.({ port: 8787 });
        return { close: (fn?: (err?: Error) => void) => fn?.() };
      },
    );

    const mod = (await import("../src/serve.js")) as { ready: Promise<void> };
    await mod.ready;

    expect(serveMock).toHaveBeenCalledTimes(1);
    const opts = serveMock.mock.calls[0]![0] as { fetch: unknown; port: number };
    expect(typeof opts.fetch).toBe("function");
    expect(opts.port).toBe(0);

    const out = banner.join("");
    expect(out).toContain("agentpack connector for agentpack.pr-quality");
    expect(out).toContain("/mcp");
    expect(out).toContain("/healthz");
    // pr-quality carries terminal-only atoms that cannot be served remotely.
    expect(out).toContain("not carried (terminal-only)");
  });

  it("defaults the port to 8787 when AGENTPACK_CONNECTOR_PORT is unset", async () => {
    process.env["AGENTPACK_CONNECTOR_TOKEN"] = VALID_TOKEN;
    delete process.env["AGENTPACK_CONNECTOR_PORT"];

    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    serveMock.mockImplementation(
      (_opts: unknown, cb?: (info: { port: number }) => void) => {
        cb?.({ port: 8787 });
        return { close: (fn?: (err?: Error) => void) => fn?.() };
      },
    );

    const mod = (await import("../src/serve.js")) as { ready: Promise<void> };
    await mod.ready;

    expect(serveMock).toHaveBeenCalledTimes(1);
    const opts = serveMock.mock.calls[0]![0] as { port: number };
    expect(opts.port).toBe(8787);
  });

  it("fails closed (exit 1, no bind) when the token is missing", async () => {
    delete process.env["AGENTPACK_CONNECTOR_TOKEN"];

    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => undefined) as never);

    const mod = (await import("../src/serve.js")) as { ready: Promise<void> };
    await mod.ready;

    // The listener is never bound and the process is told to exit non-zero.
    expect(serveMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errors.join("")).toContain("agentpack-connector failed");
    expect(errors.join("")).toContain("AGENTPACK_CONNECTOR_TOKEN is not set");
  });

  it("fails closed (exit 1, no bind) when the token is too short", async () => {
    process.env["AGENTPACK_CONNECTOR_TOKEN"] = "short";

    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => undefined) as never);

    const mod = (await import("../src/serve.js")) as { ready: Promise<void> };
    await mod.ready;

    expect(serveMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errors.join("")).toContain("too short");
  });
});
