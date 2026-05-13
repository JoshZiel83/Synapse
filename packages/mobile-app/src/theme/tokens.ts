export const theme = {
  colors: {
    background: "#ffffff",
    backgroundAlt: "#f5f5f5",
    surface: "#ffffff",
    surfaceMuted: "#f5f5f5",
    border: "#e5e5e5",
    borderStrong: "#d4d4d4",
    text: "#171717",
    textMuted: "#525252",
    textSoft: "#737373",
    primary: "#2563eb",
    primarySoft: "#dbeafe",
    accent: "#f97316",
    accentSoft: "#ffedd5",
    success: "#15803d",
    danger: "#dc2626",
    dangerSoft: "#fee2e2",
    overlay: "rgba(23, 23, 23, 0.35)",
    white: "#ffffff",
    black: "#000000",
  },
  radii: {
    pill: 999,
    large: 28,
    medium: 20,
    small: 14,
  },
  spacing: {
    xs: 8,
    sm: 12,
    md: 16,
    lg: 20,
    xl: 24,
    xxl: 32,
  },
  shadow: {
    card: {
      shadowColor: "rgba(15, 23, 42, 0.08)",
      shadowOpacity: 0.08,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
      elevation: 2,
    },
  },
  fonts: {
    display: "System",
  },
} as const

export type AppTheme = typeof theme
