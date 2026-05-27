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
    // The transportKind enum is closed but a stale row could in theory
    // hit this. Treat as 400 (caller asked for something unsupported)
    // rather than 500 — see the error handler in src/index.ts:127.
    throw Object.assign(
      new Error(`No connector registered for transport_kind=${transportKind}`),
      {
        statusCode: 400 as const,
        code: "transport_kind_unsupported" as const,
      }
    )
  }
  if (!capability.supportedConnectionModes.includes(connectionMode)) {
    // WeCom only supports long_connection but the generic POST
    // /im/accounts accepts every value in TRANSPORT_CONNECTION_MODES
    // for any kind — without statusCode/code here the resulting
    // mismatch falls through to 500.
    throw Object.assign(
      new Error(
        `${transportKind} does not support connection mode ${connectionMode}`
      ),
      {
        statusCode: 400 as const,
        code: "transport_connection_mode_unsupported" as const,
      }
    )
  }
}

export function assertSupportedEndpointType(
  transportKind: TransportKind,
  endpointType: TransportEndpointType
): void {
  const capability = getTransportConnectorCapability(transportKind)
  if (!capability) {
    throw Object.assign(
      new Error(`No connector registered for transport_kind=${transportKind}`),
      {
        statusCode: 400 as const,
        code: "transport_kind_unsupported" as const,
      }
    )
  }
  if (!capability.supportedEndpointTypes.includes(endpointType)) {
    throw Object.assign(
      new Error(
        `${transportKind} does not support endpoint type ${endpointType}`
      ),
      {
        statusCode: 400 as const,
        code: "transport_endpoint_type_unsupported" as const,
      }
    )
  }
}
