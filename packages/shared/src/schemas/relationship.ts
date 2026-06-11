import { z } from "zod"
import {
  DIRECT_CONVERSATION_OPEN_STATUSES,
  IDENTITY_SEARCH_OUTCOMES,
  RELATIONSHIP_APPROVAL_MODES,
  RELATIONSHIP_PROFILE_SUBJECT_TYPES,
  RELATIONSHIP_SCAN_OUTCOMES,
} from "../constants/enums.js"

/**
 * App-facing contracts for the relationship module's APP routes (master plan
 * §5.3). Every relationship route is workspace-scoped + authenticated, so its
 * response value is wrapped through `appRoute` → `sendData` → `{ data: ... }`.
 * These schemas describe the value each handler returns (the helper wraps it).
 *
 * Top-level discriminant / scalar fields are modeled explicitly. Deeply-nested
 * presentation views (contact-hub entries, identity-search matches, request
 * views, conversation summaries, raw grant-request rows) are genuinely-open
 * shapes the presenter/service already own, so they are modeled as `z.unknown()`
 * / open records — the boundary only needs to round-trip them unchanged, not
 * re-validate their interior.
 */

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

/** GET identity-search. `matches` entries are open presentation views. */
export const IdentitySearchResponseSchema = z.object({
  query: z.string(),
  outcome: z.enum(IDENTITY_SEARCH_OUTCOMES),
  matches: z.array(z.unknown()),
})
export type IdentitySearchResponseSchemaType = z.infer<
  typeof IdentitySearchResponseSchema
>

/**
 * POST relationship-qr/scan and POST identity-search/request.
 * `contact` is an open `{ kind, id }` ref the service already shapes.
 */
export const RelationshipScanResponseSchema = z.object({
  outcome: z.enum(RELATIONSHIP_SCAN_OUTCOMES),
  requestId: z.string().optional(),
  contact: z.unknown().optional(),
})
export type RelationshipScanResponseSchemaType = z.infer<
  typeof RelationshipScanResponseSchema
>

/** GET friends — `{ friends: ContactHubEntryView[] }` (open entries). */
export const FriendsListResponseSchema = z.object({
  friends: z.array(z.unknown()),
})
export type FriendsListResponseSchemaType = z.infer<
  typeof FriendsListResponseSchema
>

/**
 * GET friend-requests / actor-access-requests / remote-agent-access-requests.
 * The controller maps records → presented views before sending; the views are
 * open presentation shapes, so each side is modeled as an array of unknown.
 */
export const RequestListResponseSchema = z.object({
  incoming: z.array(z.unknown()),
  outgoing: z.array(z.unknown()),
})
export type RequestListResponseSchemaType = z.infer<
  typeof RequestListResponseSchema
>

/**
 * POST approve/reject (friend / actor-access / remote-agent-access). The handler
 * returns `{ request: <resolved row | grant-request result> }`; the resolved
 * value is a genuinely-open record consumers do not read.
 */
export const ResolveRequestResponseSchema = z.object({
  request: z.unknown(),
})
export type ResolveRequestResponseSchemaType = z.infer<
  typeof ResolveRequestResponseSchema
>

/**
 * GET contact-hub. `requestSummary` is a fixed counter block; the entry/group
 * collections are open presentation views.
 */
export const ContactHubResponseSchema = z.object({
  requestSummary: z.object({
    friendPendingCount: z.number(),
    actorAccessPendingCount: z.number(),
    remoteAgentAccessPendingCount: z.number(),
    totalPendingCount: z.number(),
  }),
  workspaceActors: z.array(z.unknown()),
  workspaceRemoteAgents: z.array(z.unknown()),
  workspaceMembers: z.array(z.unknown()),
  friends: z.array(z.unknown()),
  groups: z.array(z.unknown()),
})
export type ContactHubResponseSchemaType = z.infer<
  typeof ContactHubResponseSchema
>

/** GET contact-hub/:kind/:contactId. */
export const ContactHubDetailResponseSchema = z.object({
  contact: z.unknown(),
  groups: z.array(z.unknown()),
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
