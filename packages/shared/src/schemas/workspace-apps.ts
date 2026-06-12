import { z } from "zod"
import {
  WORKSPACE_APP_KINDS,
  WORKSPACE_APP_STATUSES,
  WORKSPACE_APP_GRANT_PERMISSIONS,
  WORKSPACE_APP_GRANT_SOURCES,
  WORKSPACE_APP_GRANT_STATUSES,
  WORKSPACE_APP_GRANT_REQUEST_STATUSES,
} from "../access/enums.js"
import { IsoInstantStringSchema } from "./datetime.js"

/**
 * App-facing camelCase contracts for the workspace-apps module's APP routes
 * (master plan §5.3). workspace-apps is a Tier-A app-facing module: every route
 * is workspace-scoped + authenticated, so each handler's returned value is
 * wrapped through `appRoute` → `sendData` → `{ data: ... }`. These schemas
 * describe the value each handler returns (the helper wraps it).
 *
 * Top-level scalar/enum fields are modeled explicitly. The `target` / `grantee`
 * fields are `CapabilityAccessTarget` discriminated `{ subject, scope? }`
 * payloads the presenter already shapes from joined rows; they are a
 * genuinely-open subject-ref union that the boundary only needs to round-trip
 * unchanged, so they are modeled as `z.unknown()` here rather than re-validated.
 */

/** GET/POST/PUT workspace-app inventory item (presentWorkspaceApp). */
export const WorkspaceAppViewSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  kind: z.enum(WORKSPACE_APP_KINDS),
  displayName: z.string(),
  ownerWorkspaceMemberId: z.uuid().optional(),
  status: z.enum(WORKSPACE_APP_STATUSES),
  sourceDefaultConversationTypeMask: z.number().int().optional(),
  workspaceConversationTypeMask: z.number().int().optional(),
  conversationTypeMaskOverride: z.number().int().optional(),
  effectiveConversationTypeMask: z.number().int().optional(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type WorkspaceAppViewSchemaType = z.infer<typeof WorkspaceAppViewSchema>

/** GET/PUT workspace-app grant (presentGrant). `target` is an open subject ref. */
export const WorkspaceAppGrantViewSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  workspaceAppId: z.uuid(),
  target: z.unknown(),
  permissions: z.array(z.enum(WORKSPACE_APP_GRANT_PERMISSIONS)),
  status: z.enum(WORKSPACE_APP_GRANT_STATUSES),
  source: z.enum(WORKSPACE_APP_GRANT_SOURCES),
  grantedByWorkspaceMemberId: z.uuid().optional(),
  reason: z.string().optional(),
  conversationTypeMaskOverride: z.number().int().nullable().optional(),
  effectiveConversationTypeMask: z.number().int().optional(),
  createdAt: IsoInstantStringSchema,
  revokedAt: IsoInstantStringSchema.optional(),
})
export type WorkspaceAppGrantViewSchemaType = z.infer<
  typeof WorkspaceAppGrantViewSchema
>

/**
 * GET/POST workspace-app grant request (presentGrantRequest). `grantee` is an
 * open subject ref the presenter shapes from joined rows.
 */
export const WorkspaceAppGrantRequestViewSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  workspaceAppId: z.uuid(),
  grantee: z.unknown(),
  requestedPermissions: z.array(z.enum(WORKSPACE_APP_GRANT_PERMISSIONS)),
  requesterWorkspaceMemberId: z.uuid(),
  status: z.enum(WORKSPACE_APP_GRANT_REQUEST_STATUSES),
  resolvedByWorkspaceMemberId: z.uuid().optional(),
  resolvedAt: IsoInstantStringSchema.optional(),
  reason: z.string().optional(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type WorkspaceAppGrantRequestViewSchemaType = z.infer<
  typeof WorkspaceAppGrantRequestViewSchema
>
