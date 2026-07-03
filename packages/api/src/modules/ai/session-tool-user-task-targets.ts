import { CONVERSATION_PARTICIPANT_TYPE } from "@synapse/shared"
import type { ConversationParticipantEntry } from "@synapse/shared/types"

export type UserTaskTargetCandidate = {
  participantId: string
  workspaceMemberId: string
  name: string
  label: string
}

export type UserTaskTargetParticipantRow = {
  id: string
  participantType: string
  state: "active" | "left" | "removed"
  workspaceMemberId: string | null
  userName: string | null
}

function createUserTaskTargetCandidate(params: {
  participantId: string
  workspaceMemberId: string
  name: string
}): UserTaskTargetCandidate {
  return {
    participantId: params.participantId,
    workspaceMemberId: params.workspaceMemberId,
    name: params.name,
    label: `"${params.name}" (user)`,
  }
}

export function buildUserTaskTargetCandidatesFromRows(
  participants: UserTaskTargetParticipantRow[]
): UserTaskTargetCandidate[] {
  const candidates: UserTaskTargetCandidate[] = []

  for (const participant of participants) {
    if (participant.state !== "active") continue
    if (
      participant.participantType !==
      CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER
    )
      continue
    if (!participant.workspaceMemberId) continue

    const name = participant.userName?.trim() || "User"
    candidates.push(
      createUserTaskTargetCandidate({
        participantId: participant.id,
        workspaceMemberId: participant.workspaceMemberId,
        name,
      })
    )
  }

  return candidates
}

export function buildUserTaskTargetCandidatesFromEntries(
  participants: ConversationParticipantEntry[]
): UserTaskTargetCandidate[] {
  const candidates: UserTaskTargetCandidate[] = []

  for (const participant of participants) {
    if (
      participant.participantType !==
      CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER
    )
      continue
    if (!participant.participantId) continue

    const name = participant.name.trim() || "User"
    candidates.push(
      createUserTaskTargetCandidate({
        participantId: participant.participantId,
        workspaceMemberId: participant.id,
        name,
      })
    )
  }

  return candidates
}
