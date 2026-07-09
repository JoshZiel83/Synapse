import { z } from "zod"
import { IsoInstantStringSchema } from "./datetime.js"
import {
  RUNTIME_AUTHORIZATION_CAPABILITIES,
  RUNTIME_AUTHORIZATION_GRANT_RETENTIONS,
  RUNTIME_AUTHORIZATION_GRANT_STATUSES,
} from "../constants/enums.js"
import {
  GrantPolicySchema,
  validateGrantPolicyForCapability,
} from "../access/policies/grant.js"
import { SUBJECT_KIND } from "../access/enums.js"

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
 * explicitly; the embedded policy capability payloads reuse the shared
 * GrantPolicy branch schemas, and subject/scope values validate the shared
 * SubjectRef discriminated-union shape.
 */

/** Authorization subject / scope (SubjectRef discriminated union). */
const SubjectRefViewSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal(SUBJECT_KIND.WORKSPACE),
    workspaceId: z.string(),
  }),
  z.strictObject({
    kind: z.literal(SUBJECT_KIND.WORKSPACE_MEMBER),
    workspaceMemberId: z.string(),
  }),
  z.strictObject({
    kind: z.literal(SUBJECT_KIND.ACTOR),
    actorId: z.string(),
  }),
  z.strictObject({
    kind: z.literal(SUBJECT_KIND.REMOTE_AGENT),
    remoteAgentId: z.string(),
  }),
  z.strictObject({
    kind: z.literal(SUBJECT_KIND.CONVERSATION),
    conversationId: z.string(),
  }),
  z.strictObject({
    kind: z.literal(SUBJECT_KIND.USER),
    userId: z.string(),
  }),
  z.strictObject({
    kind: z.literal(SUBJECT_KIND.EXTERNAL),
    workspaceId: z.string(),
    transportAddressId: z.string(),
  }),
  z.strictObject({
    kind: z.literal(SUBJECT_KIND.PLATFORM),
  }),
])

function addGrantPolicyValidationIssues(policy: unknown, ctx: z.RefinementCtx) {
  const validation = validateGrantPolicyForCapability(policy)
  if (validation.ok) return
  if (validation.failure.kind === "missing_branch_payload") {
    ctx.addIssue({
      code: "custom",
      path: [validation.failure.capability],
      message: `policy.${validation.failure.capability} is required when capability is ${validation.failure.capability}`,
    })
    return
  }
  for (const issue of validation.failure.issues) {
    ctx.addIssue({
      code: "custom",
      path: issue.path,
      message: issue.message,
    })
  }
}

/** A hydrated runtime authorization grant as returned by the manual endpoint. */
export const RuntimeAuthorizationGrantRecordViewSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    deviceId: z.string(),
    runtimeCapabilityId: z.string(),
    runtimeExposureId: z.string(),
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
    // Embedded SharedRuntimeAuthorizationGrantSpec (capability +
    // per-capability payloads). The superRefine below enforces that the branch
    // matching `capability` is present, mirroring the repo/service validation.
    capability: z.enum(RUNTIME_AUTHORIZATION_CAPABILITIES),
    filesystem: GrantPolicySchema.shape.filesystem,
    cua: GrantPolicySchema.shape.cua,
    browser: GrantPolicySchema.shape.browser,
    commandline: GrantPolicySchema.shape.commandline,
    createdAt: IsoInstantStringSchema,
    updatedAt: IsoInstantStringSchema,
    consumedAt: IsoInstantStringSchema.optional(),
    revokedAt: IsoInstantStringSchema.optional(),
    supersededAt: IsoInstantStringSchema.optional(),
  })
  .superRefine((grant, ctx) => addGrantPolicyValidationIssues(grant, ctx))
export type RuntimeAuthorizationGrantRecordView = z.infer<
  typeof RuntimeAuthorizationGrantRecordViewSchema
>

export const RuntimeAuthorizationGrantPolicyInputSchema =
  GrantPolicySchema.superRefine((policy, ctx) =>
    addGrantPolicyValidationIssues(policy, ctx)
  )
export type RuntimeAuthorizationGrantPolicyInput = z.infer<
  typeof RuntimeAuthorizationGrantPolicyInputSchema
>

/** Body for POST /runtime-authorization-grants. App surface stays camelCase. */
export const CreateManualRuntimeAuthorizationGrantInputSchema = z.strictObject({
  runtimeCapabilityId: z.uuid(),
  policy: RuntimeAuthorizationGrantPolicyInputSchema,
})
export type CreateManualRuntimeAuthorizationGrantInput = z.infer<
  typeof CreateManualRuntimeAuthorizationGrantInputSchema
>
