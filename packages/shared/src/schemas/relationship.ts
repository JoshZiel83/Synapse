import { z } from "zod"
import {
  ACTOR_ROLES,
  CONTACT_DIRECT_STATES,
  CONTACT_HUB_KINDS,
  CONTACT_TARGET_TYPES,
  CONVERSATION_ITEM_ROLES,
  CONVERSATION_KINDS,
  CONVERSATION_PARTICIPANT_STATES,
  CONVERSATION_PARTICIPANT_TYPES,
  CONVERSATION_STATUSES,
  DIRECT_CONVERSATION_OPEN_STATUSES,
  IDENTITY_SEARCH_MATCH_STATES,
  IDENTITY_SEARCH_OUTCOMES,
  REMOTE_AGENT_RUNTIME_KINDS,
  RELATIONSHIP_APPROVAL_MODES,
  RELATIONSHIP_PROFILE_SUBJECT_TYPES,
  RELATIONSHIP_REQUEST_STATUS,
  RELATIONSHIP_REQUEST_STATUSES,
  RELATIONSHIP_SCAN_OUTCOMES,
  TRANSPORT_KINDS,
  WORKSPACE_TRUST_LEVELS,
} from "../constants/enums.js"
import { IsoInstantStringSchema } from "./datetime.js"

/**
 * App-facing contracts for the relationship module's APP routes (master plan
 * §5.3). Every relationship route is workspace-scoped + authenticated, so its
 * response value is wrapped through `appRoute` → `sendData` → `{ data: ... }`.
 * These schemas describe the value each handler returns (the helper wraps it).
 *
 * round-6 P1-4: the interior presentation views (contact-hub entries,
 * identity-search matches, friend/actor/remote-agent request views, the
 * member/actor/remote-agent summaries they embed) are now modeled as real Zod
 * here — they were `z.unknown()`. The presenter builds them from joined rows
 * (relationship/presenter.ts present*), so a closed schema validates casing +
 * catches a raw-Date leak via IsoInstantStringSchema.
 */

// ─────────────────────────── interior view shapes ────────────────────────────

/** Minimal workspace summary embedded in every relationship view. */
export const RelationshipWorkspaceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
})

export const RelationshipMemberSummaryViewSchema = z.object({
  workspace: RelationshipWorkspaceSummarySchema,
  workspaceMemberId: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  avatarFileId: z.string().nullable().optional(),
  trustLevel: z.enum(WORKSPACE_TRUST_LEVELS).optional(),
})

export const RelationshipActorSummaryViewSchema = z.object({
  workspace: RelationshipWorkspaceSummarySchema,
  actorId: z.string(),
  displayName: z.string(),
  title: z.string(),
  role: z.enum(ACTOR_ROLES),
  avatarFileId: z.string().nullable().optional(),
  avatarEmoji: z.string().nullable().optional(),
  requiresContactApproval: z.boolean(),
  isPublicShared: z.boolean(),
})

export const RelationshipRemoteAgentSummaryViewSchema = z.object({
  workspace: RelationshipWorkspaceSummarySchema,
  remoteAgentId: z.string(),
  displayName: z.string(),
  title: z.string(),
  runtimeKind: z.enum(REMOTE_AGENT_RUNTIME_KINDS),
  avatarFileId: z.string().nullable().optional(),
  avatarEmoji: z.string().nullable().optional(),
  requiresContactApproval: z.boolean(),
  isPublicShared: z.boolean(),
})

/** Contact-hub entry direct-state block. */
export const ContactHubDirectStateSchema = z.object({
  status: z.enum(CONTACT_DIRECT_STATES),
  conversationId: z.string().optional(),
})

/** A single contact-hub entry (presented). */
export const ContactHubEntryViewSchema = z.object({
  kind: z.enum(CONTACT_HUB_KINDS),
  id: z.string(),
  targetType: z.enum(CONTACT_TARGET_TYPES),
  title: z.string(),
  subtitle: z.string().optional(),
  avatarUrl: z.string().optional(),
  avatarEmoji: z.string().optional(),
  workspace: RelationshipWorkspaceSummarySchema,
  workspaceMemberId: z.string().optional(),
  userId: z.string().optional(),
  actorId: z.string().optional(),
  remoteAgentId: z.string().optional(),
  relationLabel: z.string(),
  directState: ContactHubDirectStateSchema,
})

