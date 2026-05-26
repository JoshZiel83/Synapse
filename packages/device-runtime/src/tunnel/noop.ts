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

export interface NoopTunnelAdapterOptions {
  /**
   * Override the loopback host returned in the handle's internalUrl.
   * Defaults to "127.0.0.1" — set this when the API process resolves
   * the device's MCP host via a docker-internal name.
   */
  loopbackHost?: string
}

export function createNoopTunnelAdapter(
  opts: NoopTunnelAdapterOptions = {}
): TunnelAdapter {
  const loopbackHost = opts.loopbackHost ?? "127.0.0.1"
  const handles = new Map<string, TunnelHandle>()
  return {
    async start(startOpts: TunnelStartOptions): Promise<TunnelHandle> {
      const handle: TunnelHandle = {
        deviceServiceId: startOpts.deviceServiceId,
        // Direct loopback — the test harness's API is co-located with the
        // runtime so it can reach the MCP host without a tunnel hop.
        internalUrl: `http://${loopbackHost}:${startOpts.localPort}`,
      }
      handles.set(startOpts.deviceServiceId, handle)
      return handle
    },
    async rotateToken(): Promise<void> {
      /* no-op: there's no upstream token to rotate */
    },
    async stop(handle: TunnelHandle): Promise<void> {
      handles.delete(handle.deviceServiceId)
    },
  }
}
