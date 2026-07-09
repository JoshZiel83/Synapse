// runtime-authorizations/repo.types.ts — DB-row & column-type aliases for the
// runtime authorization grant tables. This is a "repo" file (matches the guard
// isRepo() pattern), so it is the layer that is allowed to reference Kysely
// TableRow/TableInsert helpers. service.ts imports these as types instead of
// using TableRow< / TableInsert< inline (guard rule r2).

import type { SubjectRef } from "@synapse/shared"
import type { Timestamp } from "@synapse/shared"
import type {
  RuntimeAuthorizationGrantRetention,
  RuntimeAuthorizationGrantStatus,
  SharedRuntimeAuthorizationGrantSpec,
} from "@synapse/shared/types"
import type {
  GrantPolicy,
  PolicyValidationFailure,
} from "@synapse/shared/access/policies"
import type {
  TableInsert,
  TableRow,
} from "../../infrastructure/database/kysely.js"

/**
 * API-side camelCase projection of a runtime authorization grant — a DB row
 * hydrated with its subject/scope SubjectRef pair + derived label. Extends the
 * shared camelCase policy spec so readers (auto-retry envelope, UI grant
 * summary) continue to address `grant.filesystem`, `grant.browser`, etc.
 *
 * Owned here (not in service.ts) so the presenter — which builds this record —
 * depends on the repo type layer rather than on service (guard r-direction:
 * presenter must not import row/projection types from ./service).
 */
export interface RuntimeAuthorizationGrantRecord extends SharedRuntimeAuthorizationGrantSpec {
  id: string
  workspaceId: string
  deviceId: string
  runtimeCapabilityId: string
  runtimeExposureId: string
  /** Authorization subject (workspace / workspace_member / actor / remote_agent / conversation). */
  subject: SubjectRef
  /** Optional runtime-context scope (workspace or conversation). */
  scope?: SubjectRef
  /**
   * Derived display label from subjectScopeLabel({subject, scope?}). Mirrors
   * the wire envelope's `grant_scope` field for UI / audit. Possible values
   * include: 'workspace' | 'workspace_member' | 'actor' | 'remote_agent' |
   * 'conversation' or scoped actor/remote_agent grants.
   */
  scopeLabel: string
  createdByWorkspaceMemberId?: string
  sourceTaskId?: string
  sourceRetryNonce?: string
  sourceRuntimeSessionId?: string
  sourceRequestArgs: Record<string, unknown>
  retention: RuntimeAuthorizationGrantRetention
  status: RuntimeAuthorizationGrantStatus
  createdAt: Timestamp
  updatedAt: Timestamp
  consumedAt?: Timestamp
  revokedAt?: Timestamp
  supersededAt?: Timestamp
}

/**
 * Candidate row pulled by the canonical helper's list step. Carries the raw
 * grant row + already-joined subject/scope SubjectRef + safe-parse result so
 * the matcher (three-state) can distinguish parse_error /
 * missing_branch_payload / schema_mismatch from no_match — without exception
 * propagation that would mask corrupt rows as silent fallbacks.
 */
export interface RuntimeAuthorizationGrantCandidate {
  rawRow: RuntimeAuthorizationGrantCandidateRecord
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

export type RuntimeAuthorizationGrantCandidateRecord = Omit<
  TableRow<"runtimeAuthorizationGrants">,
  "sourceRequestArgs"
> & {
  sourceRequestArgs: Record<string, unknown>
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
