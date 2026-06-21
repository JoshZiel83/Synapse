// ESLint flat config for the Synapse mobile app (Expo / React Native).
//
// Base: eslint-config-expo (the Expo team's recommended preset). On top of it
// we enforce react/jsx-no-leaked-render as an error — in React Native a leaked
// value like `{count && <X/>}` renders a stray text node OUTSIDE <Text> and
// CRASHES the screen, so this is the highest-value rule here. Adopted 2026-06.
//
// The React-Compiler-era react-hooks v7 rules (set-state-in-effect, refs,
// preserve-manual-memoization) are aggressive and currently flag many
// intentional patterns in this app; they are surfaced as warnings, not blockers,
// this round. react-hooks/rules-of-hooks stays an error (it catches real bugs).
import expoFlat from "eslint-config-expo/flat.js"
import reactPlugin from "eslint-plugin-react"

export default [
  ...expoFlat,
  {
    ignores: [
      "dist/**",
      "public/**",
      ".expo/**",
      "ios/**",
      "android/**",
      "scripts/**",
      "*.config.js",
      "nativewind-env.d.ts",
      "expo-env.d.ts",
    ],
  },
  {
    files: ["app/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
    plugins: { react: reactPlugin },
    rules: {
      "react/jsx-no-leaked-render": [
        "error",
        { validStrategies: ["ternary", "coerce"] },
      ],
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
]
