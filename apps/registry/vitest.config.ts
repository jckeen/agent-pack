import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Gate only the security-load-bearing server code. The React UI
      // (pages/components, *.tsx) is covered by build + manual/e2e checks, not
      // vitest unit tests — including it would make the % a meaningless,
      // brittle floor (Issue #25). lib/auth.ts and the NextAuth handler are
      // framework-wiring exercised at runtime, not unit-testable in isolation.
      include: ["app/api/**/*.ts", "lib/**/*.ts"],
      exclude: ["lib/auth.ts", "lib/seed.ts", "app/api/auth/**"],
      reporter: ["text", "json-summary"],
      // Conservative floors set BELOW the achieved baseline so the gains are
      // locked without being brittle. Raise as more routes get covered; the
      // live-DB internals (publish/finalize tx body, manifest.yaml/atoms file
      // serving) are exercised by scripts/smoke-e2e.sh, not vitest.
      thresholds: {
        lines: 50,
        functions: 72,
        branches: 75,
        statements: 50,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
