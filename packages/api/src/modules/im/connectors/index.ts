/**
 * Connector capability + dispatch helpers.
 *
 * Reads from the live connector registry (registry.ts) so there's exactly
 * one source of truth per transport_kind: the capability descriptor on
 * the registered connector instance. The legacy connectors/feishu.ts and
 * connectors/weixin.ts shells that exported standalone capability constants
 * are gone.
 */

import type {
  TransportConnectionMode,
  TransportConnectorCapability,
  TransportEndpointType,
  TransportKind,
} from "@synapse/shared/types"
import { listConnectors, tryGetConnector } from "./registry.js"

export function listTransportConnectorCapabilities(): TransportConnectorCapability[] {
  return listConnectors().map((c) => c.capability)
}

export function getTransportConnectorCapability(
  transportKind: TransportKind
): TransportConnectorCapability | undefined {
  return tryGetConnector(transportKind)?.capability
}

export function assertSupportedConnectionMode(
  transportKind: TransportKind,
  connectionMode: TransportConnectionMode
): void {
  const capability = getTransportConnectorCapability(transportKind)
  if (!capability) {
    throw new Error(
      `No connector registered for transport_kind=${transportKind}`
    )
  }
  if (!capability.supportedConnectionModes.includes(connectionMode)) {
    throw new Error(
      `${transportKind} does not support connection mode ${connectionMode}`
    )
  }
}

export function assertSupportedEndpointType(
  transportKind: TransportKind,
  endpointType: TransportEndpointType
): void {
  const capability = getTransportConnectorCapability(transportKind)
  if (!capability) {
    throw new Error(
      `No connector registered for transport_kind=${transportKind}`
    )
  }
  if (!capability.supportedEndpointTypes.includes(endpointType)) {
    throw new Error(
      `${transportKind} does not support endpoint type ${endpointType}`
    )
  }
}
