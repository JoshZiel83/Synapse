/**
 * conversation_transport_bindings repo — owns the raw DB queries +
 * transactions for the bindings domain. Lives in a repo file
 * (`repo-bindings.ts` matches the guard's isRepo glob) so it may
 * legitimately import the db client, `withDbTransaction`, and the
 * `sql` tag.
 *
 * bindings.ts keeps the business orchestration (connector binding
 * defaults, friendly FK/trigger guards, actor resolution, outbound
 * flip detection) and calls these repo functions for each DB step.
 */

import { sql } from "kysely"
import {
  db,
  withDbTransaction,
  type KyselyDb,
} from "../../../infrastructure/database/kysely.js"
import type {
  TransportEndpointMetadataInsert,
  ConversationTransportBindingMetadataInsert,
} from "../repo.types.js"
import { v4 as uuidv4 } from "uuid"
import type {
  TransportConversationInboundActorMode,
  TransportEndpointType,
} from "@synapse/shared/types"
import {
  recoverSkippedProjectionsForRecoveryEvent,
  type SkippedRecoveryEvent,
} from "./repo-recovery.js"

const BINDING_SELECTION = [
  "ctb.id as bindingId",
  "ctb.workspaceId as workspaceId",
  "ctb.conversationId as conversationId",
  "ctb.outboundEnabled as outboundEnabled",
  "ctb.inboundActorMode as inboundActorMode",
  "ctb.inboundActorId as inboundActorId",
  "ctb.metadata as bindingMetadata",
  "ctb.createdAt as bindingCreatedAt",
  "ctb.updatedAt as bindingUpdatedAt",
  "ta.id",
  "ta.accountKey as accountKey",
  "ta.displayName as displayName",
  "ta.transportKind as transportKind",
  "ta.ownerScope as ownerScope",
  "ta.ownerWorkspaceMemberId as ownerWorkspaceMemberId",
  "ta.inboundActorMode as accountInboundActorMode",
  "ta.inboundActorId as accountInboundActorId",
  "ta.connectionMode as connectionMode",
  "ta.status",
  "ta.credentials",
  "ta.config",
  "ta.metadata",
  "ta.createdAt as createdAt",
  "ta.updatedAt as updatedAt",
  "te.id as endpointId",
  "te.transportAccountId as transportAccountId",
  "te.endpointType as endpointType",
  "te.externalId as endpointExternalId",
  "te.parentExternalId as parentExternalId",
  "te.displayName as endpointDisplayName",
  "te.metadata as endpointMetadata",
  "te.createdAt as endpointCreatedAt",
  "te.updatedAt as endpointUpdatedAt",
] as const

/**
 * Load the full (binding ⋈ account ⋈ endpoint) row for a conversation.
 * Returns the raw camelCase joined row (Dates intact); normalization to
 * the *Summary shape stays in the service via normalizeBindingRow.
 */
export async function selectConversationTransportBindingRow(params: {
  workspaceId: string
  conversationId: string
}) {
  return db
    .selectFrom("conversationTransportBindings as ctb")
    .innerJoin("transportAccounts as ta", "ta.id", "ctb.transportAccountId")
    .innerJoin("transportEndpoints as te", "te.id", "ctb.transportEndpointId")
    .select(BINDING_SELECTION)
    .where("ctb.workspaceId", "=", params.workspaceId)
    .where("ctb.conversationId", "=", params.conversationId)
    .limit(1)
    .executeTakeFirst()
}

/**
 * Lightweight existence probe used to derive a conversation's "IM-ness".
 * Pass `queryable` (a Kysely transaction) to read inside an open
 * transaction so a binding created earlier in the SAME transaction is
 * visible (fresh derivation); omit it to read committed state via the
 * module pool. Pass `workspaceId` to additionally scope the check.
 */
export async function existsConversationTransportBinding(params: {
  conversationId: string
  workspaceId?: string
  queryable?: KyselyDb
}): Promise<boolean> {
  const executor = params.queryable ?? db
  let query = executor
    .selectFrom("conversationTransportBindings")
    .select(sql<number>`1`.as("one"))
    .where("conversationId", "=", params.conversationId)
    .limit(1)
  if (params.workspaceId !== undefined) {
    query = query.where("workspaceId", "=", params.workspaceId)
  }
  const row = await query.executeTakeFirst()
  return Boolean(row)
}

/**
 * Load the full (binding ⋈ account ⋈ endpoint) row by (account,
 * endpointType, endpointExternalId). Returns the raw camelCase joined
 * row; normalization stays in the service.
 */
export async function selectConversationTransportBindingByEndpointRow(params: {
  transportAccountId: string
  endpointType: TransportEndpointType
  endpointExternalId: string
}) {
  return db
    .selectFrom("conversationTransportBindings as ctb")
    .innerJoin("transportAccounts as ta", "ta.id", "ctb.transportAccountId")
    .innerJoin("transportEndpoints as te", "te.id", "ctb.transportEndpointId")
    .select(BINDING_SELECTION)
    .where("ctb.transportAccountId", "=", params.transportAccountId)
    .where("te.endpointType", "=", params.endpointType)
    .where("te.externalId", "=", params.endpointExternalId.trim())
    .limit(1)
    .executeTakeFirst()
}

/**
 * Look up a conversation's workspace (friendly-error guard before the
 * endpoint upsert in upsertConversationTransportBinding).
 */
export async function selectConversationWorkspaceId(
  conversationId: string
): Promise<{ workspaceId: string } | undefined> {
  return db
    .selectFrom("conversations")
    .select("workspaceId")
    .where("id", "=", conversationId)
    .limit(1)
    .executeTakeFirst()
}

