import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/drizzle/**", "apps/web/dev-dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // Executors write to outside systems. Only the confirm route may import one (docs/ARCHITECTURE.md, Proposal engine).
    files: ["apps/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["**/executors/*", "**/executors"], message: "Executors are importable only from apps/api/src/modules/proposals/confirm.ts." }] }],
    },
  },
  {
    files: ["apps/api/src/modules/proposals/confirm.ts", "apps/api/test/**/*.ts"],
    rules: { "no-restricted-imports": "off" },
  },
);
