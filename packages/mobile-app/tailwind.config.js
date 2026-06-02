/**
 * Tailwind config for NativeWind (mobile). Colors are derived from the existing
 * design tokens in src/theme/tokens.ts and extended with a dark palette so
 * `dark:` variants work via the OS color scheme. The StyleSheet-based `theme`
 * object remains the source of truth during the incremental migration (Phase 13b
 * compatibility shim); these values mirror it.
 */

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./src/**/*.{js,jsx,ts,tsx}",
    // NOTE: the Expo DOM ("use dom") WebView components keep their own CSS and are
    // intentionally NOT styled by NativeWind/Tailwind utilities.
  ],
  presets: [require("nativewind/preset")],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: { DEFAULT: "#ffffff", dark: "#0b0b0c" },
        "background-alt": { DEFAULT: "#f5f5f5", dark: "#161618" },
        surface: { DEFAULT: "#ffffff", dark: "#161618" },
        "surface-muted": { DEFAULT: "#f5f5f5", dark: "#1f1f23" },
        border: { DEFAULT: "#e5e5e5", dark: "#2a2a2e" },
        "border-strong": { DEFAULT: "#d4d4d4", dark: "#3a3a40" },
        text: { DEFAULT: "#171717", dark: "#f5f5f5" },
        "text-muted": { DEFAULT: "#525252", dark: "#a3a3a3" },
        "text-soft": { DEFAULT: "#737373", dark: "#8b8b8b" },
        primary: { DEFAULT: "#2563eb", dark: "#3b82f6" },
        "primary-soft": { DEFAULT: "#dbeafe", dark: "#1e3a8a" },
        accent: { DEFAULT: "#f97316", dark: "#fb923c" },
        "accent-soft": { DEFAULT: "#ffedd5", dark: "#7c2d12" },
        success: { DEFAULT: "#15803d", dark: "#22c55e" },
        danger: { DEFAULT: "#dc2626", dark: "#ef4444" },
        "danger-soft": { DEFAULT: "#fee2e2", dark: "#7f1d1d" },
      },
      borderRadius: {
        pill: "999px",
        large: "28px",
        medium: "20px",
        small: "14px",
      },
    },
  },
  plugins: [],
}
