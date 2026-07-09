// Pure device-operation business helpers. DB-touching operation lifecycle
// helpers live in repo.ts and are re-exported below for existing import paths.

import type { RuntimePrincipalContext } from "../access/subject-resolution.js"
import { SUBJECT_KIND } from "@synapse/shared"
import type { OperationPrincipalKind } from "./repo.js"

// subject-scope-refactor: scoped actor target removed from the operation
// principal_kind enum. The scoped-actor semantics is expressed as
// (principal.kind='actor', activeConversationSubjectId set) in
// RuntimePrincipalContext; deriveOperationPrincipalAudit collapses it back to
// 'actor' for the audit row. The DB enum device_operations_principal_kind
// matches. The persisted operation input/result types live in repo.ts.

/**
 * subject-scope-refactor: derive the (principalKind, principalSubjectId) audit
 * pair for `runtime_operations` from a RuntimePrincipalContext. The ONLY
 * supported construction path for `BeginOperationInput.principal{Kind,SubjectId}`
 * — kind/subject consistency is an app-only invariant (the DB CHECK only
 * enforces non-null; cross-table kind correspondence in PG would require
 * deferrable constraint triggers, which is not cost-effective).
 *
 * Mapping:
 *   - principal.kind === 'actor'           → 'actor'           (incl. actor+scope=conversation)
 *   - principal.kind === 'remote_agent'    → 'remote_agent'
 *   - principal.kind === 'conversation'    → 'conversation'
 *   - principal.kind === 'workspace_member'→ 'workspace_member'
 *   - other (workspace, user, external, system) → throw InvalidPrincipalKindForDeviceOperation
 *
 * Note the scoped-actor case before the refactor
 * collapses to 'actor' — the conversation context is recorded separately via
 * `runtime_operations.conversation_id` + `authorization_payload`.
 */
export function deriveOperationPrincipalAudit(ctx: RuntimePrincipalContext): {
  principalKind: OperationPrincipalKind
  principalSubjectId: string
} {
  const kind = ctx.principal.kind
  switch (kind) {
    case SUBJECT_KIND.ACTOR:
      return {
        principalKind: "actor",
        principalSubjectId: ctx.principalSubjectId,
      }
    case SUBJECT_KIND.REMOTE_AGENT:
      return {
        principalKind: "remote_agent",
        principalSubjectId: ctx.principalSubjectId,
      }
    case SUBJECT_KIND.CONVERSATION:
      return {
        principalKind: "conversation",
        principalSubjectId: ctx.principalSubjectId,
      }
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      return {
        principalKind: "workspace_member",
        principalSubjectId: ctx.principalSubjectId,
      }
    default:
      throw new InvalidPrincipalKindForDeviceOperation(kind)
  }
}

export class InvalidPrincipalKindForDeviceOperation extends Error {
  constructor(kind: string) {
    super(
      `principal kind "${kind}" is not allowed to dispatch device operations (only actor / remote_agent / conversation / workspace_member)`
    )
    this.name = "InvalidPrincipalKindForDeviceOperation"
  }
}

export {
  assertNoDeviceToolRevisionDrift,
  beginDeviceOperation,
  beginDeviceOperationOn,
  completeDeviceOperation,
  RevisionDriftError,
} from "./repo.js"
export type {
  BeginOperationInput,
  BeginOperationResult,
  CompleteOperationInput,
  OperationPrincipalKind,
} from "./repo.js"
