import { z } from "zod"
import { IsoInstantStringSchema } from "./datetime.js"

/**
 * App-facing contracts for the organization (actor) module's APP routes
 * (master plan §5.3). Every organization route is workspace-scoped +
 * authenticated, so its response value is wrapped through `appRoute` →
 * `sendData` → `{ data: ... }`. These schemas describe the value each handler
 * returns (the helper wraps it in `{ data }`).
 *
 * Top-level scalar fields are modeled explicitly. The deeply-nested domain
 * objects an actor carries — its `definition` (docs, config), version `delta`
 * payloads, the `sourceLink`, and the entire marketplace `package`/`manifest`
 * tree for actor packages — are genuinely-open presentation views the
 * presenter/service already own. The boundary only needs to round-trip them
 * unchanged, so they are modeled as `z.unknown()` / open records rather than
 * re-validated interior-by-interior. Deepening these is tracked separately
 * (P1-3 / P1-7), not part of the bare→`{ data }` envelope migration.
 */

/** Single actor (Actor). `definition` / `sourceLink` are open domain views. */
export const ActorViewSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  displayName: z.string(),
  packageId: z.uuid().optional(),
  packageInstanceId: z.uuid().optional(),
  definition: z.unknown(),
  avatarUrl: z.string().optional(),
  currentVersion: z.number(),
  sourceLink: z.unknown().optional(),
  isActive: z.boolean(),
  isPublicShared: z.boolean(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type ActorView = z.infer<typeof ActorViewSchema>

/**
 * Org tree node (ActorTreeNode = Actor + recursive `children`). The actor
 * fields mirror {@link ActorViewSchema}; `children` recurses via a lazy ref.
 */
export const ActorTreeNodeViewSchema: z.ZodType<unknown> = z.lazy(() =>
  ActorViewSchema.extend({
    children: z.array(ActorTreeNodeViewSchema),
  })
)
export type ActorTreeNodeView = z.infer<typeof ActorTreeNodeViewSchema>

/**
 * Actor version (ActorVersion). `snapshot` (an ActorDefinition) and `delta`
 * (an ActorVersionDelta of change blocks) are open domain views.
 */
export const ActorVersionViewSchema = z.object({
  id: z.uuid(),
  actorId: z.uuid(),
  version: z.number(),
  previousVersionId: z.uuid().optional(),
  snapshot: z.unknown(),
  delta: z.unknown().optional(),
  createdByWorkspaceMemberId: z.uuid().optional(),
  source: z.unknown().optional(),
  createdAt: IsoInstantStringSchema,
})
export type ActorVersionView = z.infer<typeof ActorVersionViewSchema>

/**
 * Actor package record (ActorPackageRecord). The marketplace `package`,
 * `manifest`, dependency, and requirement-check trees are open presentation
 * views owned by the marketplace presenter.
 */
export const ActorPackageRecordViewSchema = z.object({
  package: z.unknown(),
  manifest: z.unknown(),
  dependencies: z.array(z.unknown()),
  requirementChecks: z.array(z.unknown()).optional(),
})
export type ActorPackageRecordView = z.infer<
  typeof ActorPackageRecordViewSchema
>

/**
 * Install-package result (ActorPackageInstallResult): the created `actor`
 * (an Actor view) plus the open source package/link and requirement checks.
 */
export const ActorPackageInstallResultViewSchema = z.object({
  actor: ActorViewSchema,
  sourcePackage: ActorPackageRecordViewSchema,
  sourceLink: z.unknown(),
  requirementChecks: z.array(z.unknown()),
})
export type ActorPackageInstallResultView = z.infer<
  typeof ActorPackageInstallResultViewSchema
>
