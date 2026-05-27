/**
 * transport_accounts domain: account CRUD + list/lookup + the joined-row
 * loader the dashboard uses to render every (account, endpoint) pair as a
 * "session". Owns every assertion about an account being well-formed
 * (credentials valid, owner is a workspace member, inbound actor scope
 * matches owner scope, etc.).
 *
 * Also exports a few internal helpers that sibling sub-files depend on:
 *
 * - `assertConversationInboundActor` and `loadTransportAccountRow` are
 *   consumed by service/bindings.ts (binding writes need to validate the
 *   target account and the actor that will receive inbound messages).
 * - `listTransportSessions` is consumed by service/bindings.ts after
 *   updateTransportSessionSettings so the caller gets the fresh session
 *   row back.
 *
 * service.ts re-exports everything for back-compat.
 */

import { sql } from "kysely"
import {
  db,
  type TableInsert,
} from "../../../infrastructure/database/kysely.js"
import { v4 as uuidv4 } from "uuid"
import type {
  TransportAccountInboundActorMode,
  TransportAccountOwnerScope,
  TransportAccountSummary,
  TransportConnectionMode,
  TransportConversationInboundActorMode,
  TransportKind,
  TransportSessionSummary,
} from "@synapse/shared/types"
import { assertSupportedConnectionMode } from "../connectors/index.js"
import {
  assertWorkspaceMember,
  setTransportAddressLinkedUser,
} from "./addresses.js"
import {
  normalizeAccountRow,
  normalizeTransportSessionRow,
  parseJsonObject,
  readTrimmedString,
} from "./_helpers.js"
import { recoverSkippedProjectionsForRecoveryEvent } from "./recovery.js"

// ───────────────────────── Assertions ─────────────────────────

/**
 * Validate credentials via the connector and return the connector's
 * normalized form when available. The normalized form is what should be
 * persisted to the DB (it has alias keys merged, whitespace trimmed, etc.).
 *
 * Disabled accounts skip validation entirely — they may legitimately have
 * blank or expired credentials waiting to be filled in.
 *
 * Pure: implementation lives in service/account-credentials.ts (kept
 * DB-free so its tests don't drag in the pg.Pool). Re-exported here for
 * back-compat.
 */
export {
  mergeAccountCredentials,
  validateAndNormalizeAccountCredentials,
} from "./account-credentials.js"
import {
  mergeAccountCredentials,
  validateAndNormalizeAccountCredentials,
} from "./account-credentials.js"

function readPendingAutoLinkWorkspaceMemberId(
  metadata: Record<string, unknown>
) {
  return readTrimmedString(metadata, "pendingAutoLinkWorkspaceMemberId")
}

async function assertWorkspaceActor(params: {
  workspaceId: string
  actorId?: string | null
  label: string
}) {
  const actorId = params.actorId || null
  if (!actorId) {
    throw new Error(`${params.label} is required`)
  }

  const actor = await db
    .selectFrom("actors")
    .select("id")
    .where("id", "=", actorId)
    .where("workspace_id", "=", params.workspaceId)
    .where("is_active", "=", true)
    .limit(1)
    .executeTakeFirst()
  if (!actor?.id) {
    throw new Error(`${params.label} is not available in this workspace`)
  }
  return actorId
}

async function assertTransportAccountOwner(params: {
  workspaceId: string
  ownerScope: TransportAccountOwnerScope
  ownerWorkspaceMemberId?: string | null
}) {
  if (params.ownerScope === "workspace") {
    if (params.ownerWorkspaceMemberId) {
      throw new Error(
        "Workspace-owned transport account cannot have an owner workspace member"
      )
    }
    return null
  }

  const ownerWorkspaceMemberId = params.ownerWorkspaceMemberId || null
  if (!ownerWorkspaceMemberId) {
    throw new Error(
      "Workspace-member transport account requires ownerWorkspaceMemberId"
    )
  }

  const isWorkspaceMember = await assertWorkspaceMember({
    workspaceId: params.workspaceId,
    workspaceMemberId: ownerWorkspaceMemberId,
  })
  if (!isWorkspaceMember) {
    throw new Error("Transport account owner must be a workspace member")
  }

  return ownerWorkspaceMemberId
}

