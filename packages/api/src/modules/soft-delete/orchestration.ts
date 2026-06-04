// Soft-delete orchestration — the write-side entry points (design §5.4/§5.5/§7.4).
//
// Replaces the old hard-delete + DB-cascade model:
//   - markRootDeleted: flip a single soft-delete root's deleted_at (idempotent).
//   - markWorkspaceDeleted: tenant-level orchestration — soft-delete every
//     workspace-scoped root, revoke memberships/bindings/grants, stop runtime.
//   - markUserDeleted: account closure — tombstone the user, transfer/soft-delete
//     owned workspaces, revoke memberships + grants, revoke auth runtime, then
//     anonymize PII.
//   - revokeAuthRuntimeForUser: same-transaction session + device_code teardown
//     (NOT Better Auth /revoke-sessions, which only targets the request user).
//
// All functions take an Executor (db or trx) and are written to run inside one
// transaction; callers should wrap multi-step orchestration in withDbTransaction.

import { sql } from "kysely"
import type { Executor } from "../../infrastructure/database/kysely.js"

/** Soft-delete roots that are workspace-scoped via a plain workspace_id column. */
const WORKSPACE_SCOPED_ROOTS_BY_WORKSPACE_ID = [
  "actors",
  "remote_agents",
  "remote_agent_machines",
  "conversations",
  "devices",
  "plugin_installations",
  "installed_skills",
  "plugin_connections",
  "memory_spaces",
  "memory_items",
  "file_spaces",
  "automation_rules",
  "automation_event_sources",
  "automation_webhook_endpoints",
  "automation_integration_bindings",
  "transport_accounts",
] as const

/** Roots with nullable/global workspace_id — only the workspace-owned rows are
 * soft-deleted; global rows (workspace_id IS NULL) are preserved. */
const WORKSPACE_SCOPED_ROOTS_NULLABLE_GLOBAL = [
  "catalog_items",
  "publishers",
  "file_assets",
  "model_profiles",
] as const

/** Active grant/binding tables to revoke for a workspace (status flip). */
const WORKSPACE_GRANT_TABLES = [
  "resource_access_bindings",
  "runtime_authorization_grants",
  "memory_access_grants",
  "file_access_grants",
] as const

/**
 * Flip deleted_at on a single root row. Idempotent (only affects live rows).
 */
export async function markRootDeleted(
  db: Executor,
  table: string,
  where: { column: string; value: string }
): Promise<number> {
  const result = await sql`
    UPDATE ${sql.id(table)}
    SET deleted_at = NOW()
    WHERE ${sql.id(where.column)} = ${where.value}
      AND deleted_at IS NULL
  `.execute(db)
  return Number(result.numAffectedRows ?? 0)
}

/**
 * Revoke the user's authentication runtime in the SAME transaction:
 * session + device_code rows (both ephemeral, hard-deletable). This replaces any
 * reliance on Better Auth's /revoke-sessions (which only targets the current
 * request user) and on the old ON DELETE CASCADE from users.
 */
export async function revokeAuthRuntimeForUser(
  db: Executor,
  userId: string
): Promise<void> {
  await sql`DELETE FROM session WHERE user_id = ${userId}`.execute(db)
  await sql`DELETE FROM device_code WHERE user_id = ${userId}`.execute(db)
}

/**
 * Tenant-level soft delete. Soft-deletes the workspace and every workspace-scoped
 * root, revokes memberships and grants, and stops runtime. Idempotent.
 */
