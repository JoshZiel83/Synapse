import { logRuntimeEvent } from "../execution/service.js"

// DB queries live in repo.ts (guard r8). Re-export under their historical
// names so controller.ts keeps importing them from "./audit.js" unchanged.
export {
  listToolCallAuditLogs as getToolCallLogs,
  listRuntimeEventAuditLogs as getEventLogs,
} from "./repo.js"

export async function logEvent(data: {
  workspaceId?: string
  userId?: string
  pluginId?: string
  deviceId?: string
  eventType: string
  eventData?: Record<string, unknown>
}) {
  await logRuntimeEvent({
    workspaceId: data.workspaceId,
    userId: data.userId,
    source: data.deviceId ? "device" : "tool",
    level: "info",
    eventType: data.eventType,
    payload: {
      pluginId: data.pluginId,
      deviceId: data.deviceId,
      ...(data.eventData || {}),
    },
  })
}
