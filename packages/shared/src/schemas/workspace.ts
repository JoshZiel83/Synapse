import { z } from "zod"
import {
  CAPABILITY_CONVERSATION_TYPE_POLICY_RESOURCE_FAMILIES,
  WORKSPACE_ACCESS_KEYS,
} from "../constants/enums.js"
import { IsoInstantStringSchema } from "./datetime.js"

/**
 * App-facing contracts for the workspace module's APP routes (master plan
 * §5.3). workspace is a Tier-A app-facing module: every endpoint with a body is
 * registered through `appRoute` → `sendData` → `{ data }`. These schemas
 * describe the value each handler returns (the helper wraps it in `{ data }`);
 * the api presenter builds the value from the DB record and web/mobile parse it.
 *
 * Top-level scalar fields are modeled explicitly. The `secretary` actor view
 * returned by workspace-create carries the same genuinely-open `definition`
 * (docs/config) tree the organization actor views own, so it is modeled as an
 * open record here rather than re-validated interior-by-interior (deepening is
 * tracked under P1-3 / P1-7). See §5.1 / §10.1.
 */

const TrustLevelFieldSchema = z.string().nullable()

/** Base workspace view (presentWorkspaceRow): the workspace instance fields. */
export const WorkspaceViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  ownerId: z.string(),
  isTrusted: z.boolean(),
  createdAt: IsoInstantStringSchema.optional(),
  updatedAt: IsoInstantStringSchema.optional(),
})
export type WorkspaceView = z.infer<typeof WorkspaceViewSchema>

/**
 * Workspace list item (presentWorkspaceListRow): a {@link WorkspaceViewSchema}
 * plus the caller's membership id and derived trust level.
 */
export const WorkspaceListItemViewSchema = WorkspaceViewSchema.extend({
  currentWorkspaceMemberId: z.string().optional(),
  trustLevel: TrustLevelFieldSchema,
})
export type WorkspaceListItemView = z.infer<typeof WorkspaceListItemViewSchema>

/**
 * Workspace-create result: the new workspace fields plus the seeded secretary
 * (chief) actor view. The secretary's `definition` is an open domain view.
 */
export const WorkspaceCreateResultViewSchema = WorkspaceViewSchema.extend({
  secretary: z.object({
    id: z.string(),
    workspaceId: z.string(),
    definition: z.unknown(),
    currentVersion: z.number(),
    isActive: z.boolean(),
    isPublicShared: z.boolean(),
    createdAt: IsoInstantStringSchema.optional(),
    updatedAt: IsoInstantStringSchema.optional(),
  }),
})
export type WorkspaceCreateResultView = z.infer<
  typeof WorkspaceCreateResultViewSchema
>

/**
 * Workspace member view (presentMemberRow). The bare create response is just
 * the member row; the list response additionally joins the user's name/email
 * and avatar URL, so those joined fields are optional.
 */
export const WorkspaceMemberViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  trustLevel: TrustLevelFieldSchema,
  accessKeys: z.array(z.string()),
  joinedAt: IsoInstantStringSchema.optional(),
  userName: z.string().nullable().optional(),
  userEmail: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
})
export type WorkspaceMemberView = z.infer<typeof WorkspaceMemberViewSchema>

/**
 * Workspace access binding view. The list response joins the member's
 * user/trust fields; the grant response returns only the binding fields, so the
 * joined fields are optional.
 */
export const WorkspaceAccessBindingViewSchema = z.object({
  workspaceId: z.string(),
  workspaceMemberId: z.string(),
  userId: z.string(),
  accessKey: z.enum(WORKSPACE_ACCESS_KEYS),
  assignedByWorkspaceMemberId: z.string().nullable(),
  createdAt: IsoInstantStringSchema.optional(),
  updatedAt: IsoInstantStringSchema.optional(),
  trustLevel: TrustLevelFieldSchema.optional(),
  userName: z.string().nullable().optional(),
  userEmail: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
})
export type WorkspaceAccessBindingView = z.infer<
  typeof WorkspaceAccessBindingViewSchema
>

/** Workspace navigation capability flags. */
export const WorkspaceNavigationViewSchema = z.object({
  canViewWorkspace: z.boolean(),
  canAccessWorkspaceModels: z.boolean(),
  canAccessWorkspaceMemberModels: z.boolean(),
  canAccessWorkspaceAccess: z.boolean(),
})
export type WorkspaceNavigationView = z.infer<
  typeof WorkspaceNavigationViewSchema
>

/** Chief-actor summary embedded in the preference view. */
export const WorkspaceChiefActorSummaryViewSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  role: z.string(),
  title: z.string(),
  avatarUrl: z.string().optional(),
})

/** Member's chief-actor preference (getWorkspaceChiefActorPreference). */
export const WorkspaceChiefActorPreferenceViewSchema = z.object({
  workspaceId: z.string(),
  workspaceMemberId: z.string(),
  chiefActorId: z.string().optional(),
  chiefActor: WorkspaceChiefActorSummaryViewSchema.optional(),
  createdAt: IsoInstantStringSchema.optional(),
  updatedAt: IsoInstantStringSchema.optional(),
})
export type WorkspaceChiefActorPreferenceView = z.infer<
  typeof WorkspaceChiefActorPreferenceViewSchema
>

/** Single capability/conversation-type policy entry. */
export const WorkspaceCapabilityConversationTypePolicyViewSchema = z.object({
  workspaceId: z.string(),
  resourceFamily: z.enum(CAPABILITY_CONVERSATION_TYPE_POLICY_RESOURCE_FAMILIES),
  defaultConversationTypeMask: z.number().int(),
})

/** Full workspace capability/conversation-type policies view. */
export const WorkspaceCapabilityConversationTypePoliciesViewSchema = z.object({
  workspaceId: z.string(),
  policies: z.array(WorkspaceCapabilityConversationTypePolicyViewSchema),
})
// Inferred-type alias intentionally suffixed to avoid colliding with the
// hand-written `WorkspaceCapabilityConversationTypePoliciesView` interface in
// ../types/index.ts (which existing web consumers import). The runtime schema
// is the response contract; the interface stays the consumer-facing type.
export type WorkspaceCapabilityConversationTypePoliciesViewSchemaType = z.infer<
  typeof WorkspaceCapabilityConversationTypePoliciesViewSchema
>
