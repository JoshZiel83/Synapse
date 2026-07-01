import {
  RelationshipProfileViewSchema,
  RelationshipScanResponseSchema,
  IdentitySearchResponseSchema,
  ContactHubResponseSchema,
  ContactHubDetailResponseSchema,
  DirectConversationOpenResponseSchema,
  FriendRequestViewSchema,
  ActorAccessRequestViewSchema,
  RemoteAgentAccessRequestViewSchema,
  ResolveRequestResponseSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import type { DesignHandlers } from "./_types"

// Relationship + contacts: my/actor/remote-agent relationship profiles, QR scan
// and identity search, the contact hub (list + detail), the three request
// inboxes (friend / actor-access / remote-agent-access) and their approve/reject
// resolutions, plus opening a direct conversation. These feed the contacts and
// connection-request surfaces.
export const relationshipContactsHandlers = {
  getMyRelationshipProfile: async () => mock(RelationshipProfileViewSchema),
  updateMyRelationshipProfile: async () => mock(RelationshipProfileViewSchema),
  getActorRelationshipProfile: async () => mock(RelationshipProfileViewSchema),
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
  getContactHub: async () => mock(ContactHubResponseSchema),
  getContactHubDetail: async () => mock(ContactHubDetailResponseSchema),
  // Re-enabled after the RC2 fix (12b60ef5): the per-type request View schemas
  // dropped .nullable().optional() on createdAt (the DB columns are NOT NULL) and
  // now match their hand-written View types exactly (see contract-parity.ts). The
  // wire `RequestListResponseSchema` uses the WIDER AnyRequestView union for its
  // items, so we build each `{ incoming, outgoing }` envelope from the SPECIFIC
  // item schema — type-correct against each *ListResponse and semantically right
  // (a friend list shows friend requests, not a mixed union).
  getFriendRequests: async () => ({
    incoming: [mock(FriendRequestViewSchema), mock(FriendRequestViewSchema)],
    outgoing: [mock(FriendRequestViewSchema)],
  }),
  getActorAccessRequests: async () => ({
    incoming: [mock(ActorAccessRequestViewSchema)],
    outgoing: [mock(ActorAccessRequestViewSchema)],
  }),
  getRemoteAgentAccessRequests: async () => ({
    incoming: [mock(RemoteAgentAccessRequestViewSchema)],
    outgoing: [mock(RemoteAgentAccessRequestViewSchema)],
  }),
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
