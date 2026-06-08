import type { ConversationParticipantEntry } from "@synapse/shared/types"

export type UserTaskTargetCandidate = {
  participantId: string
  workspaceMemberId: string
  name: string
  label: string
}

export type UserTaskTargetParticipantRow = {
  id: string
  participant_type: string
  state: "active" | "left" | "removed"
  workspace_member_id: string | null
  user_name: string | null
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
    if (participant.participant_type !== "workspace_member") continue
    if (!participant.workspace_member_id) continue

    const name = participant.user_name?.trim() || "User"
    candidates.push(
      createUserTaskTargetCandidate({
        participantId: participant.id,
        workspaceMemberId: participant.workspace_member_id,
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
    if (participant.participantType !== "workspace_member") continue
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
