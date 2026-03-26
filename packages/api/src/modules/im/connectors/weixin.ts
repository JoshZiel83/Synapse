import type { TransportConnectorCapability } from "@synapse/shared/types";

export const WEIXIN_CONNECTOR_CAPABILITY: TransportConnectorCapability = {
  transportKind: "weixin",
  supportedConnectionModes: ["long_connection"],
  supportedEndpointTypes: ["direct"],
  supportsDirectMessages: true,
  supportsGroupMessages: false,
};
