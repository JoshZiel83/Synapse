// chat/repo.ts — DB-touching helpers for the chat module.
//
// This is the only chat file permitted to import from generated/db and to
// define map*Row helpers (see packages/api/scripts/guard-layering.mjs). It
// owns the jsonb SQL fragment builder and the push-token row mapper so that
// service.ts stays free of generated/db imports and row-mapping definitions.

import { sql, type RawBuilder } from "kysely"
import type { Timestamp } from "@synapse/shared"
import type { JsonValue } from "../../infrastructure/database/generated/db.js"
import { db } from "../../infrastructure/database/kysely.js"
import { serializeInstant } from "../../infrastructure/datetime.js"

/** Serialize a value into a jsonb-typed SQL fragment (matches `$N::jsonb`). */
export function jsonbValue(value: unknown): RawBuilder<JsonValue> {
  return sql<JsonValue>`${JSON.stringify(value ?? null)}::jsonb`
}

export interface ChatPushTokenRow {
  id: string
  workspaceMemberId: string
  platform: "ios" | "android" | "web"
  token: string
  deviceLabel: string | null
  createdAt: Timestamp
  lastSeenAt: Timestamp
}

export function mapPushTokenRow(
  row: Record<string, unknown>
): ChatPushTokenRow {
  return {
    id: String(row.id),
    workspaceMemberId: String(row.workspace_member_id),
    platform: row.platform as "ios" | "android" | "web",
    token: String(row.token),
    deviceLabel: (row.device_label as string | null) ?? null,
    createdAt: serializeInstant(row.created_at as Date),
    lastSeenAt: serializeInstant(row.last_seen_at as Date),
  }
}

// ─────────────────────────── workspace-member identity ───────────────────────
// The workspace-member identity record + its two reads. Lives in repo.ts (the
// only chat file allowed to touch the DB client, guard r8); the public surface
// (workspace-identity.ts) re-exports these + adds the pure require* wrapper, so
// the 6 cross-module importers are unchanged. round-6 P1-6.

export interface WorkspaceMemberIdentity {
  workspaceMemberId: string
  workspaceId: string
  userId: string
  userName: string
  avatarFileId?: string | null
  trustLevel: string
}

export async function getWorkspaceMemberIdentity(
  workspaceId: string,
  userId: string
): Promise<WorkspaceMemberIdentity | null> {
  const row = await db
    .selectFrom("workspaceMembers as wm")
    .innerJoin("users as u", "u.id", "wm.userId")
    .select([
      "wm.id as workspaceMemberId",
      "wm.workspaceId",
      "wm.userId",
      "wm.trustLevel",
      "u.name as userName",
      "u.avatarFileId",
    ])
    .where("wm.workspaceId", "=", workspaceId)
    .where("wm.userId", "=", userId)
    // Soft delete (§8.4): only an active member + live user resolves to an identity.
    .where("wm.status", "=", "active")
    .where("u.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()

  if (!row) {
    return null
  }

  return {
    workspaceMemberId: row.workspaceMemberId,
    workspaceId: row.workspaceId,
    userId: row.userId,
    userName: row.userName,
    avatarFileId: row.avatarFileId,
    trustLevel: row.trustLevel,
  }
}

export async function getWorkspaceMemberIdentityById(
  workspaceMemberId: string
): Promise<WorkspaceMemberIdentity | null> {
  const row = await db
    .selectFrom("workspaceMembers as wm")
    .innerJoin("users as u", "u.id", "wm.userId")
    .select([
      "wm.id as workspaceMemberId",
      "wm.workspaceId",
      "wm.userId",
      "wm.trustLevel",
      "u.name as userName",
      "u.avatarFileId",
    ])
    .where("wm.id", "=", workspaceMemberId)
    .limit(1)
    .executeTakeFirst()

  if (!row) {
    return null
  }

  return {
    workspaceMemberId: row.workspaceMemberId,
    workspaceId: row.workspaceId,
    userId: row.userId,
    userName: row.userName,
    avatarFileId: row.avatarFileId,
    trustLevel: row.trustLevel,
  }
}
