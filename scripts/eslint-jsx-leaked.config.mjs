// Focused CI gate: react/jsx-no-leaked-render ONLY, across both UI packages
// (web-next + mobile-app). A leaked value like `{count && <X/>}` renders a
// stray "0"/"NaN" on the web and CRASHES React Native.
//
// This exists as a standalone gate because web-next's full eslint-config-next
// lint carries pre-existing unrelated errors (it is not a CI gate), yet we still
// want this one crash-class rule enforced in CI. mobile-app's own config also
// enforces it; this gate additionally covers web-next. Run from the repo root:
//   eslint --no-config-lookup -c scripts/eslint-jsx-leaked.config.mjs \
//     "packages/web-next/**/*.tsx" "packages/mobile-app/**/*.tsx"
import tsParser from "@typescript-eslint/parser"
import reactPlugin from "eslint-plugin-react"
import reactHooks from "eslint-plugin-react-hooks"
import nextPlugin from "@next/eslint-plugin-next"

export default [
  {
    ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/.expo/**"],
  },
  {
    files: ["**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    // react-hooks / @next/next are registered (no rules enabled) only so inline
    // `eslint-disable react-hooks/...` / `@next/next/...` directives in the
    // source resolve and don't error out this focused gate.
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooks,
      "@next/next": nextPlugin,
    },
    settings: { react: { version: "detect" } },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      "react/jsx-no-leaked-render": [
        "error",
        { validStrategies: ["ternary", "coerce"] },
      ],
    },
  },
]
