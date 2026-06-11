import { z } from "zod"
import { IsoInstantStringSchema } from "./datetime.js"
import {
  RUNTIME_AUTHORIZATION_CAPABILITIES,
  RUNTIME_AUTHORIZATION_GRANT_RETENTIONS,
  RUNTIME_AUTHORIZATION_GRANT_STATUSES,
} from "../constants/enums.js"

/**
 * App-facing contract for the manual runtime-authorization grant endpoint
 * (POST /api/v1/workspaces/:workspaceId/runtime-authorization-grants). Per
 * master plan §5.3 this is a workspace-scoped, authenticated APP route, so the
 * response is wrapped through `sendData` → `{ data: ... }` and modeled by a
 * shared schema.
 *
 * The schema describes the value the handler returns — the API-side camelCase
 * RuntimeAuthorizationGrantRecord (a hydrated grant row that extends the shared
 * camelCase policy spec). Top-level identity / lifecycle fields are modeled
 * explicitly; the embedded policy capability payloads (filesystem / cua /
 * browser / commandline) and the subject/scope SubjectRefs are genuinely-open
 * unions whose canonical definitions live in `../access/*`, so they are modeled
 * permissively here (object with `kind` discriminator + passthrough; capability
 * payloads as open records). This keeps the wire contract explicit without
 * re-deriving the policy schema at the boundary.
 */

/** Authorization subject / scope (SubjectRef discriminated union). */
const SubjectRefViewSchema = z
  .object({ kind: z.string() })
  .catchall(z.unknown())

/**
 * A capability policy payload (filesystem / cua / browser / commandline).
 * Genuinely-open nested value: the canonical typed shapes live in
 * `../access/policies`; modeled as `z.unknown()` here so any already-normalized
 * typed payload the presenter produces passes the boundary parse unchanged.
 */
const PolicyCapabilityPayloadSchema = z.unknown()

/** A hydrated runtime authorization grant as returned by the manual endpoint. */
export const RuntimeAuthorizationGrantRecordViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  deviceId: z.string(),
  deviceCapabilityId: z.string(),
  deviceExposureId: z.string(),
  subject: SubjectRefViewSchema,
  scope: SubjectRefViewSchema.optional(),
  scopeLabel: z.string(),
  createdByWorkspaceMemberId: z.string().optional(),
  sourceTaskId: z.string().optional(),
  sourceRetryNonce: z.string().optional(),
  sourceRuntimeSessionId: z.string().optional(),
  sourceRequestArgs: z.record(z.string(), z.unknown()),
  retention: z.enum(RUNTIME_AUTHORIZATION_GRANT_RETENTIONS),
  status: z.enum(RUNTIME_AUTHORIZATION_GRANT_STATUSES),
  // Embedded SharedRuntimeAuthorizationGrantSpec (capability + per-capability
  // payloads). Modeled permissively — the canonical GrantPolicy schema is the
  // validation gate at write time (createRuntimeAuthorizationGrant); here we
  // only surface the already-normalized shape.
  capability: z.enum(RUNTIME_AUTHORIZATION_CAPABILITIES),
  filesystem: PolicyCapabilityPayloadSchema.optional(),
  cua: PolicyCapabilityPayloadSchema.optional(),
  browser: PolicyCapabilityPayloadSchema.optional(),
  commandline: PolicyCapabilityPayloadSchema.optional(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
  consumedAt: IsoInstantStringSchema.optional(),
  revokedAt: IsoInstantStringSchema.optional(),
  supersededAt: IsoInstantStringSchema.optional(),
})
export type RuntimeAuthorizationGrantRecordView = z.infer<
  typeof RuntimeAuthorizationGrantRecordViewSchema
>
