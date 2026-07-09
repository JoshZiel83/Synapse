// NoopTunnelAdapter — TunnelAdapter implementation that doesn't actually
// reverse-tunnel anything. Returns a loopback URL pointing at the
// runtime's local MCP host port so an API + runtime running on the same
// box (tests, smoke checks, integration suites) can dispatch tool calls
// without spinning up frpc + frps.
//
// This used to be hidden inside FrpTunnelAdapter as a "spawn failed →
// silent fallback" branch — that masked configuration mistakes in
// production (device flipped to "online" while every dispatch 502'd
// against a non-existent frpc). Tests now wire this adapter explicitly.

import type {
  TunnelAdapter,
  TunnelHandle,
  TunnelStartOptions,
} from "@synapse/device-protocol"

export function createNoopTunnelAdapter(): TunnelAdapter {
  const handles = new Map<string, TunnelHandle>()
  return {
    async start(startOpts: TunnelStartOptions): Promise<TunnelHandle> {
      const handle: TunnelHandle = {
        runtimeServiceId: startOpts.runtimeServiceId,
        // Direct loopback — the API is co-located with the runtime so it reaches
        // the MCP host without a tunnel hop. The host is ALWAYS literal loopback:
        // the API-side SSRF gate (validateLocalLoopbackUrl) rejects any non-literal
        // host, so a docker-internal-name override here would be dead and would
        // contradict the {direct, loopback} self-label (§3.1).
        internalUrl: `http://127.0.0.1:${startOpts.localPort}`,
      }
      handles.set(startOpts.runtimeServiceId, handle)
      return handle
    },
    async rotateToken(): Promise<void> {
      /* no-op: there's no upstream token to rotate */
    },
    async stop(handle: TunnelHandle): Promise<void> {
      handles.delete(handle.runtimeServiceId)
    },
  }
}
