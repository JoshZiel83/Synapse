import type {
  TransportConnectionMode,
  TransportConnectorCapability,
  TransportEndpointType,
  TransportKind,
} from "@synapse/shared/types"
import { FEISHU_CONNECTOR_CAPABILITY } from "./feishu.js"
import { WEIXIN_CONNECTOR_CAPABILITY } from "./weixin.js"
import { WECOM_CONNECTOR_CAPABILITY } from "./wecom/capabilities.js"

const CONNECTOR_CAPABILITIES: Record<
  TransportKind,
  TransportConnectorCapability
> = {
  feishu: FEISHU_CONNECTOR_CAPABILITY,
  weixin: WEIXIN_CONNECTOR_CAPABILITY,
  wecom: WECOM_CONNECTOR_CAPABILITY,
}

export function listTransportConnectorCapabilities() {
  return Object.values(CONNECTOR_CAPABILITIES)
}

export function getTransportConnectorCapability(transportKind: TransportKind) {
  return CONNECTOR_CAPABILITIES[transportKind]
}

export function assertSupportedConnectionMode(
  transportKind: TransportKind,
  connectionMode: TransportConnectionMode
) {
  const capability = getTransportConnectorCapability(transportKind)
  if (!capability.supportedConnectionModes.includes(connectionMode)) {
    throw new Error(
      `${transportKind} does not support connection mode ${connectionMode}`
    )
  }
}

export function assertSupportedEndpointType(
  transportKind: TransportKind,
  endpointType: TransportEndpointType
) {
  const capability = getTransportConnectorCapability(transportKind)
  if (!capability.supportedEndpointTypes.includes(endpointType)) {
    throw new Error(
      `${transportKind} does not support endpoint type ${endpointType}`
    )
  }
}
