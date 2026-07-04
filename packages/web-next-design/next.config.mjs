import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { withSentryConfig } from "@sentry/nextjs"

const publicApiBase = process.env.NEXT_PUBLIC_API_URL || "/api/v1"
const apiProxyOrigin = (
  process.env.API_PROXY_ORIGIN || "http://127.0.0.1:3001"
).replace(/\/+$/, "")
const __dirname = dirname(fileURLToPath(import.meta.url))

function normalizePublicApiPrefix(value) {
  if (!value || !value.startsWith("/")) {
    return ""
  }
  return value.replace(/\/+$/, "")
}

const publicApiPrefix = normalizePublicApiPrefix(publicApiBase)

function normalizeAllowedDevOrigin(value) {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  if (trimmed.startsWith("*.")) {
    return trimmed.toLowerCase()
  }

  try {
    const parsed = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`
    )
    return parsed.hostname.toLowerCase()
  } catch {
    return null
  }
}

function resolveAllowedDevOrigins() {
  const explicitValues = (process.env.NEXT_ALLOWED_DEV_ORIGINS || "")
    .split(",")
    .map(normalizeAllowedDevOrigin)
    .filter(Boolean)

  if (explicitValues.length > 0) {
    return Array.from(new Set(explicitValues))
  }

  const inferredValues = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
  ]
    .map(normalizeAllowedDevOrigin)
    .filter(Boolean)

  if (inferredValues.length === 0) {
    return undefined
  }

  return Array.from(new Set(inferredValues))
}

const allowedDevOrigins = resolveAllowedDevOrigins()

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins,
  // Transpile the workspace @synapse dist packages through webpack's loaders so
  // their cross-module named re-exports (shared/dist barrels re-exporting from
  // datetime/access/automation, and from @synapse/device-protocol/enums) are
  // re-analyzed on every compile. Without this, webpack's incremental HMR
  // intermittently loses the re-export trace and throws "X is not exported
  // from ../…" (e.g. dateToIsoInstant, BROWSER_OPERATION_REQUIRED_ACTION),
  // 500-ing pages until a full .next rebuild.
  transpilePackages: ["@synapse/shared", "@synapse/device-protocol"],
  // Hand compression to the nginx edge. `next start` can only emit gzip; the
  // edge does brotli + zstd on every response class (SSR HTML, RSC payloads,
  // API), and serves /_next/static from disk with precompressed br/zst + RFC
  // 9842 dcb/dcz. Per Next docs: "you're using nginx and want to switch to
  // brotli, set the compress option to false to allow nginx to handle
  // compression." Keeps standalone-friendly `next start` (no custom server).
  // See docs/logging-refactor/07-edge-compression-and-cdt-plan.md.
  compress: false,
  experimental: {
    webpackBuildWorker: false,
  },
  outputFileTracingRoot: resolve(__dirname, "..", ".."),
  // Chat is the home surface — /dashboard forwards to it at the HTTP layer, so
  // every post-login `router.push("/dashboard")` lands in Chat. (There is no
  // dashboard "Home" page anymore.)
  async redirects() {
    return [
      {
        source: "/dashboard",
        destination: "/dashboard/chat",
        permanent: false,
      },
    ]
  },
  async rewrites() {
    if (!publicApiPrefix) {
      return []
    }
    return [
      {
        source: `${publicApiPrefix}/:path*`,
        destination: `${apiProxyOrigin}${publicApiPrefix}/:path*`,
      },
    ]
  },
}

// Sentry build plugin (source-map upload + same-origin tunnel) is opt-in via
// SENTRY_AUTH_TOKEN, so default/open-source builds without Sentry creds are
// unaffected. The runtime SDK still activates purely from NEXT_PUBLIC_SENTRY_DSN
// (see instrumentation-client.ts / sentry.*.config.ts). All values env-driven —
// nothing (DSN, org, project, self-hosted URL) is hardcoded.
const sentryBuildEnabled = Boolean(process.env.SENTRY_AUTH_TOKEN)

export default sentryBuildEnabled
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      // Self-hosted Sentry (e.g. https://sentry.example.com) via env.
      sentryUrl: process.env.SENTRY_URL,
      silent: !process.env.CI,
      // Same-origin tunnel so browser events dodge ad-blockers (proxied to the
      // self-hosted Sentry by the Next server).
      tunnelRoute: "/monitoring",
      disableLogger: true,
    })
  : nextConfig