/** A reference to a contact-hub entry ({ kind, id }). */
export const ContactHubEntryRefSchema = z.object({
  kind: z.enum(CONTACT_HUB_KINDS),
  id: z.string(),
})

export const ConversationParticipantViewSchema = z.object({
  participantId: z.string().optional(),
  participantType: z.enum(CONVERSATION_PARTICIPANT_TYPES).optional(),
  id: z.string().optional(),
  workspaceMemberId: z.string().optional(),
  actorId: z.string().optional(),
  remoteAgentId: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  role: z.string().optional(),
  conversationRole: z.string().optional(),
  avatarUrl: z.string().optional(),
  avatarEmoji: z.string().optional(),
  state: z.enum(CONVERSATION_PARTICIPANT_STATES).optional(),
})

export const ConversationMessagePreviewSchema = z.object({
  content: z.string(),
  role: z.enum(CONVERSATION_ITEM_ROLES).refine((role) => role !== "tool", {
    message: "Conversation summary previews cannot use the tool role",
  }),
  actorName: z.string().optional(),
  createdAt: IsoInstantStringSchema,
})

export const ConversationPresentationViewSchema = z.object({
  chatType: z.enum(CONVERSATION_KINDS),
  title: z.string(),
  avatarUrl: z.string().optional(),
  subtitle: z.string().optional(),
  peer: ConversationParticipantViewSchema.optional(),
  canRename: z.boolean().optional(),
  canManageMembers: z.boolean().optional(),
  canManageParticipants: z.boolean().optional(),
})

export const ConversationSummaryViewSchema = z.object({
  id: z.string(),
  kind: z.enum(CONVERSATION_KINDS),
  isIm: z.boolean(),
  status: z.enum(CONVERSATION_STATUSES),
  transportKind: z.enum(TRANSPORT_KINDS).optional(),
  participants: z.array(ConversationParticipantViewSchema),
  members: z.array(ConversationParticipantViewSchema).optional(),
  lastMessage: ConversationMessagePreviewSchema.optional(),
  unreadCount: z.number().int().nonnegative(),
  createdAt: IsoInstantStringSchema,
  title: z.string(),
  name: z.string(),
  avatarUrl: z.string().optional(),
  presentation: ConversationPresentationViewSchema.optional(),
  permissions: z
    .object({
      canManage: z.boolean().optional(),
      canManageMembers: z.boolean().optional(),
      canManageParticipants: z.boolean().optional(),
    })
    .optional(),
  viewerParticipantId: z.string().optional(),
  viewerWorkspaceMemberId: z.string().optional(),
})

/** A single identity-search match (presented). */
export const IdentitySearchMatchViewSchema = z.object({
  profileId: z.string(),
  targetType: z.enum(CONTACT_TARGET_TYPES),
  title: z.string(),
  subtitle: z.string().optional(),
  avatarUrl: z.string().optional(),
  avatarEmoji: z.string().optional(),
  workspace: RelationshipWorkspaceSummarySchema,
  workspaceMemberId: z.string().optional(),
  userId: z.string().optional(),
  actorId: z.string().optional(),
  remoteAgentId: z.string().optional(),
  state: z.enum(IDENTITY_SEARCH_MATCH_STATES),
  contact: ContactHubEntryRefSchema.optional(),
  conversationId: z.string().optional(),
  requestId: z.string().optional(),
})

/** Friend request (presentFriendRequest). createdAt is NOT NULL at the source. */
export const FriendRequestViewSchema = z.object({
  id: z.string(),
  status: z.enum(RELATIONSHIP_REQUEST_STATUSES),
  createdAt: IsoInstantStringSchema,
  requester: RelationshipMemberSummaryViewSchema.nullable().optional(),
  targetType: z.enum(CONTACT_TARGET_TYPES),
  targetMember: RelationshipMemberSummaryViewSchema.nullable().optional(),
  targetActor: RelationshipActorSummaryViewSchema.nullable().optional(),
  targetRemoteAgent:
    RelationshipRemoteAgentSummaryViewSchema.nullable().optional(),
})

