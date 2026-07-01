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

// Content-addressed file ref render URL. file_ref blocks now carry a sha256
// (+ optional path); bytes are served by GET /api/v1/content/<sha256> (mounted
// under /api/v1 so the dev Next rewrite + prod nginx proxy it like any API
// route). This builds the absolute URL (reusing resolveFileUrl's origin logic).
// web-next-design: the sandbox has no /api/v1/content backend, so file_ref
// bytes (images/video) can't load. Map the fixtures' known content shas to real
// assets shipped in public/ so the file-upload UI renders with actual media.
// Documents render a card from block metadata and don't need this.
const DESIGN_CONTENT_URLS: Record<string, string> = {
  ["deadbeef".repeat(8)]: "/design/hero-reference.svg",
}

export function resolveContentUrl(sha256?: string | null) {
  if (!sha256) return undefined
  if (
    process.env.NEXT_PUBLIC_DESIGN_MOCK !== "0" &&
    DESIGN_CONTENT_URLS[sha256]
  ) {
    return DESIGN_CONTENT_URLS[sha256]
  }
  return resolveFileUrl(`/api/v1/content/${sha256}`)
}
