/**
 * conversation_transport_bindings domain: per-conversation binding to an
 * (account, endpoint) pair + the settings that drive inbound/outbound
 * behavior. Includes endpoint upsert because every binding write also
 * writes a transport_endpoints row.
 *
 * Extracted from service.ts. service.ts re-exports for back-compat.
 */

import { sql } from "kysely"
import { transaction } from "../../../infrastructure/database/index.js"
import {
  db,
  executeCompiledQuery,
  executeTakeFirst,
  type TableInsert,
} from "../../../infrastructure/database/kysely.js"
import { v4 as uuidv4 } from "uuid"
import type {
  TransportConversationInboundActorMode,
  TransportEndpointType,
  TransportKind,
} from "@synapse/shared/types"
import { assertSupportedEndpointType } from "../connectors/index.js"
import { readQqAccountConfig } from "../connectors/qq/qq-account-config.js"
import {
  normalizeAccountRow,
  normalizeBindingRow,
  parseJsonObject,
} from "./_helpers.js"
import {
  recoverSkippedProjectionsForRecoveryEvent,
  recoverSkippedProjectionsForRecoveryEventViaClient,
} from "./recovery.js"

/**
 * Per-transport defaults applied when CREATING a binding. The legacy
 * default `outbound_enabled = true` is still right for Feishu / Weixin
 * / Wecom, but a QQ webhook account whose operator has not yet flipped
 * `webhookInboundConfirmed` should default outbound DISABLED — otherwise
 * the projection worker will produce link rows that fail (we can't reply
 * without an inbound anchor) and the operator has to manually toggle
 * outbound off on every new binding.
 *
 * The auto-disabled marker on metadata lets recovery hooks distinguish
 * "system disabled because OQ2 hadn't been verified" (re-enable when
 * webhookInboundConfirmed flips to true) from "operator explicitly
 * disabled this binding" (leave it alone).
 */
export interface BindingDefaults {
  outboundEnabled: boolean
  metadata: Record<string, unknown>
}

export function transportKindDefaultsForBindings(params: {
  transportKind: TransportKind
  connectionMode: string | undefined
  accountConfig: Record<string, unknown> | undefined
}): BindingDefaults {
  if (params.transportKind === "qq" && params.connectionMode === "webhook") {
    // Synthetic account shape — readQqAccountConfig only reads `config`.
    const config = readQqAccountConfig({
      config: params.accountConfig ?? {},
    } as never)
    if (!config.webhookInboundConfirmed) {
      return {
        outboundEnabled: false,
        metadata: { autoDisabledReason: "webhook_inbound_unavailable" },
      }
    }
  }
  return { outboundEnabled: true, metadata: {} }
}
import {
  assertConversationInboundActor,
  loadTransportAccountRow,
  listTransportSessions,
} from "./accounts.js"

export async function getConversationTransportBinding(params: {
  workspaceId: string
  conversationId: string
}) {
  const row = await db
    .selectFrom("conversation_transport_bindings as ctb")
    .innerJoin("transport_accounts as ta", "ta.id", "ctb.transport_account_id")
    .innerJoin(
      "transport_endpoints as te",
      "te.id",
      "ctb.transport_endpoint_id"
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
      "ta.id",
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
    ])
    .where("ctb.workspace_id", "=", params.workspaceId)
    .where("ctb.conversation_id", "=", params.conversationId)
    .limit(1)
    .executeTakeFirst()

  return row ? normalizeBindingRow(row) : null
}

export async function findConversationTransportBindingByEndpoint(params: {
  transportAccountId: string
  endpointType: TransportEndpointType
  endpointExternalId: string
}) {
  const row = await db
    .selectFrom("conversation_transport_bindings as ctb")
    .innerJoin("transport_accounts as ta", "ta.id", "ctb.transport_account_id")
    .innerJoin(
      "transport_endpoints as te",
      "te.id",
      "ctb.transport_endpoint_id"
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
      "ta.id",
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
    ])
    .where("ctb.transport_account_id", "=", params.transportAccountId)
    .where("te.endpoint_type", "=", params.endpointType)
    .where("te.external_id", "=", params.endpointExternalId.trim())
    .limit(1)
    .executeTakeFirst()

  return row ? normalizeBindingRow(row) : null
}

