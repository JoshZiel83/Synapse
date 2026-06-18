import { z } from "zod"
import { INVITE_TRUST_LEVELS } from "../constants/enums.js"
import { IsoInstantStringSchema } from "./datetime.js"

/**
 * Create-invite request body for workspace invite management.
 *
 * Expiry is expressed as a RELATIVE TTL (`expiresInHours`), never an absolute
 * instant: the client must not be trusted to mint an authoritative expiry from
 * its own wall clock. The server computes `expires_at` from the server clock.
 * Max 24 * 366 hours (~1 leap year).
 */
export const CreateWorkspaceInviteInputSchema = z.object({
  trustLevel: z.enum(INVITE_TRUST_LEVELS).optional(),
  maxUses: z.number().int().positive().optional(),
  expiresInHours: z
    .number()
    .int()
    .positive()
    .max(24 * 366)
    .optional(),
})
export type CreateWorkspaceInviteInput = z.infer<
  typeof CreateWorkspaceInviteInputSchema
>

/**
 * App-facing contract for a workspace invite (management view).
 * Source of truth for the `{ data }` response of the invite CRUD endpoints;
 * the api presenter builds this from the DB record, web/mobile parse it.
 * See docs/architecture-boundary-refactor-master-plan.md §5.1 / §10.1.
 */
export const WorkspaceInviteViewSchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  token: z.string(),
  createdByWorkspaceMemberId: z.string(),
  trustLevel: z.enum(INVITE_TRUST_LEVELS),
  maxUses: z.number().int().nullable(),
  useCount: z.number().int(),
  expiresAt: IsoInstantStringSchema.nullable(),
  isRevoked: z.boolean(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type WorkspaceInviteView = z.infer<typeof WorkspaceInviteViewSchema>
export const WorkspaceInviteListViewSchema = z.array(WorkspaceInviteViewSchema)
export type WorkspaceInviteListView = z.infer<
  typeof WorkspaceInviteListViewSchema
>

/**
 * Public, unauthenticated invite info (what a prospective joiner sees before
 * redeeming). Intentionally narrow — no internal ids or counters.
 */
export const WorkspaceInvitePublicViewSchema = z.strictObject({
  token: z.string(),
  workspaceName: z.string().nullable(),
  trustLevel: z.enum(INVITE_TRUST_LEVELS),
})
export type WorkspaceInvitePublicView = z.infer<
  typeof WorkspaceInvitePublicViewSchema
>

/** Result of redeeming an invite. */
export const WorkspaceInviteRedeemResultSchema = z.strictObject({
  workspaceId: z.string(),
  workspaceName: z.string().nullable(),
  trustLevel: z.enum(INVITE_TRUST_LEVELS),
})
export type WorkspaceInviteRedeemResult = z.infer<
  typeof WorkspaceInviteRedeemResultSchema
>
