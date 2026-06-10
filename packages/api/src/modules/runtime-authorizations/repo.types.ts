// runtime-authorizations/repo.types.ts — DB-row & column-type aliases for the
// runtime authorization grant tables. This is a "repo" file (matches the guard
// isRepo() pattern), so it is the layer that is allowed to reference Kysely
// TableRow/TableInsert helpers. service.ts imports these as types instead of
// using TableRow< / TableInsert< inline (guard rule r2).

import type { SubjectRef } from "@synapse/shared"
import type { RuntimeAuthorizationGrantRetention } from "@synapse/shared/types"
import type {
  GrantPolicy,
  PolicyValidationFailure,
} from "@synapse/shared/access/policies"
import type {
  TableInsert,
  TableRow,
} from "../../infrastructure/database/kysely.js"

/**
 * Candidate row pulled by the canonical helper's list step. Carries the raw
 * grant row + already-joined subject/scope SubjectRef + safe-parse result so
 * the matcher (three-state) can distinguish parse_error /
 * missing_branch_payload / schema_mismatch from no_match — without exception
 * propagation that would mask corrupt rows as silent fallbacks.
 */
export interface RuntimeAuthorizationGrantCandidate {
  rawRow: TableRow<"runtimeAuthorizationGrants">
  rawPolicy: unknown
  policyValidationResult:
    | { ok: true; parsed: GrantPolicy }
    | { ok: false; failure: PolicyValidationFailure }
  subject: SubjectRef
  scope?: SubjectRef
  retention: RuntimeAuthorizationGrantRetention
  retryNonceOnRow?: string
  sourceTaskIdOnRow?: string
}

/**
 * Raw grant row joined with the access_subjects view columns (subject + scope).
 * Hydrated into a RuntimeAuthorizationGrantCandidate by rowToCandidate.
 */
export type RuntimeAuthorizationGrantCandidateRow =
  TableRow<"runtimeAuthorizationGrants"> & {
    subjectKind: string
    subjectWorkspaceId: string | null
    subjectWorkspaceMemberId: string | null
    subjectActorId: string | null
    subjectRemoteAgentId: string | null
    subjectConversationId: string | null
    scopeKind: string | null
    scopeWorkspaceId: string | null
    scopeConversationId: string | null
  }

/** JSONB `policy` column shape on INSERT into runtime_authorization_grants. */
export type RuntimeAuthorizationGrantPolicyInsert =
  TableInsert<"runtimeAuthorizationGrants">["policy"]

/** JSONB `sourceRequestArgs` column shape on INSERT into runtime_authorization_grants. */
export type RuntimeAuthorizationGrantSourceRequestArgsInsert =
  TableInsert<"runtimeAuthorizationGrants">["sourceRequestArgs"]