export async function upsertConversationTransportBinding(params: {
  workspaceId: string
  conversationId: string
  transportAccountId: string
  endpointType: TransportEndpointType
  endpointExternalId: string
  parentExternalId?: string
  endpointDisplayName?: string
  outboundEnabled?: boolean
  inboundActorMode?: TransportConversationInboundActorMode
  inboundActorId?: string | null
  metadata?: Record<string, unknown>
}) {
  const account = await loadTransportAccountRow(
    params.workspaceId,
    params.transportAccountId
  )
  if (!account) {
    throw new Error("Transport account not found")
  }

  assertSupportedEndpointType(
    account.transport_kind as TransportKind,
    params.endpointType
  )
  const inboundActorMode = params.inboundActorMode || "inherit_account"
  const inboundActorId = await assertConversationInboundActor({
    workspaceId: params.workspaceId,
    inboundActorMode,
    inboundActorId: params.inboundActorId,
  })

  // Per-transport defaults — currently only QQ webhook + !confirmed
  // forces outbound off + a marker so the recovery hook (when the
  // operator flips webhookInboundConfirmed) knows it may auto-re-enable
  // this binding. The caller's explicit `outboundEnabled` always wins,
  // so manual UI choices override the per-transport default.
  const defaults = transportKindDefaultsForBindings({
    transportKind: account.transport_kind as TransportKind,
    connectionMode: account.connection_mode as string | undefined,
    accountConfig: parseJsonObject(account.config) as Record<string, unknown>,
  })
  const effectiveOutboundEnabled =
    params.outboundEnabled ?? defaults.outboundEnabled
  // Only stamp the auto-disabled marker when the caller did NOT pass an
  // explicit `outboundEnabled` value AND the per-transport default
  // disabled outbound. Without this gate, a user-driven create with
  // explicit `outboundEnabled: false` would also be flagged for auto
  // re-enable, which the plan explicitly forbids.
  const bindingMetadata: Record<string, unknown> = {
    ...(params.metadata || {}),
    ...(params.outboundEnabled === undefined && !defaults.outboundEnabled
      ? defaults.metadata
      : {}),
  }

  await transaction(async (client) => {
    const endpointRow = await executeTakeFirst<{ id: string }>(
      client,
      db
        .insertInto("transport_endpoints")
        .values({
          id: uuidv4(),
          transport_account_id: params.transportAccountId,
          endpoint_type: params.endpointType,
          external_id: params.endpointExternalId.trim(),
          parent_external_id: params.parentExternalId?.trim() || null,
          display_name: params.endpointDisplayName?.trim() || null,
          metadata: (params.metadata ||
            {}) as TableInsert<"transport_endpoints">["metadata"],
          created_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .onConflict((oc) =>
          oc
            .columns(["transport_account_id", "endpoint_type", "external_id"])
            .doUpdateSet({
              parent_external_id: sql`excluded.parent_external_id`,
              display_name: sql`COALESCE(excluded.display_name, transport_endpoints.display_name)`,
              metadata: sql`transport_endpoints.metadata || excluded.metadata`,
              updated_at: sql`NOW()`,
            })
        )
        .returning("id")
    )
    const endpointId = endpointRow?.id
    if (!endpointId) {
      throw new Error("Failed to upsert transport endpoint")
    }

    await executeCompiledQuery(
      client,
      db
        .insertInto("conversation_transport_bindings")
        .values({
          id: uuidv4(),
          workspace_id: params.workspaceId,
          conversation_id: params.conversationId,
          transport_account_id: params.transportAccountId,
          transport_endpoint_id: endpointId,
          outbound_enabled: effectiveOutboundEnabled,
          inbound_actor_mode: inboundActorMode,
          inbound_actor_id: inboundActorId,
          metadata:
            bindingMetadata as TableInsert<"conversation_transport_bindings">["metadata"],
          created_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .onConflict((oc) =>
          oc.column("conversation_id").doUpdateSet({
            transport_account_id: sql`excluded.transport_account_id`,
            transport_endpoint_id: sql`excluded.transport_endpoint_id`,
            outbound_enabled: sql`excluded.outbound_enabled`,
            inbound_actor_mode: sql`excluded.inbound_actor_mode`,
            inbound_actor_id: sql`excluded.inbound_actor_id`,
            metadata: sql`excluded.metadata`,
            updated_at: sql`NOW()`,
          })
        )
    )

    // Recovery: a fresh / replaced binding may resolve projections that
    // were previously skipped for any of the recoverable reasons
    // (no_binding / not_supported_in_v1 / outbound_disabled /
    // webhook_inbound_unavailable). Fire in the same tx so the create +
    // re-arm commit together. `client` here is a pg.PoolClient (see
    // `transaction(async (client) => ...)` above) so we use the
    // PoolClient-flavored variant of the helper.
    await recoverSkippedProjectionsForRecoveryEventViaClient(client, {
      kind: "binding_created_or_replaced",
      conversationId: params.conversationId,
      transportAccountId: params.transportAccountId,
      transportEndpointId: endpointId,
    })
  })

  return getConversationTransportBinding({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
  })
}

export async function updateConversationTransportSettings(params: {
  workspaceId: string
  conversationId: string
  outboundEnabled?: boolean
  inboundActorMode?: TransportConversationInboundActorMode
  inboundActorId?: string | null
  metadata?: Record<string, unknown>
}) {
  const existing = await getConversationTransportBinding({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
  })
  if (!existing) {
    throw new Error("Transport session not found for this conversation")
  }

  const nextInboundActorMode =
    params.inboundActorMode || existing.inboundActorMode
  const nextInboundActorId =
    nextInboundActorMode === "specified_actor"
      ? params.inboundActorId !== undefined
        ? params.inboundActorId
        : existing.inboundActorId || null
      : null
  const resolvedInboundActorId = await assertConversationInboundActor({
    workspaceId: params.workspaceId,
    inboundActorMode: nextInboundActorMode,
    inboundActorId: nextInboundActorId,
  })

  const updates: Record<string, unknown> = {
    updated_at: sql`NOW()`,
  }
  if (params.outboundEnabled !== undefined) {
    updates.outbound_enabled = params.outboundEnabled
  }
  if (
    params.inboundActorMode !== undefined ||
    params.inboundActorId !== undefined
  ) {
    updates.inbound_actor_mode = nextInboundActorMode
    updates.inbound_actor_id = resolvedInboundActorId
  }
  if (params.metadata !== undefined) {
    updates.metadata = {
      ...parseJsonObject(existing.metadata),
      ...(params.metadata || {}),
    } as TableInsert<"conversation_transport_bindings">["metadata"]
  }

  // Wrap in a tx so the outbound_enabled change + projection recovery
  // land atomically. Without this a crash between the binding UPDATE
  // and the recovery SQL would leave skipped projections stranded even
  // though the operator just re-enabled outbound.
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("conversation_transport_bindings")
      .set(updates)
      .where("workspace_id", "=", params.workspaceId)
      .where("conversation_id", "=", params.conversationId)
      .execute()

    // Recovery: if outbound just flipped false → true, re-arm any
    // `outbound_disabled` projections pinned to this conversation's
    // (account, endpoint). The endpoint id is taken from the original
    // existing row — outbound toggling never replaces the endpoint.
    if (params.outboundEnabled === true && existing.outboundEnabled === false) {
      await recoverSkippedProjectionsForRecoveryEvent(tx, {
        kind: "outbound_re_enabled",
        transportAccountId: existing.account.id,
        transportEndpointId: existing.endpoint.id,
      })
    }
  })

  return getConversationTransportBinding({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
  })
}

export async function updateTransportSessionSettings(params: {
  workspaceId: string
  transportEndpointId: string
  outboundEnabled?: boolean
  inboundActorMode?: TransportConversationInboundActorMode
  inboundActorId?: string | null
  metadata?: Record<string, unknown>
}) {
  const row = await db
    .selectFrom("conversation_transport_bindings")
    .select("conversation_id")
    .where("workspace_id", "=", params.workspaceId)
    .where("transport_endpoint_id", "=", params.transportEndpointId)
    .limit(1)
    .executeTakeFirst()
  const conversationId = row?.conversation_id as string | undefined
  if (!conversationId) {
    throw new Error("Transport session not found")
  }

  await updateConversationTransportSettings({
    workspaceId: params.workspaceId,
    conversationId,
    outboundEnabled: params.outboundEnabled,
    inboundActorMode: params.inboundActorMode,
    inboundActorId: params.inboundActorId,
    metadata: params.metadata,
  })

  const updatedSessions = await listTransportSessions(params.workspaceId)
  return (
    updatedSessions.find(
      (session) => session.id === params.transportEndpointId
    ) || null
  )
}
