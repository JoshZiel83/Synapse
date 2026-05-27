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

/**
 * Post-D4 round 8 review (P2): generic "is this subject an active
 * participant in the conversation?" matching the runtime visibility
 * layer's view. The earlier helper special-cased actors; the policy
 * validator missed remote_agent + scope=conversation grants, which the
 * runtime path already matches (see loadVisibleAccessBindings
 * remote_agent_in_conversation branch). Same SQL shape, parametrized
 * over participant_type + subject_id.
 */
async function isSubjectActiveParticipantInConversation(
  db: KyselyDb,
  params: {
    conversationId: string
    participantType: "actor" | "remote_agent"
    subjectId: string
  }
): Promise<boolean> {
  const row = await db
    .selectFrom("conversation_participants")
    .select("id")
    .where("conversation_id", "=", params.conversationId)
    .where("participant_type", "=", params.participantType)
    .where("subject_id", "=", params.subjectId)
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
  // Post-D4 round 8 review (P2): handle ALL scope=conversation shapes
  // (subject=conversation, actor + scope=conversation, AND
  // remote_agent + scope=conversation). The runtime visibility layer
  // already matches remote_agent_in_conversation grants (see
  // loadVisibleAccessBindings in tool-resolver.ts) so the creation path
  // must validate them too, otherwise a remote_agent + scope=conv grant
  // could be written without checking conversation type policy or
  // remote-agent participation.
  let conversationId: string | null = null
  let activeParticipantCheck: {
    participantType: "actor" | "remote_agent"
    principalId: string
    principalKind: "actor" | "remote_agent"
  } | null = null
  if (params.target.subject.kind === SUBJECT_KIND.CONVERSATION) {
    conversationId = (params.target.subject as { conversationId: string })
      .conversationId
  } else if (params.target.scope?.kind === SUBJECT_KIND.CONVERSATION) {
    conversationId = (params.target.scope as { conversationId: string })
      .conversationId
    if (params.target.subject.kind === SUBJECT_KIND.ACTOR) {
      activeParticipantCheck = {
        participantType: "actor",
        principalId: (params.target.subject as { actorId: string }).actorId,
        principalKind: "actor",
      }
    } else if (params.target.subject.kind === SUBJECT_KIND.REMOTE_AGENT) {
      activeParticipantCheck = {
        participantType: "remote_agent",
        principalId: (params.target.subject as { remoteAgentId: string })
          .remoteAgentId,
        principalKind: "remote_agent",
      }
    }
    // Other subject kinds with scope=conversation (workspace_member,
    // workspace, etc.) currently have no membership concept on
    // conversation_participants — we only validate the conversation
    // exists and matches the conversation-type policy.
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

  if (!activeParticipantCheck) {
    return conversation
  }

  const principalSubjectId = await upsertAccessSubject(
    params.db,
    activeParticipantCheck.principalKind === "actor"
      ? {
          kind: SUBJECT_KIND.ACTOR,
          actorId: activeParticipantCheck.principalId,
        }
      : {
          kind: SUBJECT_KIND.REMOTE_AGENT,
          remoteAgentId: activeParticipantCheck.principalId,
        }
  )
  const hasActive = await isSubjectActiveParticipantInConversation(params.db, {
    conversationId,
    participantType: activeParticipantCheck.participantType,
    subjectId: principalSubjectId,
  })
  if (!hasActive) {
    throw params.buildError(
      `Selected ${activeParticipantCheck.principalKind === "actor" ? "actor" : "remote agent"} must already be an active participant in the selected conversation.`
    )
  }

  return conversation
}
