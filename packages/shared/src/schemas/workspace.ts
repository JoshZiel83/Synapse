import { z } from "zod"
import {
  ACTOR_ROLES,
  CAPABILITY_CONVERSATION_TYPE_POLICY_RESOURCE_FAMILIES,
  INVITE_TRUST_LEVELS,
  WORKSPACE_ACCESS_KEYS,
  WORKSPACE_TRUST_LEVELS,
} from "../constants/enums.js"
import { IsoInstantStringSchema } from "./datetime.js"
import { ActorDefinitionSchema } from "./organization.js"

/**
 * App-facing contracts for the workspace module's APP routes (master plan
 * §5.3). workspace is a Tier-A app-facing module: every endpoint with a body is
 * registered through `appRoute` → `sendData` → `{ data }`. These schemas
 * describe the value each handler returns (the helper wraps it in `{ data }`);
 * the api presenter builds the value from the DB record and web/mobile parse it.
 *
 * Top-level scalar fields are modeled explicitly. The `secretary` actor view
 * returned by workspace-create carries the same actor definition tree as
 * organization actor views, so it reuses the shared actor definition schema
 * instead of treating that app response branch as opaque.
 */

const TrustLevelFieldSchema = z.enum(WORKSPACE_TRUST_LEVELS).nullable()
const ConversationTypeMaskSchema = z.number().int().min(1).max(15)
const CapabilityConversationTypePolicyFamilySchema = z.enum(
  CAPABILITY_CONVERSATION_TYPE_POLICY_RESOURCE_FAMILIES
)

/** Create-workspace request body. */
export const WorkspaceCreateInputSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
})
export type WorkspaceCreateInput = z.infer<typeof WorkspaceCreateInputSchema>

/** Update-workspace request body. */
export const WorkspaceUpdateInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
})
export type WorkspaceUpdateInput = z.infer<typeof WorkspaceUpdateInputSchema>

/** Add-member request body. */
export const WorkspaceAddMemberInputSchema = z.object({
  userId: z.uuid(),
  trustLevel: z.enum(INVITE_TRUST_LEVELS),
})
export type WorkspaceAddMemberInput = z.infer<
  typeof WorkspaceAddMemberInputSchema
>

/** Workspace-access grant request body. */
export const WorkspaceAccessGrantInputSchema = z.object({
  workspaceMemberId: z.uuid(),
  accessKey: z.enum(WORKSPACE_ACCESS_KEYS),
})
export type WorkspaceAccessGrantInput = z.infer<
  typeof WorkspaceAccessGrantInputSchema
>

/** Member's chief-actor preference update request body. */
export const WorkspaceChiefActorPreferenceInputSchema = z.object({
  chiefActorId: z.uuid().nullable(),
})
export type WorkspaceChiefActorPreferenceInput = z.infer<
  typeof WorkspaceChiefActorPreferenceInputSchema
>

/** Capability/conversation-type policy update request body. */
export const WorkspaceCapabilityConversationTypePolicyUpdateInputSchema =
  z.object({
    policies: z
      .partialRecord(
        CapabilityConversationTypePolicyFamilySchema,
        ConversationTypeMaskSchema
      )
      .refine((value) => Object.keys(value).length > 0, {
        message: "At least one policy update is required",
      }),
  })
export type WorkspaceCapabilityConversationTypePolicyUpdateInput = z.infer<
  typeof WorkspaceCapabilityConversationTypePolicyUpdateInputSchema
>

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
export const WorkspaceListViewSchema = z.array(WorkspaceListItemViewSchema)
export type WorkspaceListView = z.infer<typeof WorkspaceListViewSchema>

/**
 * Workspace-create result: the new workspace fields plus the seeded secretary
 * (chief) actor view. The secretary's `definition` is an open domain view.
 */
export const WorkspaceCreateResultViewSchema = WorkspaceViewSchema.extend({
  secretary: z.object({
    id: z.string(),
    workspaceId: z.string(),
    definition: ActorDefinitionSchema,
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
export const WorkspaceMemberListViewSchema = z.array(WorkspaceMemberViewSchema)
export type WorkspaceMemberListView = z.infer<
  typeof WorkspaceMemberListViewSchema
>

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
export const WorkspaceAccessBindingListViewSchema = z.array(
  WorkspaceAccessBindingViewSchema
)
export type WorkspaceAccessBindingListView = z.infer<
  typeof WorkspaceAccessBindingListViewSchema
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
  role: z.enum(ACTOR_ROLES),
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
