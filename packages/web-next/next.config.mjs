import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

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
  experimental: {
    webpackBuildWorker: false,
  },
  outputFileTracingRoot: resolve(__dirname, "..", ".."),
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

export default nextConfig
