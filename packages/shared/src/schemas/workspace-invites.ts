import { z } from "zod"
import { INVITE_TRUST_LEVELS } from "../constants/enums.js"
import { IsoInstantStringSchema } from "./datetime.js"

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