/**
 * Friendly guard mirroring tg_binding_account_consistency: is there an
 * external participant in this conversation bound to a DIFFERENT
 * transport account? (re-binding while such participants remain would
 * account-mismatch them).
 */
export async function existsConflictingExternalParticipant(params: {
  conversationId: string
  transportAccountId: string
}): Promise<boolean> {
  const row = await db
    .selectFrom("conversationParticipants as cp")
    .innerJoin("accessSubjects as asx", "asx.id", "cp.subjectId")
    .innerJoin("transportAddresses as ta", "ta.id", "asx.transportAddressId")
    .select("cp.id")
    .where("cp.conversationId", "=", params.conversationId)
    .where("asx.kind", "=", "external")
    .where("ta.transportAccountId", "!=", params.transportAccountId)
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

/**
 * Resolve the conversation id bound to a given transport endpoint in a
 * workspace (updateTransportSessionSettings's endpoint→conversation
 * lookup).
 */
export async function selectConversationIdByEndpoint(params: {
  workspaceId: string
  transportEndpointId: string
}): Promise<string | undefined> {
  const row = await db
    .selectFrom("conversationTransportBindings")
    .select("conversationId")
    .where("workspaceId", "=", params.workspaceId)
    .where("transportEndpointId", "=", params.transportEndpointId)
    .limit(1)
    .executeTakeFirst()
  return (row?.conversationId as string | undefined) ?? undefined
}

/**
 * Endpoint upsert + binding upsert + projection recovery, all inside a
 * single transaction. The whole effect must commit together (a crash
 * between the binding write and the recovery SQL would strand skipped
 * projections), so the transaction boundary lives here in the repo.
 */
export async function writeConversationTransportBinding(params: {
  workspaceId: string
  conversationId: string
  transportAccountId: string
  endpointType: TransportEndpointType
  endpointExternalId: string
  parentExternalId?: string
  endpointDisplayName?: string
  endpointMetadata: Record<string, unknown>
  outboundEnabled: boolean
  inboundActorMode: TransportConversationInboundActorMode
  inboundActorId: string | null
  metadata: Record<string, unknown>
}): Promise<void> {
  await withDbTransaction(async (trx) => {
    const endpointRow = await trx
      .insertInto("transportEndpoints")
      .values({
        id: uuidv4(),
        transportAccountId: params.transportAccountId,
        endpointType: params.endpointType,
        externalId: params.endpointExternalId.trim(),
        parentExternalId: params.parentExternalId?.trim() || null,
        displayName: params.endpointDisplayName?.trim() || null,
        metadata: params.endpointMetadata as TransportEndpointMetadataInsert,
        createdAt: sql`NOW()`,
      })
      .onConflict((oc) =>
        oc
          .columns(["transportAccountId", "endpointType", "externalId"])
          .doUpdateSet({
            parentExternalId: sql`excluded.parent_external_id`,
            displayName: sql`COALESCE(excluded.display_name, transport_endpoints.display_name)`,
            metadata: sql`transport_endpoints.metadata || excluded.metadata`,
          })
      )
      .returning("id")
      .executeTakeFirst()
    const endpointId = endpointRow?.id
    if (!endpointId) {
      throw new Error("Failed to upsert transport endpoint")
    }

    await trx
      .insertInto("conversationTransportBindings")
      .values({
        id: uuidv4(),
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        transportAccountId: params.transportAccountId,
        transportEndpointId: endpointId,
        outboundEnabled: params.outboundEnabled,
        inboundActorMode: params.inboundActorMode,
        inboundActorId: params.inboundActorId,
        metadata: params.metadata as ConversationTransportBindingMetadataInsert,
        createdAt: sql`NOW()`,
      })
      .onConflict((oc) =>
        oc.column("conversationId").doUpdateSet({
          transportAccountId: sql`excluded.transport_account_id`,
          transportEndpointId: sql`excluded.transport_endpoint_id`,
          outboundEnabled: sql`excluded.outbound_enabled`,
          inboundActorMode: sql`excluded.inbound_actor_mode`,
          inboundActorId: sql`excluded.inbound_actor_id`,
          metadata: sql`excluded.metadata`,
        })
      )
      .execute()

    // Recovery: a fresh / replaced binding may resolve projections that
    // were previously skipped for any of the recoverable reasons
    // (no_binding / not_supported_in_v1 / outbound_disabled /
    // webhook_inbound_unavailable). Fire in the same tx so the create +
    // re-arm commit together.
    await recoverSkippedProjectionsForRecoveryEvent(trx, {
      kind: "binding_created_or_replaced",
      conversationId: params.conversationId,
      transportAccountId: params.transportAccountId,
      transportEndpointId: endpointId,
    })
  })
}

/**
 * The binding settings UPDATE + conditional projection recovery, inside
 * a single transaction. The flip-detection (outbound false → true) is
 * decided by the service and passed in as an optional `recovery`
 * descriptor; the atomic write lives here so the UPDATE + re-arm commit
 * together.
 */
export async function updateConversationTransportBindingSettings(params: {
  workspaceId: string
  conversationId: string
  updates: Record<string, unknown>
  recovery?: Extract<
    SkippedRecoveryEvent,
    { kind: "outbound_re_enabled" }
  > | null
}): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("conversationTransportBindings")
      .set(params.updates)
      .where("workspaceId", "=", params.workspaceId)
      .where("conversationId", "=", params.conversationId)
      .execute()

    if (params.recovery) {
      await recoverSkippedProjectionsForRecoveryEvent(tx, params.recovery)
    }
  })
}
