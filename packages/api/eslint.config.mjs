// ESLint flat config for @synapse/api.
//
// Curated, Airbnb-aligned rule subset adopted 2026-06 to enforce the TypeScript
// control-flow / readability conventions used across the business-logic
// packages. Headline rule: no-nested-ternary — chained/nested ternaries must be
// rewritten as switch / early-return / lookup. See docs/eslint-curated-ruleset.md.
//
// Kept per-package by design (no root config). When you change the shared rule
// block below, mirror it across the sibling packages' eslint.config.mjs:
// shared, device-protocol, device-sdk, device-runtime, remote-agent-daemon.
import tseslint from "typescript-eslint"

export default [
  {
    ignores: ["dist/**", "**/generated/**", "**/*.d.ts", "coverage/**"],
  },
  {
    // api carries integration tests under tests/ (both are in
    // tsconfig.typecheck.json's include), so lint both source roots.
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    // Register the typescript-eslint plugin so inline
    // `eslint-disable @typescript-eslint/...` directives in the source resolve.
    // We intentionally enable NONE of its rules here (curated subset only).
    plugins: { "@typescript-eslint": tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      // ── Ternary / control-flow clarity (headline) ──
      "no-nested-ternary": "error",
      "no-unneeded-ternary": "error",
      "no-lonely-if": "error",
      "no-else-return": ["error", { allowElseIf: false }],
      "no-useless-return": "error",
      // ── switch hygiene ──
      "default-case-last": "error",
      "no-fallthrough": "error",
      // ── correctness / modern syntax ──
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      "no-param-reassign": ["error", { props: false }],
      "prefer-template": "error",
      yoda: "error",
    },
  },
]
