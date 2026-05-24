/**
 * Conversation-type policy enforcement helpers for access grants.
 *
 * P0/P1b: this file (formerly `conversation-type-validation.ts`) is the
 * canonical entry point access guards/grant-issuance flows use to check that
 * a target conversation matches the policy mask. It accepts an injected
 * `db: KyselyDb` so tests can run against a per-test database, and avoids
 * importing chat/service (which would drag in the global pool through
 * `listConversationParticipants`) — the participant check is inlined here.
 */

import {
  isValidConversationTypeMask,
  maskAllowsConversationType,
  normalizeConversationTypeMask,
  resolveConversationTypeKey,
  resolveNarrowedConversationTypeMask,
  SUBJECT_KIND,
  type ConversationTypeKey,
} from "@synapse/shared"
import type { CapabilityAccessTargetType } from "@synapse/shared/types"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import { upsertAccessSubject } from "./subject-registry.js"

type ConversationTargetRecord = {
  conversationId: string
  kind: string
  boundary: string
  conversationTypeKey: ConversationTypeKey
}

function formatConversationTypeKey(value: ConversationTypeKey) {
  return value.replaceAll("_", " ")
}

export function targetSupportsConversationTypeOverride(
  targetType: CapabilityAccessTargetType
) {
  // Only workspace + actor targets carry a custom conversation-type policy
  // mask; conversation/workspace_member/actor_in_conversation targets are
  // pinned to the parent.
  switch (targetType) {
    case "workspace":
    case "actor":
      return true
    case "workspace_member":
    case "conversation":
    case "actor_in_conversation":
      return false
  }
}

export function assertConversationTypeMaskWithinParent(params: {
  parentConversationTypeMask: number
  conversationTypeMaskOverride: number | null | undefined
  buildError: (message: string) => Error
  invalidMaskMessage: string
}) {
  const normalizedParentMask = normalizeConversationTypeMask(
    params.parentConversationTypeMask
  )
  if (
    params.conversationTypeMaskOverride === null ||
    params.conversationTypeMaskOverride === undefined
  ) {
    return normalizedParentMask
  }

  const effectiveConversationTypeMask = resolveNarrowedConversationTypeMask(
    normalizedParentMask,
    params.conversationTypeMaskOverride
  )
  if (!isValidConversationTypeMask(effectiveConversationTypeMask)) {
    throw params.buildError(params.invalidMaskMessage)
  }
  return effectiveConversationTypeMask
}

export function assertGrantConversationTypeOverrideAllowed(params: {
  targetType: CapabilityAccessTargetType
  parentConversationTypeMask: number
  conversationTypeMaskOverride: number | null | undefined
  buildError: (message: string) => Error
  invalidMaskMessage: string
}) {
  if (!targetSupportsConversationTypeOverride(params.targetType)) {
    if (
      params.conversationTypeMaskOverride !== null &&
      params.conversationTypeMaskOverride !== undefined
    ) {
      throw params.buildError(
        "conversationTypeMaskOverride is not allowed for conversation-scoped access targets."
      )
    }
    return normalizeConversationTypeMask(params.parentConversationTypeMask)
  }

  return assertConversationTypeMaskWithinParent({
    parentConversationTypeMask: params.parentConversationTypeMask,
    conversationTypeMaskOverride: params.conversationTypeMaskOverride,
    buildError: params.buildError,
    invalidMaskMessage: params.invalidMaskMessage,
  })
}

async function loadConversationTargetRecord(
  db: KyselyDb,
  conversationId: string
): Promise<ConversationTargetRecord | null> {
  const row = await db
    .selectFrom("conversations")
    .select(["id", "kind", "boundary"])
    .where("id", "=", conversationId)
    .limit(1)
    .executeTakeFirst()
  if (!row) {
    return null
  }
  const conversationTypeKey = resolveConversationTypeKey(row.kind, row.boundary)
  if (!conversationTypeKey) {
    return null
  }
  return {
    conversationId: row.id,
    kind: row.kind,
    boundary: row.boundary,
    conversationTypeKey,
  }
}

async function isActorActiveParticipantInConversation(
  db: KyselyDb,
  conversationId: string,
  actorId: string
): Promise<boolean> {
  // P0 DI / P1b: lookup the actor subject id, then filter conversation_participants
  // by subject_id (the polymorphic actor_id column was dropped).
  const actorSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.ACTOR,
    actorId,
  })
  const row = await db
    .selectFrom("conversation_participants")
    .select("id")
    .where("conversation_id", "=", conversationId)
    .where("participant_type", "=", "actor")
    .where("subject_id", "=", actorSubjectId)
    .where("state", "=", "active")
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

export async function validateConversationScopedAccessTarget(params: {
  db: KyselyDb
  targetType: CapabilityAccessTargetType
  conversationId?: string | null
  actorId?: string | null
  effectiveConversationTypeMask: number
  buildError: (message: string) => Error
}) {
  if (
    params.targetType !== "conversation" &&
    params.targetType !== "actor_in_conversation"
  ) {
    return null
  }

  if (!params.conversationId) {
    throw params.buildError(
      "conversationId is required for conversation-scoped access targets."
    )
  }

  const conversation = await loadConversationTargetRecord(
    params.db,
    params.conversationId
  )
  if (!conversation) {
    throw params.buildError("Selected conversation was not found.")
  }

  if (
    !maskAllowsConversationType(
      params.effectiveConversationTypeMask,
      conversation.kind,
      conversation.boundary
    )
  ) {
    throw params.buildError(
      `Selected conversation is ${formatConversationTypeKey(
        conversation.conversationTypeKey
      )} and is blocked by the current conversation type policy.`
    )
  }

  if (params.targetType !== "actor_in_conversation") {
    return conversation
  }

  if (!params.actorId) {
    throw params.buildError(
      "actorId is required for actor_in_conversation access targets."
    )
  }

  const hasActiveActor = await isActorActiveParticipantInConversation(
    params.db,
    params.conversationId,
    params.actorId
  )
  if (!hasActiveActor) {
    throw params.buildError(
      "Selected actor must already be an active participant in the selected conversation."
    )
  }

  return conversation
}
