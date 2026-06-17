import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/index.ts",
        "src/**/*.d.ts",
        "drizzle.config.ts",
        // Drizzle schema files are declarative factory definitions — not
        // testable logic. vitest 4's AST-aware remapping counts each chained
        // property call as an uncovered statement, inflating the denominator.
        // The thresholds gate query logic (src/queries/**), not schema shape.
        "src/schema/**",
      ],
      // No `functions` floor: `include` pulls in the declarative Drizzle
      // schema factories under src/schema, which inflate the function
      // denominator (~50%). The lines/statements/branches floors gate the
      // query logic, where a deleted test drops line coverage below 85.
      thresholds: {
        lines: 85,
        statements: 85,
        branches: 78,
      },
    },
  },
});
