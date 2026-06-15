import type { AuditLogListView, AuditLogView } from "@synapse/shared/schemas"
import { serializeInstant } from "../../infrastructure/datetime.js"
import type { AuditLogRecord } from "./repo.js"

export function presentAuditLog(record: AuditLogRecord): AuditLogView {
  return {
    id: record.id,
    action: record.action,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    userId: record.userId,
    actorId: record.actorId,
    details: record.details,
    ipAddress: record.ipAddress,
    createdAt: serializeInstant(record.createdAt),
    userName: record.userName,
    actorName: record.actorName,
  }
}

export function presentAuditLogList(input: {
  items: AuditLogRecord[]
  total: number
  page: number
  pageSize: number
}): AuditLogListView {
  return {
    items: input.items.map(presentAuditLog),
    total: input.total,
    page: input.page,
    pageSize: input.pageSize,
  }
}
