import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const publicApiBase = process.env.NEXT_PUBLIC_API_URL || '/api/v1'
const apiProxyOrigin = (process.env.API_PROXY_ORIGIN || 'http://127.0.0.1:3001').replace(/\/+$/, '')
const __dirname = dirname(fileURLToPath(import.meta.url))

function normalizePublicApiPrefix(value) {
  if (!value || !value.startsWith('/')) {
    return ''
  }
  return value.replace(/\/+$/, '')
}

const publicApiPrefix = normalizePublicApiPrefix(publicApiBase)

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    webpackBuildWorker: false,
  },
  outputFileTracingRoot: resolve(__dirname, '..', '..'),
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
