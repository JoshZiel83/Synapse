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
} from "../fixtures/contacts"
import type { DesignHandlers } from "./_types"

// Relationship + contacts: my/actor/remote-agent relationship profiles, QR scan
// and identity search, the contact hub (list + detail), the three request
// inboxes (friend / actor-access / remote-agent-access) and their approve/reject
// resolutions, plus opening a direct conversation. These feed the contacts and
// connection-request surfaces.
export const relationshipContactsHandlers = {
  getMyRelationshipProfile: async () => mock(RelationshipProfileViewSchema),
  updateMyRelationshipProfile: async () => mock(RelationshipProfileViewSchema),
  getActorRelationshipProfile: async (_ws: string, actorId: string) =>
    designActorProfile(actorId),
  updateActorRelationshipProfile: async () =>
    mock(RelationshipProfileViewSchema),
  getRemoteAgentRelationshipProfile: async () =>
    mock(RelationshipProfileViewSchema),
  updateRemoteAgentRelationshipProfile: async () =>
    mock(RelationshipProfileViewSchema),
  scanRelationshipQr: async () => mock(RelationshipScanResponseSchema),
  searchIdentity: async () => mock(IdentitySearchResponseSchema),
  requestRelationshipByIdentityProfile: async () =>
    mock(RelationshipScanResponseSchema),
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
