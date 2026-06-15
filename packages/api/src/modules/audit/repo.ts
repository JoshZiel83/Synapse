// audit/repo.ts — DB-touching helpers for the audit module.
//
// The only audit file permitted to import the db client (guard r8). Owns the
// two read queries behind GET /api/v1/workspaces/:workspaceId/audit-logs: a
// conditional count query and the paginated data query (leftJoins to
// users/actors/workspaceApps). Returns camelCase domain records and KEEPS Date
// objects — instant serialization stays at the boundary (guard r3). round-6 P1-6.

import { db } from "../../infrastructure/database/kysely.js"
import { parseJsonObject } from "@synapse/shared"

export type AuditLogFilters = {
  action?: string
  resourceType?: string
  resourceId?: string
}

export type AuditLogRecord = {
  id: string
  action: string
  resourceType: string
  resourceId: string | null
  userId: string | null
  actorId: string | null
  details: Record<string, unknown>
  ipAddress: string | null
  createdAt: Date
  userName: string | null
  actorName: string | null
}

type AuditLogDbRow = Omit<AuditLogRecord, "details"> & {
  details: unknown
}

export function normalizeAuditLogRow(row: AuditLogDbRow): AuditLogRecord {
  return {
    id: row.id,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    userId: row.userId,
    actorId: row.actorId,
    details: parseJsonObject(row.details),
    ipAddress: row.ipAddress,
    createdAt: row.createdAt,
    userName: row.userName,
    actorName: row.actorName,
  }
}

/** Count of audit logs for one workspace matching the filters. */
export async function countWorkspaceAuditLogs(
  workspaceId: string,
  filters: AuditLogFilters
): Promise<number> {
  let countQuery = db
    .selectFrom("auditLogs as al")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("al.workspaceId", "=", workspaceId)

  if (filters.action) {
    countQuery = countQuery.where("al.action", "=", filters.action)
  }
  if (filters.resourceType) {
    countQuery = countQuery.where("al.resourceType", "=", filters.resourceType)
  }
  if (filters.resourceId) {
    countQuery = countQuery.where("al.resourceId", "=", filters.resourceId)
  }

  const countResult = await countQuery.executeTakeFirst()
  return parseInt(countResult?.count || "0", 10)
}

/** One page of audit logs for a workspace (newest first), matching the filters. */
export async function listWorkspaceAuditLogs(
  workspaceId: string,
  filters: AuditLogFilters,
  pageSize: number,
  offset: number
): Promise<AuditLogRecord[]> {
  let dataQuery = db
    .selectFrom("auditLogs as al")
    .leftJoin("users as u", "u.id", "al.userId")
    .leftJoin("actors as a", "a.id", "al.actorId")
    .leftJoin("workspaceApps as actor_app", "actor_app.id", "a.id")
    .select([
      "al.id",
      "al.action",
      "al.resourceType as resourceType",
      "al.resourceId as resourceId",
      "al.userId as userId",
      "al.actorId as actorId",
      "al.details",
      "al.ipAddress as ipAddress",
      "al.createdAt as createdAt",
      "u.email as userName",
      "actor_app.displayName as actorName",
    ])
    .where("al.workspaceId", "=", workspaceId)

  if (filters.action) {
    dataQuery = dataQuery.where("al.action", "=", filters.action)
  }
  if (filters.resourceType) {
    dataQuery = dataQuery.where("al.resourceType", "=", filters.resourceType)
  }
  if (filters.resourceId) {
    dataQuery = dataQuery.where("al.resourceId", "=", filters.resourceId)
  }

  const rows = await dataQuery
    .orderBy("al.createdAt", "desc")
    .limit(pageSize)
    .offset(offset)
    .execute()
  return rows.map((row) => normalizeAuditLogRow(row as AuditLogDbRow))
}
