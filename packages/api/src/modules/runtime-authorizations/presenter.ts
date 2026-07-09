// runtime-authorizations/presenter.ts — DTO-shaping for runtime authorization
// grants. Maps a hydrated candidate row into the API-side camelCase
// RuntimeAuthorizationGrantRecord. This is the presenter layer, so calling
// serializeInstant / serializeOptionalInstant here satisfies guard rule r3
// (banned only in service.ts / controller*.ts). Presenter must NOT import
// generated/db or use TableRow — it takes the DB-row type via `import type`
// from repo.types.

import {
  subjectScopeLabel,
  type SharedRuntimeAuthorizationGrantSpec,
} from "@synapse/shared"
import type { GrantPolicy } from "@synapse/shared/access/policies"
import {
  requireInstantDate,
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
import type {
  RuntimeAuthorizationGrantCandidate,
  RuntimeAuthorizationGrantRecord,
} from "./repo.types.js"

// ============================================================================
// Mapping: candidate → record. Mapper is a pure function — caller must pass
// parsedPolicy from a successful validateGrantPolicyForCapability call. The
// canonical helper enforces this contract; sideways callers (dashboard list)
// produce a parallel "{ valid, corrupt }" split (Batch 7 dashboard API).
// ============================================================================

export function mapRuntimeAuthorizationGrantCandidate(
  candidate: RuntimeAuthorizationGrantCandidate,
  parsedPolicy: GrantPolicy
): RuntimeAuthorizationGrantRecord {
  const row = candidate.rawRow
  const scopeLabel = subjectScopeLabel({
    subject: candidate.subject,
    scope: candidate.scope,
  })
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    // App-facing wire field stays `deviceId` (schemas/runtime-authorizations.ts);
    // the internal grant column is now `runtimeId` (runtimes CTI root).
    deviceId: row.runtimeId,
    runtimeCapabilityId: row.runtimeCapabilityId,
    runtimeExposureId: row.runtimeExposureId,
    subject: candidate.subject,
    scope: candidate.scope,
    scopeLabel,
    createdByWorkspaceMemberId: row.createdByWorkspaceMemberId || undefined,
    sourceTaskId: row.sourceTaskId || undefined,
    sourceRetryNonce: row.sourceRetryNonce || undefined,
    sourceRuntimeSessionId: row.sourceRuntimeSessionId || undefined,
    sourceRequestArgs: row.sourceRequestArgs,
    retention: row.retention,
    status: row.status,
    ...(parsedPolicy as SharedRuntimeAuthorizationGrantSpec),
    createdAt: serializeInstant(
      requireInstantDate(
        row.createdAt,
        `runtime_authorization_grants.${row.id}.created_at`
      )
    ),
    updatedAt: serializeInstant(
      requireInstantDate(
        row.updatedAt,
        `runtime_authorization_grants.${row.id}.updated_at`
      )
    ),
    consumedAt: serializeOptionalInstant(row.consumedAt),
    revokedAt: serializeOptionalInstant(row.revokedAt),
    supersededAt: serializeOptionalInstant(row.supersededAt),
  }
}
