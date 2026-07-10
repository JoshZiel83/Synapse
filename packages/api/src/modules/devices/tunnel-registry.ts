// RuntimeEndpointRegistry — server-side index from runtime_service_id → internal
// MCP HTTP base URL (§4.4). The frp adapter populates this registry in PR #6;
// v3.0 ships an in-memory implementation that handles the empty / mocked case.
//
// Business code (capability-projection executor, dispatch handler) MUST go
// through this registry and never construct frp / tunnel URLs themselves.

export interface RuntimeEndpoint {
  readonly runtimeServiceId: string
  readonly internalUrl: string
  // The control-plane session that registered THIS entry. Stamped at register()
  // so unregister can be a compare-and-delete: a half-open OLD socket's deferred
  // `close` must not evict a LIVE entry a NEWER socket re-registered for the same
  // service (the stale-close race, §3.3). Optional for legacy/test callers.
  readonly sessionId?: string
}

export interface RuntimeEndpointRegistry {
  register(endpoint: RuntimeEndpoint): void
  // unregister is compare-and-delete when `expectedSessionId` is supplied: the entry
  // is removed ONLY if its registering sessionId matches. A forced teardown (no
  // expectedSessionId) removes unconditionally. Returns true iff an entry was removed.
  unregister(runtimeServiceId: string, expectedSessionId?: string): boolean
  resolve(runtimeServiceId: string): RuntimeEndpoint | undefined
  list(): RuntimeEndpoint[]
}

export function createInMemoryRuntimeEndpointRegistry(): RuntimeEndpointRegistry {
  const endpoints = new Map<string, RuntimeEndpoint>()
  return {
    register(endpoint) {
      endpoints.set(endpoint.runtimeServiceId, endpoint)
    },
    unregister(runtimeServiceId, expectedSessionId) {
      if (expectedSessionId !== undefined) {
        const current = endpoints.get(runtimeServiceId)
        // Only the session that owns the current entry may evict it. A stale
        // socket (different/absent sessionId on the live entry) is a no-op.
        if (!current || current.sessionId !== expectedSessionId) return false
      }
      return endpoints.delete(runtimeServiceId)
    },
    resolve(runtimeServiceId) {
      return endpoints.get(runtimeServiceId)
    },
    list() {
      return Array.from(endpoints.values())
    },
  }
}

// Singleton — process-wide registry. PR #6 swaps the backing store for a
// frp-aware implementation.
let registryInstance: RuntimeEndpointRegistry | null = null
export function getRuntimeEndpointRegistry(): RuntimeEndpointRegistry {
  if (!registryInstance) {
    registryInstance = createInMemoryRuntimeEndpointRegistry()
  }
  return registryInstance
}

/** Test helper: replace the singleton (used by unit tests + PR #6 swap). */
export function setRuntimeEndpointRegistry(
  registry: RuntimeEndpointRegistry | null
): void {
  registryInstance = registry
}
