import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function resolveFileUrl(url?: string | null) {
  if (!url) return undefined

  if (/^https?:\/\//i.test(url)) {
    return url
  }

  if (!url.startsWith("/")) {
    return url
  }

  const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL
  if (configuredApiUrl) {
    try {
      return new URL(url, new URL(configuredApiUrl).origin).toString()
    } catch {
      // Fall through to current origin.
    }
  }

  if (typeof window !== "undefined") {
    return new URL(url, window.location.origin).toString()
  }

  return url
}
