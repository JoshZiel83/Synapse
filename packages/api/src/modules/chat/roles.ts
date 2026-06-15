import {
  CONVERSATION_PARTICIPANT_ROLE_KEY,
  CONVERSATION_PARTICIPANT_ROLE_KEYS,
  type ConversationParticipantRoleKey,
} from "@synapse/shared"

export function normalizeConversationParticipantRoleKey(
  roleKey: string | null | undefined
): ConversationParticipantRoleKey {
  return CONVERSATION_PARTICIPANT_ROLE_KEYS.includes(
    roleKey as ConversationParticipantRoleKey
  )
    ? (roleKey as ConversationParticipantRoleKey)
    : CONVERSATION_PARTICIPANT_ROLE_KEY.MEMBER
}

export function canManageConversationRole(
  roleKey: string | null | undefined
): boolean {
  const normalized = normalizeConversationParticipantRoleKey(roleKey)
  return (
    normalized === CONVERSATION_PARTICIPANT_ROLE_KEY.OWNER ||
    normalized === CONVERSATION_PARTICIPANT_ROLE_KEY.ADMIN
  )
}
