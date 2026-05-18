// Minimal ESLint config for the workgraph monorepo. We use flat config and
// only enable rules that catch real bugs — formatting is delegated to
// Prettier and not enforced here.

import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/build/**",
      "**/*.config.{js,ts,mjs,cjs}",
    ],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // We rely on explicit any deliberately in a few places (zod passthrough
      // bridges, deliberate test escape hatches). Surface them as warnings,
      // not errors, so the lint run still passes.
      "@typescript-eslint/no-explicit-any": "warn",
      // Unused imports and variables get flagged, but underscore-prefixed
      // names are intentional escape hatches.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // The codebase deliberately uses Error subclasses; allow class fields.
      "@typescript-eslint/no-namespace": "off",
      // Console output is the CLI's product. Don't flag it.
      "no-console": "off",
      // We legitimately use require in one place (registry repoRoot's safe
      // sync-existence check).
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // Tests reach into the type system more than runtime code; tolerate
    // `as never` and `as unknown` casts in fixture builders.
    files: ["**/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
