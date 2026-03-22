import type {
  AutomationEventDefinition,
  AutomationOccurrenceDisplayContext,
  AutomationEventSourceDefinitionContext,
} from "./types.js";

function relaySourceLabel(context: AutomationEventSourceDefinitionContext) {
  return context.providerLabel?.trim() || context.providerRef?.trim() || "Relay Device";
}

function relaySourceId(context: AutomationEventSourceDefinitionContext) {
  return context.providerRef?.trim() || "unknown-relay";
}

function readString(
  value: unknown,
) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function relayOccurrenceLabel(context: AutomationOccurrenceDisplayContext) {
  return (
    readString(context.payload.displayName) ||
    readString(context.sourceSnapshot.relayDisplayName) ||
    readString(context.sourceSnapshot.displayName) ||
    readString(context.sourceName) ||
    readString(context.providerRef) ||
    "Relay Device"
  );
}

function relayOccurrenceId(context: AutomationOccurrenceDisplayContext) {
  return (
    readString(context.payload.deviceId) ||
    readString(context.sourceSnapshot.relayId) ||
    readString(context.sourceSnapshot.deviceId) ||
    readString(context.providerRef) ||
    "unknown-relay"
  );
}

export const relayDeviceOnlineEventDefinition: AutomationEventDefinition = {
  definitionKey: "relay.device.online",
  providerKind: "relay",
  managementMode: "system",
  buildSource: (context) => {
    const label = relaySourceLabel(context);
    const relayId = relaySourceId(context);
    return {
      sourceKey: "relay.device.online",
      name: `Relay Online: ${label}`,
      description: `Triggered when relay "${label}" (${relayId}) reconnects and is considered online.`,
      recommendedUsage:
        `Use this when a workflow should resume only after relay "${label}" is reachable again, ` +
        "for example waking a session to retry device-specific work or notify operators that the device recovered.",
      payloadSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string" },
          displayName: { type: "string" },
          status: { type: "string", enum: ["online"] },
        },
        required: ["deviceId", "status"],
      },
      examplePayload: {
        deviceId: relayId,
        displayName: label,
        status: "online",
      },
      metadata: {
        managedBy: "relay_lifecycle",
        definitionKey: "relay.device.online",
      },
    };
  },
  buildOccurrenceDisplay: (context) => {
    const label = relayOccurrenceLabel(context);
    const relayId = relayOccurrenceId(context);
    return {
      title: `${label} came online`,
      summary: "online",
      description: `Relay "${label}" (${relayId}) reconnected and is considered online.`,
    };
  },
};

export const relayDeviceOfflineEventDefinition: AutomationEventDefinition = {
  definitionKey: "relay.device.offline",
  providerKind: "relay",
  managementMode: "system",
  graceWindowMs: 60_000,
  buildSource: (context) => {
    const label = relaySourceLabel(context);
    const relayId = relaySourceId(context);
    return {
      sourceKey: "relay.device.offline",
      name: `Relay Offline: ${label}`,
      description: `Triggered when relay "${label}" (${relayId}) stays disconnected for at least one minute and is considered offline.`,
      recommendedUsage:
        `Use this when a workflow should react to sustained device loss, ` +
        `for example waking a session to escalate, fail over, or inform humans that relay "${label}" is unavailable.`,
      payloadSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string" },
          displayName: { type: "string" },
          status: { type: "string", enum: ["offline"] },
        },
        required: ["deviceId", "status"],
      },
      examplePayload: {
        deviceId: relayId,
        displayName: label,
        status: "offline",
      },
      metadata: {
        managedBy: "relay_lifecycle",
        definitionKey: "relay.device.offline",
      },
    };
  },
  buildOccurrenceDisplay: (context) => {
    const label = relayOccurrenceLabel(context);
    const relayId = relayOccurrenceId(context);
    return {
      title: `${label} went offline`,
      summary: "offline after 60s grace",
      description: `Relay "${label}" (${relayId}) stayed disconnected for at least one minute and is considered offline.`,
    };
  },
};

export const relayLifecycleEventDefinitions = [
  relayDeviceOnlineEventDefinition,
  relayDeviceOfflineEventDefinition,
] as const;
