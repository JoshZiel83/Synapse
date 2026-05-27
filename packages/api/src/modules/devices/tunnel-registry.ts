// DeviceTunnelRegistry — server-side index from device_service_id → internal
// MCP HTTP base URL (§4.4). The frp adapter populates this registry in PR #6;
// v3.0 ships an in-memory implementation that handles the empty / mocked case.
//
// Business code (capability-projection executor, dispatch handler) MUST go
// through this registry and never construct frp / tunnel URLs themselves.

export interface DeviceTunnelEndpoint {
  readonly deviceServiceId: string
  readonly internalUrl: string
}

export interface DeviceTunnelRegistry {
  register(endpoint: DeviceTunnelEndpoint): void
  unregister(deviceServiceId: string): void
  resolve(deviceServiceId: string): DeviceTunnelEndpoint | undefined
  list(): DeviceTunnelEndpoint[]
}

export function createInMemoryDeviceTunnelRegistry(): DeviceTunnelRegistry {
  const endpoints = new Map<string, DeviceTunnelEndpoint>()
  return {
    register(endpoint) {
      endpoints.set(endpoint.deviceServiceId, endpoint)
    },
    unregister(deviceServiceId) {
      endpoints.delete(deviceServiceId)
    },
    resolve(deviceServiceId) {
      return endpoints.get(deviceServiceId)
    },
    list() {
      return Array.from(endpoints.values())
    },
  }
}

// Singleton — process-wide registry. PR #6 swaps the backing store for a
// frp-aware implementation.
let registryInstance: DeviceTunnelRegistry | null = null
export function getDeviceTunnelRegistry(): DeviceTunnelRegistry {
  if (!registryInstance) {
    registryInstance = createInMemoryDeviceTunnelRegistry()
  }
  return registryInstance
}

/** Test helper: replace the singleton (used by unit tests + PR #6 swap). */
export function setDeviceTunnelRegistry(
  registry: DeviceTunnelRegistry | null
): void {
  registryInstance = registry
}
