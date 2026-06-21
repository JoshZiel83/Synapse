// Type-aware ("lint:types") config for @synapse/api — SEPARATE from the fast
// syntactic eslint.config.mjs because building the api type graph (900+ files)
// is slow (~minutes) and memory-hungry. Run via `npm run lint:types` (which
// bumps the Node heap) and in CI's verify-boundary gate, not in the everyday
// `npm run lint`.
//
// Currently enforces just @typescript-eslint/switch-exhaustiveness-check
// (lenient: a `default` counts as exhaustive). 0 current violations — this is
// pure regression prevention for future discriminated-union switches.
//
// Uses tsconfig.typecheck.json (the only api tsconfig that includes BOTH src/
// and tests/); tsconfig.json excludes *.test.ts, which would parse-error here.
import tseslint from "typescript-eslint"

export default [
  {
    ignores: ["dist/**", "**/generated/**", "**/*.d.ts", "coverage/**"],
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ["./tsconfig.typecheck.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
    },
  },
]
