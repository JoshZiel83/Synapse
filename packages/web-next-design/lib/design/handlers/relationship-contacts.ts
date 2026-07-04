import {
  RelationshipProfileViewSchema,
  RelationshipScanResponseSchema,
  IdentitySearchResponseSchema,
  DirectConversationOpenResponseSchema,
  ResolveRequestResponseSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import {
  designContactHub,
  designContactEntries,
  findContactEntry,
  designFriendRequests,
  designActorAccessRequests,
  designActorProfile,
  designMyProfile,
  designIdentitySearch,
} from "../fixtures/contacts"
import type { DesignHandlers } from "./_types"

// Relationship + contacts: my/actor/remote-agent relationship profiles, QR scan
// and identity search, the contact hub (list + detail), the three request
// inboxes (friend / actor-access / remote-agent-access) and their approve/reject
// resolutions, plus opening a direct conversation. These feed the contacts and
// connection-request surfaces.
export const relationshipContactsHandlers = {
  getMyRelationshipProfile: async () => designMyProfile,
  updateMyRelationshipProfile: async (
    _ws: string,
    input: {
      approvalMode: "auto" | "manual"
      identityId?: string
      identitySearchEnabled?: boolean
    }
  ) => ({
    ...designMyProfile,
    approvalMode: input.approvalMode,
    identityId: input.identityId ?? designMyProfile.identityId,
    identitySearchEnabled:
      input.identitySearchEnabled ?? designMyProfile.identitySearchEnabled,
  }),
  getActorRelationshipProfile: async (_ws: string, actorId: string) =>
    designActorProfile(actorId),
  updateActorRelationshipProfile: async (
    _ws: string,
    actorId: string,
    input: {
      approvalMode: "auto" | "manual"
      identityId?: string
      identitySearchEnabled?: boolean
      isPublicShared?: boolean
    }
  ) => {
    const base = designActorProfile(actorId)
    return {
      ...base,
      approvalMode: input.approvalMode,
      identityId: input.identityId ?? base.identityId,
      identitySearchEnabled:
        input.identitySearchEnabled ?? base.identitySearchEnabled,
      isPublicShared: input.isPublicShared ?? base.isPublicShared,
    }
  },
  getRemoteAgentRelationshipProfile: async () =>
    mock(RelationshipProfileViewSchema),
  updateRemoteAgentRelationshipProfile: async () =>
    mock(RelationshipProfileViewSchema),
  scanRelationshipQr: async () => mock(RelationshipScanResponseSchema),
  searchIdentity: async (_ws: string, query: string) =>
    designIdentitySearch(query),
  requestRelationshipByIdentityProfile: async () => ({
    outcome: "friend_request_created" as const,
    requestId: "req-new",
  }),
  // Curated mixed roster + detail (real members/actors/agents/friends).
  getContactHub: async () => designContactHub,
  getContactHubDetail: async (_ws: string, kind: string, id: string) => ({
    contact: findContactEntry(kind, id) ?? designContactEntries[0],
    groups: [],
  }),
  getFriendRequests: async () => designFriendRequests,
  getActorAccessRequests: async () => designActorAccessRequests,
  getRemoteAgentAccessRequests: async () => ({ incoming: [], outgoing: [] }),
  approveFriendRequest: async () => mock(ResolveRequestResponseSchema),
  rejectFriendRequest: async () => mock(ResolveRequestResponseSchema),
  approveActorAccessRequest: async () => mock(ResolveRequestResponseSchema),
  rejectActorAccessRequest: async () => mock(ResolveRequestResponseSchema),
  approveRemoteAgentAccessRequest: async () =>
    mock(ResolveRequestResponseSchema),
  rejectRemoteAgentAccessRequest: async () =>
    mock(ResolveRequestResponseSchema),
  openDirectConversation: async () =>
    mock(DirectConversationOpenResponseSchema),
} satisfies DesignHandlers
