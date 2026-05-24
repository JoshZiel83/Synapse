/**
 * Connector registry. Drop-in replacement for the existing capability-only
 * map; both old (capability-only) and new (full connector) lookups coexist
 * during the transition.
 *
 * Connectors are registered eagerly via registerConnector() during module
 * initialization in the per-connector index.ts files.
 */

import type { TransportKind } from "@synapse/shared/types"
import type { TransportConnector } from "./types.js"

const connectors = new Map<TransportKind, TransportConnector>()

export function registerConnector(connector: TransportConnector): void {
  connectors.set(connector.transportKind, connector)
}

export function getConnector(transportKind: TransportKind): TransportConnector {
  const c = connectors.get(transportKind)
  if (!c) {
    throw new Error(
      `No connector registered for transport_kind=${transportKind}`
    )
  }
  return c
}

export function tryGetConnector(
  transportKind: TransportKind
): TransportConnector | undefined {
  return connectors.get(transportKind)
}

export function listConnectors(): TransportConnector[] {
  return Array.from(connectors.values())
}

/** Test-only: drop everything. */
export function _resetConnectorRegistry(): void {
  connectors.clear()
}
