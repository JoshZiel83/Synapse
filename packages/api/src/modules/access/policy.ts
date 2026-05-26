/**
 * Conversation-type policy enforcement helpers for access grants.
 *
 * D3: refactored to accept ScopedSubjectTarget (`{ subject, scope? }`) directly
 * instead of the legacy string `CapabilityAccessTargetType`. Callers branch on
 * `target.subject.kind` + `target.scope?.kind` for routing.
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
import type { CapabilityAccessTarget } from "@synapse/shared/types"
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

/**
 * D3: a target carries an optional `conversation_type_mask_override` only when
 * its principal is workspace-wide (workspace) or actor-wide (actor) and not
 * already scoped to a single conversation. Scoped targets (conversation
 * subject, or actor + scope=conversation) inherit the parent mask verbatim.
 */
export function targetSupportsConversationTypeOverride(
  target: CapabilityAccessTarget
) {
  if (target.scope?.kind === SUBJECT_KIND.CONVERSATION) {
    // e.g. actor + scope=conversation — pinned to the scope's conversation.
    return false
  }
  switch (target.subject.kind) {
    case SUBJECT_KIND.WORKSPACE:
    case SUBJECT_KIND.ACTOR:
    case SUBJECT_KIND.REMOTE_AGENT:
      return true
    default:
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
  target: CapabilityAccessTarget
  parentConversationTypeMask: number
  conversationTypeMaskOverride: number | null | undefined
  buildError: (message: string) => Error
  invalidMaskMessage: string
}) {
  if (!targetSupportsConversationTypeOverride(params.target)) {
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
  target: CapabilityAccessTarget
  effectiveConversationTypeMask: number
  buildError: (message: string) => Error
}) {
  // Determine which conversation the target is anchored to (if any).
  let conversationId: string | null = null
  let actorIdForActiveParticipantCheck: string | null = null
  if (params.target.subject.kind === SUBJECT_KIND.CONVERSATION) {
    conversationId = (params.target.subject as { conversationId: string })
      .conversationId
  } else if (
    params.target.subject.kind === SUBJECT_KIND.ACTOR &&
    params.target.scope?.kind === SUBJECT_KIND.CONVERSATION
  ) {
    conversationId = (params.target.scope as { conversationId: string })
      .conversationId
    actorIdForActiveParticipantCheck = (
      params.target.subject as { actorId: string }
    ).actorId
  } else {
    // Not a conversation-scoped target — nothing to validate.
    return null
  }

  if (!conversationId) {
    throw params.buildError(
      "conversationId is required for conversation-scoped access targets."
    )
  }

  const conversation = await loadConversationTargetRecord(
    params.db,
    conversationId
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

  if (!actorIdForActiveParticipantCheck) {
    return conversation
  }

  const hasActiveActor = await isActorActiveParticipantInConversation(
    params.db,
    conversationId,
    actorIdForActiveParticipantCheck
  )
  if (!hasActiveActor) {
    throw params.buildError(
      "Selected actor must already be an active participant in the selected conversation."
    )
  }

  return conversation
}
