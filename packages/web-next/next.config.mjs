const publicApiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'
const apiProxyOrigin = (process.env.API_PROXY_ORIGIN || 'http://127.0.0.1:3001').replace(/\/+$/, '')

function normalizePublicApiPrefix(value) {
  if (!value || !value.startsWith('/')) {
    return ''
  }
  return value.replace(/\/+$/, '')
}

const publicApiPrefix = normalizePublicApiPrefix(publicApiBase)

/** @type {import('next').NextConfig} */
const nextConfig = {
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
