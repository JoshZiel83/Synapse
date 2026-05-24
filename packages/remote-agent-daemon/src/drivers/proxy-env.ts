const DEFAULT_NO_PROXY_HOSTS = ["localhost", "127.0.0.1", "::1"]

export type ProxyEnvOptions = {
  /**
   * Explicit proxy URL to inject. Must be set for the helper to do anything;
   * there is no built-in default. The plan calls this out as opt-in: the
   * <redacted-local-proxy> SOCKS5 endpoint is only meaningful on the provider-specific AI endpoint
   * gateway hosts we use for E2E. A daemon running anywhere else with a
   * default-on proxy would dead-route every claude / codex API call.
   */
  proxyUrl?: string
  /** Additional hostnames to skip the proxy for. */
  extraNoProxyHosts?: string[]
}

/**
 * Build env variables that route the child runtime's outbound HTTPS through a
 * proxy. `socks5h://` ensures DNS also resolves through the proxy, which is
 * required for hostnames that don't resolve from the parent host's DNS
 * (e.g. provider-specific AI endpoint behind a tunnel).
 *
 * Returns an empty overlay when no proxy URL is configured — callers can
 * always merge it on top of `process.env` unconditionally.
 */
export function buildAgentChildEnv(
  options: ProxyEnvOptions = {}
): Record<string, string> {
  const proxyUrl = options.proxyUrl?.trim()
  if (!proxyUrl) {
    return {}
  }
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
