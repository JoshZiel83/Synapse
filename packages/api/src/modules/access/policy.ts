/**
 * Conversation-type policy enforcement helpers for access grants.
 *
 * D3: refactored to accept ScopedSubjectTarget (`{ subject, scope? }`) directly
 * instead of the legacy string `CapabilityAccessTargetType`. Callers branch on
 * `target.subject.kind` + `target.scope?.kind` for routing.
 */

import {
  isValidConversationTypeMask,
  maskAllowsConversationTypeKey,
  normalizeConversationTypeMask,
  resolveNarrowedConversationTypeMask,
  SUBJECT_KIND,
  type ConversationTypeKey,
} from "@synapse/shared"
import type { CapabilityAccessTarget } from "@synapse/shared/types"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import {
  isAccessSubjectActiveConversationParticipant,
  loadAccessConversationTargetRecord,
} from "./repo.js"
import { upsertAccessSubject } from "./subject-registry.js"

function formatConversationTypeKey(value: ConversationTypeKey) {
  // im_direct / im_group should read as "IM direct" / "IM group" (the leading
  // "im" segment is an initialism), not "im direct".
  return value.replaceAll("_", " ").replace(/^im /, "IM ")
}

/**
 * D3: a target carries an optional `conversation_type_mask_override` only when
 * its principal is workspace-wide (workspace), actor-wide (actor), or
 * remote-agent-wide (remote_agent) and not already scoped to a single
 * conversation. Scoped targets (conversation subject, or principal +
 * scope=conversation) inherit the parent mask verbatim.
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
  // already matches scoped remote_agent grants (see
  // loadVisiblePluginGrants in mcp-plugins/repo.ts) so the creation path
  // must validate them too, otherwise a remote_agent + scope=conv grant
  // could be written without checking conversation type policy or
  // remote-agent participation.
  let conversationId: string | null = null
  let activeParticipantCheck: {
    participantType: "actor" | "remote_agent" | "workspace_member"
    principalId: string
    principalKind: "actor" | "remote_agent" | "workspace_member"
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
    } else if (params.target.subject.kind === SUBJECT_KIND.WORKSPACE_MEMBER) {
      // Round 9 review extension: workspace_member IS a valid
      // conversation_participants kind — runtime supports
      // workspace_member + scope=conv grants (see evaluator-scope tests).
      // Treat them the same as actor/remote_agent here so creation can't
      // write a "member M in conversation C" grant for a member who
      // isn't actually in C.
      activeParticipantCheck = {
        participantType: "workspace_member",
        principalId: (params.target.subject as { memberId: string }).memberId,
        principalKind: "workspace_member",
      }
    }
    // For subject=workspace + scope=conversation: workspace can never
    // be a conversation_participants row (it's a group, not a participant)
    // so we only validate that the conversation exists and matches the
    // conversation-type policy. The runtime layer narrows visibility to
    // callers actually inside conversation C separately.
  } else {
    // Not a conversation-scoped target — nothing to validate.
    return null
  }

  if (!conversationId) {
    throw params.buildError(
      "conversationId is required for conversation-scoped access targets."
    )
  }

  const conversation = await loadAccessConversationTargetRecord(
    params.db,
    conversationId
  )
  if (!conversation) {
    throw params.buildError("Selected conversation was not found.")
  }

  if (
    !maskAllowsConversationTypeKey(
      params.effectiveConversationTypeMask,
      conversation.conversationTypeKey
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

  let principalRef
  switch (activeParticipantCheck.principalKind) {
    case "actor":
      principalRef = {
        kind: SUBJECT_KIND.ACTOR,
        actorId: activeParticipantCheck.principalId,
      } as const
      break
    case "remote_agent":
      principalRef = {
        kind: SUBJECT_KIND.REMOTE_AGENT,
        remoteAgentId: activeParticipantCheck.principalId,
      } as const
      break
    case "workspace_member":
      principalRef = {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: activeParticipantCheck.principalId,
      } as const
      break
  }
  const principalSubjectId = await upsertAccessSubject(params.db, principalRef)
  const hasActive = await isAccessSubjectActiveConversationParticipant(
    params.db,
    {
      conversationId,
      participantType: activeParticipantCheck.participantType,
      subjectId: principalSubjectId,
    }
  )
  if (!hasActive) {
    const label =
      activeParticipantCheck.principalKind === "actor"
        ? "actor"
        : activeParticipantCheck.principalKind === "remote_agent"
          ? "remote agent"
          : "workspace member"
    throw params.buildError(
      `Selected ${label} must already be an active participant in the selected conversation.`
    )
  }

  return conversation
}
