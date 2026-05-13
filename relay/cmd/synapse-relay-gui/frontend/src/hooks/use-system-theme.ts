import { useEffect } from "react"

import { WindowSetSystemDefaultTheme } from "../../wailsjs/runtime/runtime"

function applyThemePreference(isDark: boolean) {
  document.documentElement.classList.toggle("dark", isDark)
}

export function useSystemTheme() {
  useEffect(() => {
    WindowSetSystemDefaultTheme()

    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = (event?: MediaQueryListEvent) => {
      applyThemePreference(event ? event.matches : media.matches)
    }

    onChange()

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onChange)
      return () => media.removeEventListener("change", onChange)
    }

    media.addListener(onChange)
    return () => media.removeListener(onChange)
  }, [])
}