/** Actor access request (presentActorAccessRequest). */
export const ActorAccessRequestViewSchema = z.object({
  id: z.string(),
  status: z.enum(RELATIONSHIP_REQUEST_STATUSES),
  createdAt: IsoInstantStringSchema,
  requester: RelationshipMemberSummaryViewSchema.nullable().optional(),
  actor: RelationshipActorSummaryViewSchema.nullable().optional(),
})

/** Remote-agent access request (presentRemoteAgentAccessRequest). */
export const RemoteAgentAccessRequestViewSchema = z.object({
  id: z.string(),
  status: z.enum(RELATIONSHIP_REQUEST_STATUSES),
  createdAt: IsoInstantStringSchema,
  requester: RelationshipMemberSummaryViewSchema.nullable().optional(),
  remoteAgent: RelationshipRemoteAgentSummaryViewSchema.nullable().optional(),
})

/** GET/PUT relationship-profile (member/actor/remote-agent). */
export const RelationshipProfileViewSchema = z.object({
  subjectType: z.enum(RELATIONSHIP_PROFILE_SUBJECT_TYPES),
  approvalMode: z.enum(RELATIONSHIP_APPROVAL_MODES),
  qrToken: z.string(),
  qrUrl: z.string(),
  identityId: z.string(),
  identitySearchEnabled: z.boolean(),
  requiresContactApproval: z.boolean(),
  isPublicShared: z.boolean().optional(),
})
export type RelationshipProfileViewSchemaType = z.infer<
  typeof RelationshipProfileViewSchema
>

/** GET identity-search. */
export const IdentitySearchResponseSchema = z.object({
  query: z.string(),
  outcome: z.enum(IDENTITY_SEARCH_OUTCOMES),
  matches: z.array(IdentitySearchMatchViewSchema),
})
export type IdentitySearchResponseSchemaType = z.infer<
  typeof IdentitySearchResponseSchema
>

/** POST relationship-qr/scan and POST identity-search/request. */
export const RelationshipScanResponseSchema = z.object({
  outcome: z.enum(RELATIONSHIP_SCAN_OUTCOMES),
  requestId: z.string().optional(),
  contact: ContactHubEntryRefSchema.optional(),
})
export type RelationshipScanResponseSchemaType = z.infer<
  typeof RelationshipScanResponseSchema
>

/** GET friends — `{ friends: ContactHubEntryView[] }`. */
export const FriendsListResponseSchema = z.object({
  friends: z.array(ContactHubEntryViewSchema),
})
export type FriendsListResponseSchemaType = z.infer<
  typeof FriendsListResponseSchema
>

/**
 * GET friend-requests / actor-access-requests / remote-agent-access-requests.
 * One schema serves all three endpoints; an entry is whichever request view the
 * endpoint produces, so the entries are the union of the three presented views.
 */
const AnyRequestViewSchema = z.union([
  FriendRequestViewSchema,
  ActorAccessRequestViewSchema,
  RemoteAgentAccessRequestViewSchema,
])
export const RequestListResponseSchema = z.object({
  incoming: z.array(AnyRequestViewSchema),
  outgoing: z.array(AnyRequestViewSchema),
})
export type RequestListResponseSchemaType = z.infer<
  typeof RequestListResponseSchema
>

// Per-route narrowed forms: each of the three endpoints emits exactly one arm
// (its own presenter), so its wire schema is the narrowed list — the response
// schema then infers exactly the per-route client type (FriendRequestListResponse
// etc.) instead of the shared 3-arm union. Keeps the guard honest AND tightens
// each route's wire validation to what that route actually returns.
export const FriendRequestListResponseSchema = z.object({
  incoming: z.array(FriendRequestViewSchema),
  outgoing: z.array(FriendRequestViewSchema),
})
export const ActorAccessRequestListResponseSchema = z.object({
  incoming: z.array(ActorAccessRequestViewSchema),
  outgoing: z.array(ActorAccessRequestViewSchema),
})
export const RemoteAgentAccessRequestListResponseSchema = z.object({
  incoming: z.array(RemoteAgentAccessRequestViewSchema),
  outgoing: z.array(RemoteAgentAccessRequestViewSchema),
})

const RESOLVED_RELATIONSHIP_REQUEST_STATUSES = [
  RELATIONSHIP_REQUEST_STATUS.APPROVED,
  RELATIONSHIP_REQUEST_STATUS.REJECTED,
] as const

