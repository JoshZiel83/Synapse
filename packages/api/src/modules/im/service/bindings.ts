/**
 * conversation_transport_bindings domain: per-conversation binding to an
 * (account, endpoint) pair + the settings that drive inbound/outbound
 * behavior. Includes endpoint upsert because every binding write also
 * writes a transport_endpoints row.
 *
 * The raw queries + transactions live in repo-bindings.ts (a repo file,
 * which may import the db client + sql); this file keeps the business
 * orchestration (connector binding defaults, friendly FK/trigger guards,
 * actor resolution, outbound flip detection) and is re-exported by
 * service.ts for back-compat.
 */

import type {
  TransportConversationInboundActorMode,
  TransportEndpointType,
  TransportKind,
} from "@synapse/shared/types"
import { assertSupportedEndpointType } from "../connectors/index.js"
import { tryGetConnector } from "../connectors/registry.js"
import { normalizeAccountRow, normalizeBindingRow } from "./_helpers.js"
import {
  assertConversationInboundActor,
  loadTransportAccountRow,
  listTransportSessions,
} from "./accounts.js"
import type { KyselyDb } from "../../../infrastructure/database/kysely.js"
import {
  existsConflictingExternalParticipant,
  existsConversationTransportBinding,
  selectConversationIdByEndpoint,
  selectConversationTransportBindingByEndpointRow,
  selectConversationTransportBindingRow,
  selectConversationWorkspaceId,
  updateConversationTransportBindingSettings,
  writeConversationTransportBinding,
} from "./repo-bindings.js"

export async function getConversationTransportBinding(params: {
  workspaceId: string
  conversationId: string
}) {
  const row = await selectConversationTransportBindingRow(params)
  return row ? normalizeBindingRow(row) : null
}

/**
 * Lightweight existence probe used to derive a conversation's "IM-ness" (a
 * conversation is IM iff it has a transport binding). Far cheaper than
 * getConversationTransportBinding, which hydrates the full account+endpoint row.
 * Pass `workspaceId` to additionally scope the check to that workspace (the
 * binding table is workspace-scoped); omitting it checks by conversation alone
 * (conversation_id is UNIQUE on the binding table).
 *
 * Pass `queryable` (a Kysely transaction) to read inside an open transaction so
 * a binding created earlier in the SAME transaction is visible (fresh
 * derivation); omit it to read committed state via the module pool.
 */
export async function hasConversationTransportBinding(params: {
  conversationId: string
  workspaceId?: string
  queryable?: KyselyDb
}): Promise<boolean> {
  return existsConversationTransportBinding(params)
}

export async function findConversationTransportBindingByEndpoint(params: {
  transportAccountId: string
  endpointType: TransportEndpointType
  endpointExternalId: string
}) {
  const row = await selectConversationTransportBindingByEndpointRow(params)
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

  // The conversation must belong to the same workspace as the binding/account.
  // The DB enforces this via composite FKs, but check here for a friendly error
  // rather than a raw FK violation (and to fail before the endpoint upsert).
  const conversationRow = await selectConversationWorkspaceId(
    params.conversationId
  )
  if (!conversationRow) {
    throw new Error("Conversation not found")
  }
  if (conversationRow.workspaceId !== params.workspaceId) {
    throw new Error("Conversation does not belong to the binding's workspace")
  }

  // Friendly guard mirroring the DB trigger tg_binding_account_consistency:
  // re-binding a conversation to a different transport account is forbidden
  // while external participants from another account remain (they would become
  // account-mismatched). The trigger is the hard enforcement; this surfaces a
  // clean error instead of a raw trigger exception.
  const conflictingExternal = await existsConflictingExternalParticipant({
    conversationId: params.conversationId,
    transportAccountId: params.transportAccountId,
  })
  if (conflictingExternal) {
    throw new Error(
      "Cannot re-bind conversation to a different transport account while external participants from another account remain"
    )
  }

  assertSupportedEndpointType(
    account.transportKind as TransportKind,
    params.endpointType
  )
  const inboundActorMode = params.inboundActorMode || "inherit_account"
  const inboundActorId = await assertConversationInboundActor({
    workspaceId: params.workspaceId,
    inboundActorMode,
    inboundActorId: params.inboundActorId,
  })

  // Connector-supplied binding defaults — currently used by transports
  // (e.g. QQ) that need to default `outbound_enabled = false` plus a
  // stable `metadata.autoDisabledReason` marker until a precondition
  // (webhook confirmation, etc) is satisfied. Generic helper only
  // applies the override when the caller did NOT pass an explicit
  // `outboundEnabled`, so manual UI flips stay authoritative.
  const connector = tryGetConnector(account.transportKind as TransportKind)
  const defaults = connector?.getBindingDefaults?.({
    account: normalizeAccountRow(account),
    endpoint: {
      endpointType: params.endpointType,
      externalId: params.endpointExternalId.trim(),
    },
  })
  const effectiveOutboundEnabled =
    params.outboundEnabled !== undefined
      ? params.outboundEnabled
      : (defaults?.outboundEnabled ?? true)
  const baseMetadata = params.metadata || {}
  const effectiveMetadata =
    params.outboundEnabled === undefined &&
    defaults?.outboundEnabled === false &&
    defaults.metadata
      ? { ...baseMetadata, ...defaults.metadata }
      : baseMetadata

  await writeConversationTransportBinding({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    transportAccountId: params.transportAccountId,
    endpointType: params.endpointType,
    endpointExternalId: params.endpointExternalId,
    parentExternalId: params.parentExternalId,
    endpointDisplayName: params.endpointDisplayName,
    endpointMetadata: params.metadata || {},
    outboundEnabled: effectiveOutboundEnabled,
    inboundActorMode,
    inboundActorId,
    metadata: effectiveMetadata,
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
  const specifiedActorId =
    params.inboundActorId !== undefined
      ? params.inboundActorId
      : existing.inboundActorId || null
  const nextInboundActorId =
    nextInboundActorMode === "specified_actor" ? specifiedActorId : null
  const resolvedInboundActorId = await assertConversationInboundActor({
    workspaceId: params.workspaceId,
    inboundActorMode: nextInboundActorMode,
    inboundActorId: nextInboundActorId,
  })

  const updates: Record<string, unknown> = {}
  if (params.outboundEnabled !== undefined) {
    updates.outboundEnabled = params.outboundEnabled
  }
  if (
    params.inboundActorMode !== undefined ||
    params.inboundActorId !== undefined
  ) {
    updates.inboundActorMode = nextInboundActorMode
    updates.inboundActorId = resolvedInboundActorId
  }
  if (params.metadata !== undefined) {
    updates.metadata = {
      ...existing.metadata,
      ...(params.metadata || {}),
    }
  }

  // Recovery: if outbound just flipped false → true, re-arm any
  // `outbound_disabled` projections pinned to this conversation's
  // (account, endpoint). The endpoint id is taken from the original
  // existing row — outbound toggling never replaces the endpoint. The
  // flip detection is the business rule (stays here); the atomic
  // UPDATE + re-arm commit together in the repo.
  const recovery =
    params.outboundEnabled === true && existing.outboundEnabled === false
      ? ({
          kind: "outbound_re_enabled" as const,
          transportAccountId: existing.account.id,
          transportEndpointId: existing.endpoint.id,
        } as const)
      : null

  await updateConversationTransportBindingSettings({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    updates,
    recovery,
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
  const conversationId = await selectConversationIdByEndpoint({
    workspaceId: params.workspaceId,
    transportEndpointId: params.transportEndpointId,
  })
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
