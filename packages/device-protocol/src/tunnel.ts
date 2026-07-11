// @synapse/device-protocol — TunnelAdapter interface (§4.4).
// Future swap path: replace frp adapter without touching RuntimeEndpointRegistry callers.

export interface TunnelStartOptions {
  /** The runtime_services row this tunnel belongs to. */
  readonly runtimeServiceId: string
  /** Local loopback port the runtime's MCP HTTP server is listening on. */
  readonly localPort: number
  /** Short-lived per-service registration token issued via Control Plane. */
  readonly registrationToken: string
}

export interface TunnelHandle {
  /** The runtime_services row this tunnel belongs to. */
  readonly runtimeServiceId: string
  /**
   * Base URL the API uses to reach the device's MCP HTTP endpoint through the
   * tunnel edge, e.g. `http://tunnel-edge:N/d/<service-token>`. NEVER public.
   */
  readonly internalUrl: string
}

export interface TunnelAdapter {
  start(opts: TunnelStartOptions): Promise<TunnelHandle>
  rotateToken(handle: TunnelHandle, registrationToken: string): Promise<void>
  stop(handle: TunnelHandle): Promise<void>
}
