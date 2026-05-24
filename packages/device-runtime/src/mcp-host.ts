// In-process catalog manager + MCP host stub. v3.0 ships an in-memory tools
// registry. PR #6 will replace startInMemoryMcpHost with a real Streamable
// HTTP server bound to 127.0.0.1:0.
//
// MCP error-code preservation decision (§14 open item): we choose option (b)
// — embed code in `CallToolResult._meta.synapse_error`. This means the device
// runtime's MCP host can stay on the high-level McpServer API and we don't
// need to drop to the low-level request handler. The API side (PR #6) parses
// `_meta.synapse_error` and re-raises the structured error.

import type {
  DeviceCatalogExposure,
  SynapseError,
} from "@synapse/device-protocol"
import type { CatalogProvider, McpHost } from "./types.js"

export interface InMemoryMcpHostHandle extends McpHost {
  getCatalogSnapshot(): Promise<DeviceCatalogExposure[]>
}

export function createInMemoryMcpHost(): InMemoryMcpHostHandle {
  const providers = new Map<string, CatalogProvider>()
  let started = false

  return {
    get localPort() {
      // v3.0 in-memory host has no listener yet; PR #6 wires the HTTP server.
      return 0
    },
    async start() {
      started = true
    },
    async stop() {
      started = false
    },
    async registerCatalog(provider: CatalogProvider) {
      providers.set(provider.providerKey, provider)
    },
    async unregisterCatalog(providerKey: string) {
      providers.delete(providerKey)
    },
    async getCatalogSnapshot() {
      const all: DeviceCatalogExposure[] = []
      for (const provider of providers.values()) {
        const exposures = await provider.describeExposures()
        all.push(...exposures)
      }
      return all
    },
  }

  void started
}

/**
 * Helper for builtin tool handlers to surface a structured error via the
 * `_meta.synapse_error` field of the MCP CallToolResult so the API side can
 * recover the v3 device-side error code (§4.5).
 */
export function toolErrorResult(err: SynapseError) {
  return {
    content: [{ type: "text" as const, text: err.message }],
    isError: true,
    _meta: { synapse_error: err },
  }
}
