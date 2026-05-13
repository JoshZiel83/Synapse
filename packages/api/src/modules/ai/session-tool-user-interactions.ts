import type { ConversationParticipantEntry } from "@synapse/shared/types"

export type UserInteractionCandidate = {
  participantId: string
  workspaceMemberId: string
  name: string
  label: string
}

export type UserInteractionParticipantRow = {
  id: string
  participant_kind: string
  state: "active" | "left" | "removed"
  workspace_member_id: string | null
  user_name: string | null
}

function createUserInteractionCandidate(params: {
  participantId: string
  workspaceMemberId: string
  name: string
}): UserInteractionCandidate {
  return {
    participantId: params.participantId,
    workspaceMemberId: params.workspaceMemberId,
    name: params.name,
    label: `"${params.name}" (user)`,
  }
}

export function buildUserInteractionCandidatesFromRows(
  participants: UserInteractionParticipantRow[]
): UserInteractionCandidate[] {
  const candidates: UserInteractionCandidate[] = []

  for (const participant of participants) {
    if (participant.state !== "active") continue
    if (participant.participant_kind !== "workspace_member") continue
    if (!participant.workspace_member_id) continue

    const name = participant.user_name?.trim() || "User"
    candidates.push(
      createUserInteractionCandidate({
        participantId: participant.id,
        workspaceMemberId: participant.workspace_member_id,
        name,
      })
    )
  }

  return candidates
}

export function buildUserInteractionCandidatesFromEntries(
  participants: ConversationParticipantEntry[]
): UserInteractionCandidate[] {
  const candidates: UserInteractionCandidate[] = []

  for (const participant of participants) {
    if (participant.type !== "workspace_member") continue
    if (!participant.participantId) continue

    const name = participant.name.trim() || "User"
    candidates.push(
      createUserInteractionCandidate({
        participantId: participant.participantId,
        workspaceMemberId: participant.id,
        name,
      })
    )
  }

  return candidates
}
