import type {
  AutomationEventDefinition,
  AutomationOccurrenceDisplayContext,
  AutomationEventSourceDefinitionContext,
} from "./types.js"

function deviceSourceLabel(context: AutomationEventSourceDefinitionContext) {
  return (
    context.providerLabel?.trim() || context.providerRef?.trim() || "Device"
  )
}

function deviceSourceId(context: AutomationEventSourceDefinitionContext) {
  return context.providerRef?.trim() || "unknown-device"
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function deviceOccurrenceLabel(context: AutomationOccurrenceDisplayContext) {
  return (
    readString(context.payload.displayName) ||
    readString(context.sourceSnapshot.deviceDisplayName) ||
    readString(context.sourceSnapshot.displayName) ||
    readString(context.sourceName) ||
    readString(context.providerRef) ||
    "Device"
  )
}

function deviceOccurrenceId(context: AutomationOccurrenceDisplayContext) {
  return (
    readString(context.payload.deviceId) ||
    readString(context.sourceSnapshot.deviceId) ||
    readString(context.providerRef) ||
    "unknown-device"
  )
}

export const deviceOnlineEventDefinition: AutomationEventDefinition = {
  definitionKey: "device.online",
  providerKind: "device",
  managementMode: "system",
  buildSource: (context) => {
    const label = deviceSourceLabel(context)
    const deviceId = deviceSourceId(context)
    return {
      sourceKey: "device.online",
      name: `Device Online: ${label}`,
      description: `Triggered when device "${label}" (${deviceId}) reconnects and is considered online.`,
      recommendedUsage:
        `Use this when a workflow should resume only after device "${label}" is reachable again, ` +
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
        deviceId,
        displayName: label,
        status: "online",
      },
      metadata: {
        managedBy: "device_lifecycle",
        definitionKey: "device.online",
      },
    }
  },
  buildOccurrenceDisplay: (context) => {
    const label = deviceOccurrenceLabel(context)
    const deviceId = deviceOccurrenceId(context)
    return {
      title: `${label} came online`,
      summary: "online",
      description: `Device "${label}" (${deviceId}) reconnected and is considered online.`,
    }
  },
}

export const deviceOfflineEventDefinition: AutomationEventDefinition = {
  definitionKey: "device.offline",
  providerKind: "device",
  managementMode: "system",
  graceWindowMs: 60_000,
  buildSource: (context) => {
    const label = deviceSourceLabel(context)
    const deviceId = deviceSourceId(context)
    return {
      sourceKey: "device.offline",
      name: `Device Offline: ${label}`,
      description: `Triggered when device "${label}" (${deviceId}) stays disconnected for at least one minute and is considered offline.`,
      recommendedUsage:
        `Use this when a workflow should react to sustained device loss, ` +
        `for example waking a session to escalate, fail over, or inform humans that device "${label}" is unavailable.`,
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
        deviceId,
        displayName: label,
        status: "offline",
      },
      metadata: {
        managedBy: "device_lifecycle",
        definitionKey: "device.offline",
      },
    }
  },
  buildOccurrenceDisplay: (context) => {
    const label = deviceOccurrenceLabel(context)
    const deviceId = deviceOccurrenceId(context)
    return {
      title: `${label} went offline`,
      summary: "offline after 60s grace",
      description: `Device "${label}" (${deviceId}) stayed disconnected for at least one minute and is considered offline.`,
    }
  },
}

export const deviceLifecycleEventDefinitions = [
  deviceOnlineEventDefinition,
  deviceOfflineEventDefinition,
] as const
