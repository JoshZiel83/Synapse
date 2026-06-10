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
import { nowIsoInstant } from "@synapse/shared/datetime"
import {
  db,
  withDbTransaction,
  type DatabaseTransaction,
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
import {
  orderAccountRecoveryActions,
  planAccountRecoveryActions,
} from "./account-recovery-planner.js"
import {
  recoverSkippedProjectionsForRecoveryEvent,
  reEnableAutoDisabledBindings,
} from "./recovery.js"

// ───────────────────────── Assertions ─────────────────────────

/**
 * Validate credentials via the connector and return the connector's
 * normalized form when available. The normalized form is what should be
 * persisted to the DB (it has whitespace trimmed and connector defaults
 * applied).
 *
 * Disabled accounts skip validation entirely — they may legitimately have
 * blank or expired credentials waiting to be filled in.
 *
 * Pure: implementation lives in service/account-credentials.ts (kept
 * DB-free so its tests don't drag in the pg.Pool). Re-exported here for
 * back-compat.
 */
export {
  assertExpectedTransportKind,
  mergeAccountCredentials,
  validateAndNormalizeAccountConfig,
  validateAndNormalizeAccountCredentials,
} from "./account-credentials.js"
import {
  assertExpectedTransportKind,
  mergeAccountCredentials,
  validateAndNormalizeAccountConfig,
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
    .selectFrom("actors as actor")
    .innerJoin("workspaceApps as app", "app.id", "actor.id")
    .select("actor.id")
    .where("actor.id", "=", actorId)
    .where("app.workspaceId", "=", params.workspaceId)
    .where("app.deletedAt", "is", null)
    .where("app.status", "=", "active")
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
    .selectFrom("transportAccounts")
    .selectAll()
    .where("workspaceId", "=", workspaceId)
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
    .selectFrom("transportAccounts")
    .selectAll()
    .where("workspaceId", "=", params.workspaceId)
    .where("transportKind", "=", params.transportKind)
    .where("accountKey", "=", params.accountKey.trim())
    .limit(1)
    .executeTakeFirst()
}

async function loadTransportAccountRowById(accountId: string) {
  return db
    .selectFrom("transportAccounts")
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
    .selectFrom("transportAccounts")
    .selectAll()
    .where("workspaceId", "=", workspaceId)
    .orderBy("createdAt", "desc")
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
    .selectFrom("transportAccounts")
    .selectAll()
    .where("id", "=", params.accountId)
    .where("transportKind", "=", params.transportKind)
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
    pendingAutoLinkConsumedAt: nowIsoInstant(),
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
    .selectFrom("transportAccounts")
    .selectAll()
    .where("status", "=", "active")

  if (params?.connectionMode) {
    builder = builder.where("connectionMode", "=", params.connectionMode)
  }
  if (params?.transportKind) {
    builder = builder.where("transportKind", "=", params.transportKind)
  }

  const rows = await builder.orderBy("createdAt", "asc").execute()
  return rows.map(normalizeAccountRow)
}

export async function listTransportSessions(
  workspaceId: string
): Promise<TransportSessionSummary[]> {
  const inboundActivity = db
    .selectFrom("transportMessageLinks")
    .select("transportEndpointId")
    .select(sql<Date | null>`MAX(created_at)`.as("lastInboundAt"))
    .where("direction", "=", "inbound")
    .groupBy("transportEndpointId")
    .as("inbound_activity")

  const outboundActivity = db
    .selectFrom("transportMessageLinks")
    .select("transportEndpointId")
    .select(sql<Date | null>`MAX(created_at)`.as("lastOutboundAt"))
    .where("direction", "=", "outbound")
    .groupBy("transportEndpointId")
    .as("outbound_activity")

  const rows = await db
    .selectFrom("transportEndpoints as te")
    .innerJoin("transportAccounts as ta", "ta.id", "te.transportAccountId")
    .leftJoin(
      "conversationTransportBindings as ctb",
      "ctb.transportEndpointId",
      "te.id"
    )
    .leftJoin("conversations as c", "c.id", "ctb.conversationId")
    .leftJoin(inboundActivity, "inbound_activity.transportEndpointId", "te.id")
    .leftJoin(
      outboundActivity,
      "outbound_activity.transportEndpointId",
      "te.id"
    )
    .select([
      "ctb.id as bindingId",
      "ctb.workspaceId",
      "ctb.conversationId",
      "ctb.outboundEnabled",
      "ctb.inboundActorMode",
      "ctb.inboundActorId",
      "ctb.metadata as bindingMetadata",
      "ctb.createdAt as bindingCreatedAt",
      "ctb.updatedAt as bindingUpdatedAt",
      "c.title as conversationTitle",
      "ta.id",
      "ta.workspaceId as accountWorkspaceId",
      "ta.accountKey",
      "ta.displayName",
      "ta.transportKind",
      "ta.ownerScope",
      "ta.ownerWorkspaceMemberId",
      "ta.inboundActorMode as accountInboundActorMode",
      "ta.inboundActorId as accountInboundActorId",
      "ta.connectionMode",
      "ta.status",
      "ta.credentials",
      "ta.config",
      "ta.metadata",
      "ta.createdAt",
      "ta.updatedAt",
      "te.id as endpointId",
      "te.transportAccountId",
      "te.endpointType",
      "te.externalId as endpointExternalId",
      "te.parentExternalId",
      "te.displayName as endpointDisplayName",
      "te.metadata as endpointMetadata",
      "te.createdAt as endpointCreatedAt",
      "te.updatedAt as endpointUpdatedAt",
      "inbound_activity.lastInboundAt as lastInboundAt",
      "outbound_activity.lastOutboundAt as lastOutboundAt",
    ])
    .where("ta.workspaceId", "=", workspaceId)
    .orderBy(
      sql`COALESCE(inbound_activity.last_inbound_at, outbound_activity.last_outbound_at, te.updated_at)`,
      "desc"
    )
    .orderBy("te.createdAt", "desc")
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
  const normalizedConfig = validateAndNormalizeAccountConfig({
    transportKind: params.transportKind,
    connectionMode: params.connectionMode,
    status: nextStatus,
    config: params.config,
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
  // Per-transport config normalization — gate AT the service layer
  // (rather than only in transport-specific controllers) so the
  // generic /im/accounts route can't bypass it. Throws on invalid
  // input; the API controller catches and maps to 400.
  // (shared-prep version above already normalizes config — keep the
  // single call; the QQ-side duplicate was redundant.)

  const row = await db
    .insertInto("transportAccounts")
    .values({
      id: uuidv4(),
      workspaceId: params.workspaceId,
      transportKind: params.transportKind,
      accountKey: params.accountKey.trim(),
      displayName: params.displayName.trim(),
      ownerScope: ownerScope,
      ownerWorkspaceMemberId: ownerWorkspaceMemberId,
      inboundActorMode: inboundActorMode,
      inboundActorId: inboundActorId,
      connectionMode: params.connectionMode,
      status: nextStatus,
      credentials:
        normalizedCredentials as TableInsert<"transportAccounts">["credentials"],
      config: normalizedConfig as TableInsert<"transportAccounts">["config"],
      metadata: (params.metadata ||
        {}) as TableInsert<"transportAccounts">["metadata"],
      createdAt: sql`NOW()`,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return normalizeAccountRow(row)
}

export async function updateTransportAccount(params: {
  workspaceId: string
  accountId: string
  /**
   * Optional kind guard. When supplied (typically by per-transport
   * routes like `PUT /im/accounts/feishu/:id`), the existing account
   * must match this value or the call fails with
   * `404 transport_account_kind_mismatch`. Generic routes that
   * legitimately span kinds omit this.
   */
  expectedTransportKind?: TransportKind
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
    // statusCode lets the Fastify error handler surface this as 404
    // rather than swallowing it into 500.
    throw Object.assign(new Error("Transport account not found"), {
      statusCode: 404 as const,
      code: "transport_account_not_found" as const,
    })
  }
  // Per-transport PUT routes pass `expectedTransportKind`; reject
  // wrong-kind hits with a stable 404 + code instead of silently
  // rewriting the wrong account.
  assertExpectedTransportKind(
    { transportKind: existing.transportKind as TransportKind },
    params.expectedTransportKind
  )

  const nextConnectionMode =
    params.connectionMode ||
    (existing.connectionMode as TransportConnectionMode)
  assertSupportedConnectionMode(
    existing.transportKind as TransportKind,
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
    (existing.ownerScope as TransportAccountOwnerScope | undefined) ||
    "workspace"
  const nextOwnerWorkspaceMemberId =
    nextOwnerScope === "workspace"
      ? null
      : params.ownerWorkspaceMemberId !== undefined
        ? params.ownerWorkspaceMemberId
        : (existing.ownerWorkspaceMemberId as string | null | undefined) || null
  const normalizedCredentials = validateAndNormalizeAccountCredentials({
    transportKind: existing.transportKind as TransportKind,
    connectionMode: nextConnectionMode,
    status: nextStatus,
    credentials: mergedCredentials,
  })
  const normalizedConfig = validateAndNormalizeAccountConfig({
    transportKind: existing.transportKind as TransportKind,
    connectionMode: nextConnectionMode,
    status: nextStatus,
    config:
      params.config !== undefined
        ? params.config
        : parseJsonObject(existing.config),
  })
  const resolvedOwnerWorkspaceMemberId = await assertTransportAccountOwner({
    workspaceId: params.workspaceId,
    ownerScope: nextOwnerScope,
    ownerWorkspaceMemberId: nextOwnerWorkspaceMemberId,
  })
  const nextInboundActorMode =
    params.inboundActorMode ||
    (existing.inboundActorMode as
      | TransportAccountInboundActorMode
      | undefined) ||
    "none"
  const nextInboundActorId =
    nextInboundActorMode === "specified_actor"
      ? params.inboundActorId !== undefined
        ? params.inboundActorId
        : (existing.inboundActorId as string | null | undefined) || null
      : null
  const resolvedInboundActorId = await assertTransportAccountInboundActor({
    workspaceId: params.workspaceId,
    ownerScope: nextOwnerScope,
    ownerWorkspaceMemberId: resolvedOwnerWorkspaceMemberId,
    inboundActorMode: nextInboundActorMode,
    inboundActorId: nextInboundActorId,
  })

  // Wrap UPDATE + recovery executor in one transaction so a
  // half-applied state can't leave the account updated but the
  // recovery side-effects skipped (or vice versa).
  const updatedAccount = await withDbTransaction(async (tx) => {
    const row = await tx
      .updateTable("transportAccounts")
      .set({
        displayName: params.displayName?.trim() || existing.displayName,
        ownerScope: nextOwnerScope,
        ownerWorkspaceMemberId: resolvedOwnerWorkspaceMemberId,
        inboundActorMode: nextInboundActorMode,
        inboundActorId: resolvedInboundActorId,
        connectionMode: nextConnectionMode,
        status: nextStatus,
        credentials:
          normalizedCredentials as TableInsert<"transportAccounts">["credentials"],
        config: normalizedConfig as TableInsert<"transportAccounts">["config"],
        metadata: (params.metadata !== undefined
          ? params.metadata
          : parseJsonObject(
              existing.metadata
            )) as TableInsert<"transportAccounts">["metadata"],
      })
      .where("workspaceId", "=", params.workspaceId)
      .where("id", "=", params.accountId)
      .returningAll()
      .executeTakeFirstOrThrow()

    const previousSummary = normalizeAccountRow(existing)
    const nextSummary = normalizeAccountRow(row)
    const actions = orderAccountRecoveryActions(
      planAccountRecoveryActions({
        previous: previousSummary,
        next: nextSummary,
        incomingConfig: params.config,
      })
    )
    await executeAccountRecoveryActions({
      tx,
      workspaceId: params.workspaceId,
      accountId: params.accountId,
      actions,
    })
    return nextSummary
  })

  return updatedAccount
}

/**
 * Generic dispatcher for recovery actions emitted by a connector's
 * `planAccountRecoveryActions?()` hook. The set of `action.type`
 * values is a closed enum on `AccountRecoveryAction` — adding a new
 * type requires updating this switch (intentional: keeps the
 * executor a single source of truth and prevents transport-specific
 * branches from creeping into `accounts.ts`).
 *
 * Execution order is the responsibility of
 * `orderAccountRecoveryActions` upstream; this loop just walks
 * actions in the given order.
 */
async function executeAccountRecoveryActions(params: {
  tx: DatabaseTransaction
  workspaceId: string
  /**
   * The account whose update triggered planning. We need its id so the
   * `recoverSkippedTaskProjections` dispatch can target the
   * correct `transport_account_id` in
   * `tool_call_task_transport_projections` recovery — the connector hook
   * is account-scoped and doesn't carry the id through the action
   * data shape.
   */
  accountId: string
  actions: Array<
    | { type: "reEnableAutoDisabledBindings"; reason: string }
    | {
        type: "recoverSkippedTaskProjections"
        eventKind:
          | "account_status_activated"
          | "connection_mode_changed_to_long_connection"
          | "config_webhook_confirmed"
      }
  >
}) {
  for (const action of params.actions) {
    switch (action.type) {
      case "reEnableAutoDisabledBindings": {
        await reEnableAutoDisabledBindings({
          workspaceId: params.workspaceId,
          reason: action.reason,
          tx: params.tx,
        })
        break
      }
      case "recoverSkippedTaskProjections": {
        // Re-arm skipped `tool_call_task_transport_projections` rows
        // matching this account's id + the connector-supplied event
        // kind. Same tx so the recovery commits with the account
        // UPDATE; a crash between the two would leave projections
        // stranded.
        await recoverSkippedProjectionsForRecoveryEvent(params.tx, {
          kind: action.eventKind,
          transportAccountId: params.accountId,
        })
        break
      }
      default: {
        const _exhaustive: never = action
        // Defensive: never reachable as long as caller respects the
        // typed `actions` array.
        throw new Error(
          `unknown AccountRecoveryAction type: ${JSON.stringify(_exhaustive)}`
        )
      }
    }
  }
}