export async function markWorkspaceDeleted(
  db: Executor,
  workspaceId: string
): Promise<void> {
  // 1. the workspace itself
  await sql`UPDATE workspaces SET deleted_at = NOW() WHERE id = ${workspaceId} AND deleted_at IS NULL`.execute(
    db
  )

  // 2. workspace-scoped roots (plain workspace_id)
  for (const table of WORKSPACE_SCOPED_ROOTS_BY_WORKSPACE_ID) {
    await sql`
      UPDATE ${sql.id(table)} SET deleted_at = NOW()
      WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL
    `.execute(db)
  }
  // nullable-global roots: only the workspace-owned rows
  for (const table of WORKSPACE_SCOPED_ROOTS_NULLABLE_GLOBAL) {
    await sql`
      UPDATE ${sql.id(table)} SET deleted_at = NOW()
      WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL
    `.execute(db)
  }
  // model_groups: owner-derived scope (workspace + member-owned)
  await sql`
    UPDATE model_groups SET deleted_at = NOW()
    WHERE deleted_at IS NULL AND (
      (owner_type = 'workspace' AND owner_workspace_id = ${workspaceId})
      OR (owner_type = 'workspace_member' AND owner_workspace_member_id IN (
        SELECT id FROM workspace_members WHERE workspace_id = ${workspaceId}
      ))
    )
  `.execute(db)

  // 3. memberships → removed; grants/bindings → revoked
  await sql`
    UPDATE workspace_members SET status = 'removed', removed_at = NOW()
    WHERE workspace_id = ${workspaceId} AND status = 'active'
  `.execute(db)
  for (const table of WORKSPACE_GRANT_TABLES) {
    await sql`
      UPDATE ${sql.id(table)} SET status = 'revoked', revoked_at = NOW()
      WHERE workspace_id = ${workspaceId} AND status = 'active'
    `.execute(db)
  }
  await sql`
    UPDATE workspace_access_bindings wab SET status = 'revoked', revoked_at = NOW()
    FROM workspace_members wm
    WHERE wab.workspace_member_id = wm.id AND wm.workspace_id = ${workspaceId} AND wab.status = 'active'
  `.execute(db)
  // model_group_grants are scoped via subject; revoke those whose subject is in
  // this workspace.
  await sql`
    UPDATE model_group_grants mgg SET status = 'revoked'
    FROM access_subjects s
    WHERE mgg.subject_id = s.id AND s.workspace_id = ${workspaceId} AND mgg.status = 'active'
  `.execute(db)
}

/**
 * Account closure for a user (design §5.4). Tombstones the user, handles owned
 * workspaces (transfer to a surviving admin, else soft-delete), revokes
 * memberships + grants, revokes auth runtime, then anonymizes PII.
 */
export async function markUserDeleted(
  db: Executor,
  userId: string
): Promise<void> {
  // 0. tombstone (a first-class step — users_live / auth / partial unique all
  //    depend on it). Idempotent.
  const tombstoned = await sql`
    UPDATE users SET deleted_at = NOW() WHERE id = ${userId} AND deleted_at IS NULL
  `.execute(db)
  if (Number(tombstoned.numAffectedRows ?? 0) === 0) {
    // already deleted — idempotent no-op
    return
  }

  // 1. owned workspaces: transfer to a surviving admin member, else soft-delete.
  const owned = await sql<{ id: string }>`
    SELECT id FROM workspaces WHERE owner_id = ${userId} AND deleted_at IS NULL
  `.execute(db)
  for (const ws of owned.rows) {
    const successor = await sql<{ user_id: string }>`
      SELECT wm.user_id
      FROM workspace_members wm
      JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = ${ws.id}
        AND wm.status = 'active'
        AND wm.trust_level = 'admin'
        AND wm.user_id <> ${userId}
        AND u.deleted_at IS NULL
      ORDER BY wm.joined_at ASC
      LIMIT 1
    `.execute(db)
    const next = successor.rows[0]?.user_id
    if (next) {
      await sql`UPDATE workspaces SET owner_id = ${next} WHERE id = ${ws.id}`.execute(
        db
      )
    } else {
      await markWorkspaceDeleted(db, ws.id)
    }
  }

  // 2. memberships → removed
  await sql`
    UPDATE workspace_members SET status = 'removed', removed_at = NOW()
    WHERE user_id = ${userId} AND status = 'active'
  `.execute(db)

  // 3. platform access bindings → revoked
  await sql`
    UPDATE platform_access_bindings SET status = 'revoked', revoked_at = NOW()
    WHERE user_id = ${userId} AND status = 'active'
  `.execute(db)

  // 4. auth runtime (session + device_code) in this transaction
  await revokeAuthRuntimeForUser(db, userId)

  // 5. account: soft-delete + anonymize account_id (releases the OAuth/credential
  //    identity so the same external subject can be re-bound later) + clear tokens.
  await sql`
    UPDATE account
    SET deleted_at = NOW(),
        account_id = 'deleted:' || id::text,
        access_token = NULL, refresh_token = NULL, id_token = NULL, password = NULL,
        updated_at = NOW()
    WHERE user_id = ${userId} AND deleted_at IS NULL
  `.execute(db)

  // 6. PII anonymization on the (already tombstoned) user row.
  await sql`
    UPDATE users
    SET email = 'deleted+' || id::text || '@deleted.invalid',
        name = 'Deleted User',
        image = NULL,
        feishu_open_id = NULL, feishu_union_id = NULL, feishu_tenant_key = NULL,
        updated_at = NOW()
    WHERE id = ${userId}
  `.execute(db)

  // 7. access_subjects rows are NOT deleted (immutable identity registry, §5).
}
