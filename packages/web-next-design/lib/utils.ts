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
// bytes (images/audio/video, and downloadable docs) can't load. Fixtures tag
// such blocks with a `design:<file>` sentinel sha; we serve those from a real
// asset shipped in public/design/attachments/ so every attachment type renders
// with actual media. Real shas still route to the (absent) content endpoint.
const DESIGN_ASSET_PREFIX = "design:"

export function resolveContentUrl(sha256?: string | null) {
  if (!sha256) return undefined
  if (
    process.env.NEXT_PUBLIC_DESIGN_MOCK !== "0" &&
    sha256.startsWith(DESIGN_ASSET_PREFIX)
  ) {
    return `/design/attachments/${sha256.slice(DESIGN_ASSET_PREFIX.length)}`
  }
  return resolveFileUrl(`/api/v1/content/${sha256}`)
}
