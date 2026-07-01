"use client"

import { useEffect } from "react"

import { isMobileUserAgent } from "@/lib/is-mobile-user-agent"
import { IS_REPO_LINK_MODE } from "@/lib/repo-link-mode"

export function RepoLinkStaticRedirect({
  page,
}: {
  page: "desktop" | "mobile"
}) {
  useEffect(() => {
    if (!IS_REPO_LINK_MODE) return

    const searchParams = new URLSearchParams(window.location.search)
    const isMobile = isMobileUserAgent(window.navigator.userAgent)
    const hash = window.location.hash

    if (page === "desktop" && isMobile && !searchParams.has("desktop")) {
      window.location.replace(`/m?mobile=1${hash}`)
      return
    }

    if (page === "mobile" && !isMobile && !searchParams.has("mobile")) {
      window.location.replace(`/?desktop=1${hash}`)
    }
  }, [page])

  return null
}
