// ESLint flat config for @synapse/shared.
//
// Curated, Airbnb-aligned rule subset adopted 2026-06 to enforce the TypeScript
// control-flow / readability conventions used across the business-logic
// packages. Headline rule: no-nested-ternary — chained/nested ternaries must be
// rewritten as switch / early-return / lookup. See docs/eslint-curated-ruleset.md.
//
// Kept per-package by design (no root config). When you change the shared rule
// block below, mirror it across the sibling packages' eslint.config.mjs:
// api, device-protocol, device-sdk, device-runtime, remote-agent-daemon.
import tseslint from "typescript-eslint"

export default [
  {
    ignores: ["dist/**", "**/generated/**", "**/*.d.ts", "coverage/**"],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        // Type-aware parsing, for @typescript-eslint/switch-exhaustiveness-check.
        // shared/tsconfig.json includes all of src/ (tests included), so every
        // linted file resolves to a project. Adds ~a few seconds to this lint.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
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
      // Type-aware: a switch over a union must handle every member OR have a
      // default (considerDefaultExhaustiveForUnions). Catches a forgotten case
      // with no fallback. 0 current violations — pure regression prevention.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
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
