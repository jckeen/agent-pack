import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/index.ts", "src/**/*.d.ts"],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 75,
      },
    },
  },
});