export const ResolvedRelationshipRequestViewSchema = z.object({
  id: z.string(),
  status: z.enum(RESOLVED_RELATIONSHIP_REQUEST_STATUSES),
})

/** POST approve/reject (friend / actor-access / remote-agent-access). */
export const ResolveRequestResponseSchema = z.object({
  request: ResolvedRelationshipRequestViewSchema,
})
export type ResolveRequestResponseSchemaType = z.infer<
  typeof ResolveRequestResponseSchema
>

/**
 * GET contact-hub. The entry collections are ContactHubEntryView[]; `groups`
 * are ConversationSummaryView[] from chat/summary-view.
 */
export const ContactHubResponseSchema = z.object({
  requestSummary: z.object({
    friendPendingCount: z.number(),
    actorAccessPendingCount: z.number(),
    remoteAgentAccessPendingCount: z.number(),
    totalPendingCount: z.number(),
  }),
  workspaceActors: z.array(ContactHubEntryViewSchema),
  workspaceRemoteAgents: z.array(ContactHubEntryViewSchema),
  workspaceMembers: z.array(ContactHubEntryViewSchema),
  friends: z.array(ContactHubEntryViewSchema),
  groups: z.array(ConversationSummaryViewSchema),
})
export type ContactHubResponseSchemaType = z.infer<
  typeof ContactHubResponseSchema
>

/** GET contact-hub/:kind/:contactId. */
export const ContactHubDetailResponseSchema = z.object({
  contact: ContactHubEntryViewSchema,
  groups: z.array(ConversationSummaryViewSchema),
})
export type ContactHubDetailResponseSchemaType = z.infer<
  typeof ContactHubDetailResponseSchema
>

/** POST chat/direct-conversations/open. */
export const DirectConversationOpenResponseSchema = z.object({
  status: z.enum(DIRECT_CONVERSATION_OPEN_STATUSES),
  created: z.boolean().optional(),
  conversationId: z.string().optional(),
  requestId: z.string().optional(),
})
export type DirectConversationOpenResponseSchemaType = z.infer<
  typeof DirectConversationOpenResponseSchema
>

// ───────────────────────────── request DTOs (§5.1.1) ─────────────────────────
// App-facing request bodies / queries for the relationship routes. Single-
// sourced here so the API parser and the web/mobile clients share one shape.

/** POST relationship-qr/scan body. */
export const RelationshipScanInputSchema = z.object({
  token: z.string().trim().min(1).max(256),
})
export type RelationshipScanInput = z.infer<typeof RelationshipScanInputSchema>

/** POST chat/direct-conversations/open body. */
export const OpenDirectConversationInputSchema = z.object({
  contactKind: z.enum(CONTACT_HUB_KINDS),
  contactId: z.string().trim().min(1).max(255),
})
export type OpenDirectConversationInput = z.infer<
  typeof OpenDirectConversationInputSchema
>

/** PUT me/relationship-profile body. */
export const UpdateMemberRelationshipProfileInputSchema = z.object({
  approvalMode: z.enum(RELATIONSHIP_APPROVAL_MODES),
  identityId: z.string().trim().min(4).max(32).optional(),
  identitySearchEnabled: z.boolean().optional(),
})
export type UpdateMemberRelationshipProfileInput = z.infer<
  typeof UpdateMemberRelationshipProfileInputSchema
>

/** PUT actors|remote-agents/:id/relationship-profile body. */
export const UpdateActorRelationshipProfileInputSchema = z.object({
  approvalMode: z.enum(RELATIONSHIP_APPROVAL_MODES),
  identityId: z.string().trim().min(4).max(32).optional(),
  identitySearchEnabled: z.boolean().optional(),
  isPublicShared: z.boolean().optional(),
})
export type UpdateActorRelationshipProfileInput = z.infer<
  typeof UpdateActorRelationshipProfileInputSchema
>

/** GET identity-search query (?q=). */
export const IdentitySearchQuerySchema = z.object({
  q: z.string().trim().max(64).optional(),
})
export type IdentitySearchQuery = z.infer<typeof IdentitySearchQuerySchema>

/** POST identity-search/request body. */
export const RequestRelationshipBySearchInputSchema = z.object({
  profileId: z.uuid(),
})
export type RequestRelationshipBySearchInput = z.infer<
  typeof RequestRelationshipBySearchInputSchema
>