async function assertTransportAccountInboundActor(params: {
  workspaceId: string
  ownerScope: TransportAccountOwnerScope
  ownerWorkspaceMemberId?: string | null
  inboundActorMode: TransportAccountInboundActorMode
  inboundActorId?: string | null
}) {
  if (params.inboundActorMode === "none") {
    return null
  }

  if (params.inboundActorMode === "follow_owner_chief_actor") {
    if (
      params.ownerScope !== "workspace_member" ||
      !params.ownerWorkspaceMemberId
    ) {
      throw new Error(
        "Follow chief actor is only available for workspace-member-owned IM accounts"
      )
    }
    return null
  }

  return assertWorkspaceActor({
    workspaceId: params.workspaceId,
    actorId: params.inboundActorId,
    label: "Inbound actor",
  })
}

export async function assertConversationInboundActor(params: {
  workspaceId: string
  inboundActorMode: TransportConversationInboundActorMode
  inboundActorId?: string | null
}) {
  if (params.inboundActorMode !== "specified_actor") {
    return null
  }

  return assertWorkspaceActor({
    workspaceId: params.workspaceId,
    actorId: params.inboundActorId,
    label: "Inbound actor",
  })
}

// ───────────────────────── Row loaders ─────────────────────────

export async function loadTransportAccountRow(
  workspaceId: string,
  accountId: string
) {
  return db
    .selectFrom("transport_accounts")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", accountId)
    .limit(1)
    .executeTakeFirst()
}

async function loadTransportAccountRowByWorkspaceKey(params: {
  workspaceId: string
  transportKind: TransportKind
  accountKey: string
}) {
  return db
    .selectFrom("transport_accounts")
    .selectAll()
    .where("workspace_id", "=", params.workspaceId)
    .where("transport_kind", "=", params.transportKind)
    .where("account_key", "=", params.accountKey.trim())
    .limit(1)
    .executeTakeFirst()
}

async function loadTransportAccountRowById(accountId: string) {
  return db
    .selectFrom("transport_accounts")
    .selectAll()
    .where("id", "=", accountId)
    .limit(1)
    .executeTakeFirst()
}

// ───────────────────────── Lookups ─────────────────────────

export async function listTransportAccounts(
  workspaceId: string
): Promise<TransportAccountSummary[]> {
  const rows = await db
    .selectFrom("transport_accounts")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .orderBy("created_at", "desc")
    .execute()
  return rows.map(normalizeAccountRow)
}

export async function getTransportAccountById(accountId: string) {
  const row = await loadTransportAccountRowById(accountId)
  return row ? normalizeAccountRow(row) : null
}

export async function getTransportAccountByKindAndId(params: {
  accountId: string
  transportKind: TransportKind
}) {
  const row = await db
    .selectFrom("transport_accounts")
    .selectAll()
    .where("id", "=", params.accountId)
    .where("transport_kind", "=", params.transportKind)
    .limit(1)
    .executeTakeFirst()
  return row ? normalizeAccountRow(row) : null
}

export async function getTransportAccountByWorkspaceKindAndKey(params: {
  workspaceId: string
  transportKind: TransportKind
  accountKey: string
}) {
  const row = await loadTransportAccountRowByWorkspaceKey(params)
  return row ? normalizeAccountRow(row) : null
}

// ───────────────────────── Auto-link ─────────────────────────

export function getPendingTransportAccountAutoLinkWorkspaceMemberId(
  account: Pick<TransportAccountSummary, "metadata">
) {
  const metadata = parseJsonObject(account.metadata)
  return readPendingAutoLinkWorkspaceMemberId(metadata) || null
}

export async function consumeTransportAccountAutoLink(params: {
  account: TransportAccountSummary
  transportAddressId: string
  targetWorkspaceMemberId: string
  matchedExternalId: string
}) {
  await setTransportAddressLinkedUser({
    workspaceId: params.account.workspaceId,
    transportAddressId: params.transportAddressId,
    workspaceMemberId: params.targetWorkspaceMemberId,
  })

  const nextMetadata = {
    ...parseJsonObject(params.account.metadata),
    pendingAutoLinkConsumedAt: new Date().toISOString(),
    pendingAutoLinkConsumedExternalId: params.matchedExternalId,
  }
  delete (nextMetadata as any).pendingAutoLinkWorkspaceMemberId
  delete (nextMetadata as any).pendingAutoLinkMode
  delete (nextMetadata as any).pendingAutoLinkConfiguredAt

  return updateTransportAccount({
    workspaceId: params.account.workspaceId,
    accountId: params.account.id,
    metadata: nextMetadata,
  })
}

