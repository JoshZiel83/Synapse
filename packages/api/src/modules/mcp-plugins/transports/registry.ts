import type { McpInstance } from "../instance-manager.js"
import type { McpInstanceParams } from "../instance-manager.js"

/**
 * Transport factory registry.
 *
 * Each runtime MCP transport (builtin / stdio / http / sse) registers a factory
 * that builds an McpInstance. `createTransportInstance` dispatches through this
 * registry instead of a hard-coded switch, so adding a new server transport is
 * a single `registerTransport(...)` call rather than an edit to the switch plus
 * the type unions.
 *
 * NOTE: only MCP_SERVER_TRANSPORTS values are ever registered here.
 */
export type TransportFactory = (
  params: McpInstanceParams,
  key: string,
  configHash: string
) => Promise<McpInstance>

const registry = new Map<string, TransportFactory>()

export function registerTransport(
  transport: string,
  factory: TransportFactory
): void {
  registry.set(transport, factory)
}

export function getTransportFactory(
  transport: string
): TransportFactory | undefined {
  return registry.get(transport)
}
