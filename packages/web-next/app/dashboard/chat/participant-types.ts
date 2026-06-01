/**
 * Pure type definitions for chat participant pickers / mention surfaces.
 *
 * Extracted from the now-removed `chat-mentions-input.tsx` (which wrapped the
 * `react-mentions` library — superseded by the TipTap composer in
 * `@/components/chat-composer`). Kept as a standalone, dependency-free types
 * module so consumers don't pull in a dead editor implementation.
 */

export type MentionableParticipant = {
  id: string
  name: string
  participantType: "actor" | "remote_agent" | "workspace_member" | "external"
  role?: string
  avatarUrl?: string
  emoji?: string
  description?: string
  searchTerms?: string[]
}