// ───────────────────────── Runtime + sessions ─────────────────────────

export async function listActiveTransportAccounts(params?: {
  connectionMode?: TransportConnectionMode
  transportKind?: TransportKind
}) {
  let builder = db
    .selectFrom("transport_accounts")
    .selectAll()
    .where("status", "=", "active")

  if (params?.connectionMode) {
    builder = builder.where("connection_mode", "=", params.connectionMode)
  }
  if (params?.transportKind) {
    builder = builder.where("transport_kind", "=", params.transportKind)
  }

  const rows = await builder.orderBy("created_at", "asc").execute()
  return rows.map(normalizeAccountRow)
}

export async function listTransportSessions(
  workspaceId: string
): Promise<TransportSessionSummary[]> {
  const inboundActivity = db
    .selectFrom("transport_message_links")
    .select("transport_endpoint_id")
    .select(sql<Date | null>`MAX(created_at)`.as("last_inbound_at"))
    .where("direction", "=", "inbound")
    .groupBy("transport_endpoint_id")
    .as("inbound_activity")

  const outboundActivity = db
    .selectFrom("transport_message_links")
    .select("transport_endpoint_id")
    .select(sql<Date | null>`MAX(created_at)`.as("last_outbound_at"))
    .where("direction", "=", "outbound")
    .groupBy("transport_endpoint_id")
    .as("outbound_activity")

  const rows = await db
    .selectFrom("transport_endpoints as te")
    .innerJoin("transport_accounts as ta", "ta.id", "te.transport_account_id")
    .leftJoin(
      "conversation_transport_bindings as ctb",
      "ctb.transport_endpoint_id",
      "te.id"
    )
    .leftJoin("conversations as c", "c.id", "ctb.conversation_id")
    .leftJoin(
      inboundActivity,
      "inbound_activity.transport_endpoint_id",
      "te.id"
    )
    .leftJoin(
      outboundActivity,
      "outbound_activity.transport_endpoint_id",
      "te.id"
    )
    .select([
      "ctb.id as binding_id",
      "ctb.workspace_id",
      "ctb.conversation_id",
      "ctb.outbound_enabled",
      "ctb.inbound_actor_mode",
      "ctb.inbound_actor_id",
      "ctb.metadata as binding_metadata",
      "ctb.created_at as binding_created_at",
      "ctb.updated_at as binding_updated_at",
      "c.title as conversation_title",
      "ta.id",
      "ta.workspace_id as account_workspace_id",
      "ta.account_key",
      "ta.display_name",
      "ta.transport_kind",
      "ta.owner_scope",
      "ta.owner_workspace_member_id",
      "ta.inbound_actor_mode as account_inbound_actor_mode",
      "ta.inbound_actor_id as account_inbound_actor_id",
      "ta.connection_mode",
      "ta.status",
      "ta.credentials",
      "ta.config",
      "ta.metadata",
      "ta.created_at",
      "ta.updated_at",
      "te.id as endpoint_id",
      "te.transport_account_id",
      "te.endpoint_type",
      "te.external_id as endpoint_external_id",
      "te.parent_external_id",
      "te.display_name as endpoint_display_name",
      "te.metadata as endpoint_metadata",
      "te.created_at as endpoint_created_at",
      "te.updated_at as endpoint_updated_at",
      "inbound_activity.last_inbound_at as last_inbound_at",
      "outbound_activity.last_outbound_at as last_outbound_at",
    ])
    .where("ta.workspace_id", "=", workspaceId)
    .orderBy(
      sql`COALESCE(inbound_activity.last_inbound_at, outbound_activity.last_outbound_at, te.updated_at)`,
      "desc"
    )
    .orderBy("te.created_at", "desc")
    .execute()

  return rows.map(normalizeTransportSessionRow)
}

