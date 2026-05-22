const DEFAULT_LLM_SMOKE_PROXY_URL = "<redacted-outbound-proxy>"
const DEFAULT_NO_PROXY_HOSTS = ["localhost", "127.0.0.1", "::1"]

export type ProxyEnvOptions = {
  /** Override the proxy URL. Defaults to the host's local SOCKS5 endpoint (<redacted-local-proxy>). */
  proxyUrl?: string
  /** Additional hostnames to skip the proxy for. */
  extraNoProxyHosts?: string[]
  /** If false, returns an empty env overlay. Useful when running without proxy. */
  enabled?: boolean
}

/**
 * Build env variables that route the child runtime's outbound HTTPS through the host SOCKS5 proxy.
 * `socks5h://` ensures DNS resolution also goes through the proxy, which is required because some
 * upstream hostnames (e.g. provider-specific AI endpoint) only resolve correctly from the proxy's network.
 *
 * No-op (returns empty object) when disabled. Callers should merge the result on top of process.env.
 */
export function buildAgentChildEnv(
  options: ProxyEnvOptions = {}
): Record<string, string> {
  if (options.enabled === false) {
    return {}
  }
  const proxyUrl = options.proxyUrl ?? DEFAULT_LLM_SMOKE_PROXY_URL
  const noProxyHosts = new Set<string>(DEFAULT_NO_PROXY_HOSTS)
  for (const host of options.extraNoProxyHosts ?? []) {
    if (host.trim()) noProxyHosts.add(host.trim())
  }
  const noProxyValue = [...noProxyHosts].join(",")
  return {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: noProxyValue,
    no_proxy: noProxyValue,
  }
}