// ───────────────────────── Create / update ─────────────────────────

export async function createTransportAccount(params: {
  workspaceId: string
  transportKind: TransportKind
  accountKey: string
  displayName: string
  ownerScope?: TransportAccountOwnerScope
  ownerWorkspaceMemberId?: string | null
  inboundActorMode?: TransportAccountInboundActorMode
  inboundActorId?: string | null
  connectionMode: TransportConnectionMode
  status?: "active" | "disabled" | "error"
  credentials?: Record<string, unknown>
  config?: Record<string, unknown>
  metadata?: Record<string, unknown>
}) {
  assertSupportedConnectionMode(params.transportKind, params.connectionMode)
  const nextStatus = params.status || "active"
  const normalizedCredentials = validateAndNormalizeAccountCredentials({
    transportKind: params.transportKind,
    connectionMode: params.connectionMode,
    status: nextStatus,
    credentials: params.credentials,
  })
  const ownerScope = params.ownerScope || "workspace"
  const ownerWorkspaceMemberId = await assertTransportAccountOwner({
    workspaceId: params.workspaceId,
    ownerScope,
    ownerWorkspaceMemberId:
      ownerScope === "workspace" ? null : params.ownerWorkspaceMemberId,
  })
  const inboundActorMode = params.inboundActorMode || "none"
  const inboundActorId = await assertTransportAccountInboundActor({
    workspaceId: params.workspaceId,
    ownerScope,
    ownerWorkspaceMemberId,
    inboundActorMode,
    inboundActorId: params.inboundActorId,
  })

  const row = await db
    .insertInto("transport_accounts")
    .values({
      id: uuidv4(),
      workspace_id: params.workspaceId,
      transport_kind: params.transportKind,
      account_key: params.accountKey.trim(),
      display_name: params.displayName.trim(),
      owner_scope: ownerScope,
      owner_workspace_member_id: ownerWorkspaceMemberId,
      inbound_actor_mode: inboundActorMode,
      inbound_actor_id: inboundActorId,
      connection_mode: params.connectionMode,
      status: nextStatus,
      credentials:
        normalizedCredentials as TableInsert<"transport_accounts">["credentials"],
      config: (params.config ||
        {}) as TableInsert<"transport_accounts">["config"],
      metadata: (params.metadata ||
        {}) as TableInsert<"transport_accounts">["metadata"],
      created_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return normalizeAccountRow(row)
}

export async function updateTransportAccount(params: {
  workspaceId: string
  accountId: string
  displayName?: string
  ownerScope?: TransportAccountOwnerScope
  ownerWorkspaceMemberId?: string | null
  inboundActorMode?: TransportAccountInboundActorMode
  inboundActorId?: string | null
  connectionMode?: TransportConnectionMode
  status?: "active" | "disabled" | "error"
  credentials?: Record<string, unknown>
  config?: Record<string, unknown>
  metadata?: Record<string, unknown>
}) {
  const existing = await loadTransportAccountRow(
    params.workspaceId,
    params.accountId
  )
  if (!existing) {
    throw new Error("Transport account not found")
  }

  const nextConnectionMode =
    params.connectionMode ||
    (existing.connection_mode as TransportConnectionMode)
  assertSupportedConnectionMode(
    existing.transport_kind as TransportKind,
    nextConnectionMode
  )
  const nextStatus =
    params.status || (existing.status as "active" | "disabled" | "error")
  // Merge incoming credential fields on top of existing ones. Feishu
  // (and any future connector with multiple credential fields) accepts
  // partial updates: PUT {encryptKey: "…"} should leave appId/appSecret
  // intact. If the caller wants a clean replacement they must send the
  // full credential object.
  const mergedCredentials = mergeAccountCredentials(
    parseJsonObject(existing.credentials),
    params.credentials
  )
  const nextOwnerScope =
    params.ownerScope ||
    (existing.owner_scope as TransportAccountOwnerScope | undefined) ||
    "workspace"
  const nextOwnerWorkspaceMemberId =
    nextOwnerScope === "workspace"
      ? null
      : params.ownerWorkspaceMemberId !== undefined
        ? params.ownerWorkspaceMemberId
        : (existing.owner_workspace_member_id as string | null | undefined) ||
          null
  const normalizedCredentials = validateAndNormalizeAccountCredentials({
    transportKind: existing.transport_kind as TransportKind,
    connectionMode: nextConnectionMode,
    status: nextStatus,
    credentials: mergedCredentials,
  })
  const resolvedOwnerWorkspaceMemberId = await assertTransportAccountOwner({
    workspaceId: params.workspaceId,
    ownerScope: nextOwnerScope,
    ownerWorkspaceMemberId: nextOwnerWorkspaceMemberId,
  })
  const nextInboundActorMode =
    params.inboundActorMode ||
    (existing.inbound_actor_mode as
      | TransportAccountInboundActorMode
      | undefined) ||
    "none"
  const nextInboundActorId =
    nextInboundActorMode === "specified_actor"
      ? params.inboundActorId !== undefined
        ? params.inboundActorId
        : (existing.inbound_actor_id as string | null | undefined) || null
      : null
  const resolvedInboundActorId = await assertTransportAccountInboundActor({
    workspaceId: params.workspaceId,
    ownerScope: nextOwnerScope,
    ownerWorkspaceMemberId: resolvedOwnerWorkspaceMemberId,
    inboundActorMode: nextInboundActorMode,
    inboundActorId: nextInboundActorId,
  })
  const row = await db.transaction().execute(async (tx) => {
    const updated = await tx
      .updateTable("transport_accounts")
      .set({
        display_name: params.displayName?.trim() || existing.display_name,
        owner_scope: nextOwnerScope,
        owner_workspace_member_id: resolvedOwnerWorkspaceMemberId,
        inbound_actor_mode: nextInboundActorMode,
        inbound_actor_id: resolvedInboundActorId,
        connection_mode: nextConnectionMode,
        status: nextStatus,
        credentials:
          normalizedCredentials as TableInsert<"transport_accounts">["credentials"],
        config: (params.config !== undefined
          ? params.config
          : parseJsonObject(
              existing.config
            )) as TableInsert<"transport_accounts">["config"],
        metadata: (params.metadata !== undefined
          ? params.metadata
          : parseJsonObject(
              existing.metadata
            )) as TableInsert<"transport_accounts">["metadata"],
        updated_at: sql`NOW()`,
      })
      .where("workspace_id", "=", params.workspaceId)
      .where("id", "=", params.accountId)
      .returningAll()
      .executeTakeFirstOrThrow()

    // Recovery hooks: detect transitions that re-enable previously
    // skipped interaction projections, and re-arm matching rows in
    // the same tx so a crash between state change and recovery can't
    // strand approvals.
    const wasActive = (existing.status as string) === "active"
    const isNowActive = nextStatus === "active"
    if (!wasActive && isNowActive) {
      await recoverSkippedProjectionsForRecoveryEvent(tx, {
        kind: "account_status_activated",
        transportAccountId: params.accountId,
      })
    }
    const previousConnectionMode = existing.connection_mode as
      | string
      | undefined
    if (
      previousConnectionMode === "webhook" &&
      nextConnectionMode === "long_connection"
    ) {
      await recoverSkippedProjectionsForRecoveryEvent(tx, {
        kind: "connection_mode_changed_to_long_connection",
        transportAccountId: params.accountId,
      })
    }
    if (
      existing.transport_kind === "qq" &&
      nextConnectionMode === "webhook" &&
      params.config !== undefined
    ) {
      // Only fire when the QQ webhook account just got its OQ2 gate
      // flipped on. We compare against the previous parsed config so
      // a re-PUT of the same value doesn't fire spurious recoveries.
      const previousConfig = parseJsonObject(existing.config) as Record<
        string,
        unknown
      >
      const wasConfirmed = previousConfig.webhookInboundConfirmed === true
      const isNowConfirmed = params.config.webhookInboundConfirmed === true
      if (!wasConfirmed && isNowConfirmed) {
        await recoverSkippedProjectionsForRecoveryEvent(tx, {
          kind: "config_webhook_confirmed",
          transportAccountId: params.accountId,
        })
      }
    }
    return updated
  })

  return normalizeAccountRow(row)
}
