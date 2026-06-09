// Device operations + attempts lifecycle. Every dispatch creates a
// device_operations row (status='created' → 'dispatched' → 'succeeded' /
// 'failed') and a device_operation_attempts row (status='issued' →
// 'acknowledged' / 'failed'). The lifecycle gives the dashboard a
// complete audit trail of which actor invoked which device tool with
// which envelope, and lets retry logic key off attempt_seq.

import { sql } from "kysely"
import type { OperationEnvelope, SynapseError } from "@synapse/device-protocol"
import {
  db,
  type DatabaseTransaction,
  type KyselyDb,
} from "../../infrastructure/database/kysely.js"
import { parseInstantString } from "../../infrastructure/datetime.js"
import type { RuntimePrincipalContext } from "../access/subject-resolution.js"
import { SUBJECT_KIND } from "@synapse/shared"

// subject-scope-refactor: scoped actor target removed from the operation
// principal_kind enum. The scoped-actor semantics is expressed as
// (principal.kind='actor', activeConversationSubjectId set) in
// RuntimePrincipalContext; deriveOperationPrincipalAudit collapses it back to
// 'actor' for the audit row. The DB enum device_operations_principal_kind
// matches.
export type OperationPrincipalKind =
  | "actor"
  | "conversation"
  | "remote_agent"
  | "workspace_member"

export interface BeginOperationInput {
  workspaceId: string
  conversationId: string | null
  envelope: OperationEnvelope
  args: Record<string, unknown>
  toolName: string
  deviceId: string
  deviceServiceId: string
  tunnelInternalUrl: string | null
  principalKind: OperationPrincipalKind
  // subject-scope-refactor: NOT NULL — paired with the tightened
  // chk_device_operations_principal which now requires principal_subject_id for
  // all 4 kinds (workspace_member exception dropped). Callers MUST construct
  // this via `deriveOperationPrincipalAudit(ctx: RuntimePrincipalContext)` so
  // the kind ↔ subject correspondence is enforced at the TS boundary.
  principalSubjectId: string
  initiatedByWorkspaceMemberId: string | null
  initiatedBySessionId: string | null
}

export interface BeginOperationResult {
  operationId: string
  attemptId: string
  attemptSeq: number
}

/**
 * subject-scope-refactor: derive the (principalKind, principalSubjectId) audit
 * pair for `device_operations` from a RuntimePrincipalContext. The ONLY
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
 * `device_operations.conversation_id` + `authorization_payload`.
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

/**
 * subject-scope-refactor: public extract of the device_tools.latest_revision_id
 * drift check used by `beginDeviceOperation` and by the canonical
 * `selectAndClaimRuntimeAuthorizationGrant` helper. Accepts either the global
 * Kysely `db` or an in-flight `DatabaseTransaction` — both expose the same
 * SELECT surface, so callers in atomic claim paths can re-check drift inside
 * their transaction without ceding the lock.
 */
export async function assertNoDeviceToolRevisionDrift(
  dbOrTrx: KyselyDb | DatabaseTransaction,
  toolId: string,
  expectedRevisionId: string
): Promise<void> {
  const tool = await dbOrTrx
    .selectFrom("device_tools")
    .select(["latest_revision_id"])
    .where("id", "=", toolId)
    .executeTakeFirst()
  if (!tool) {
    throw new RevisionDriftError(
      `device_tool ${toolId} not found (catalog may have been re-synced and removed the tool)`
    )
  }
  if ((tool.latest_revision_id as string | null) !== expectedRevisionId) {
    throw new RevisionDriftError(
      `device_tool ${toolId} revision drifted: envelope expected ${expectedRevisionId}, current latest is ${tool.latest_revision_id ?? "null"}`
    )
  }
}

/**
 * subject-scope-refactor: Kysely-transaction variant of beginDeviceOperation
 * that **does NOT** do drift check — the canonical
 * `selectAndClaimRuntimeAuthorizationGrant` helper already enforces drift in
 * two places (prepareGrant pre-claim + same-transaction FOR SHARE re-check
 * after the row lock), so doing it a third time here is redundant. Sole
 * responsibility: INSERT the device_operations + first device_operation_attempts
 * pair using the caller-supplied transaction.
 *
 * `beginDeviceOperation` retains the drift check as defense-in-depth for
 * any sideways caller that does NOT go through the canonical claim path.
 */
export async function beginDeviceOperationOn(
  trx: DatabaseTransaction,
  input: BeginOperationInput
): Promise<BeginOperationResult> {
  const operationId = input.envelope.operation_id
  const attemptId = input.envelope.attempt_id
  await trx
    .insertInto("device_operations")
    .values({
      id: operationId,
      workspace_id: input.workspaceId,
      conversation_id: input.conversationId,
      principal_kind: input.principalKind,
      principal_subject_id: input.principalSubjectId,
      initiated_by_workspace_member_id: input.initiatedByWorkspaceMemberId,
      initiated_by_session_id: input.initiatedBySessionId,
      device_id: input.deviceId,
      device_exposure_id: input.envelope.device_exposure_id,
      device_capability_id: input.envelope.device_capability_id,
      catalog_revision_id: await getCatalogRevisionForToolRevision(
        trx,
        input.envelope.device_tool_revision_id
      ),
      tool_id: input.envelope.device_tool_id,
      tool_revision_id: input.envelope.device_tool_revision_id,
      visible_tool_name: input.toolName,
      task_mode: input.envelope.task_mode,
      status: "dispatched",
      input_payload: sql`${JSON.stringify(input.args)}::jsonb`,
      authorization_payload: sql`${JSON.stringify(
        input.envelope.runtime_authorization ?? {}
      )}::jsonb`,
      input_hash: input.envelope.input_hash,
      expires_at: parseInstantString(input.envelope.expires_at),
    })
    .execute()

  await trx
    .insertInto("device_operation_attempts")
    .values({
      id: attemptId,
      operation_id: operationId,
      attempt_seq: 1n,
      // Schema's device_operation_attempts_transport enum is
      // {mcp_http, control_plane_task}. The MCP-over-frp path is
      // mcp_http — control_plane_task is reserved for the async
      // task path (PR follow-up).
      transport: "mcp_http",
      device_service_id: input.deviceServiceId,
      tunnel_internal_url: input.tunnelInternalUrl,
      mcp_request_id: attemptId,
      envelope_signature_kid: input.envelope.signature_kid,
      status: "issued",
      started_at: sql`NOW()`,
    })
    .execute()

  return { operationId, attemptId, attemptSeq: 1 }
}

/**
 * Insert a device_operations + first device_operation_attempts row pair,
 * with a revision drift check: the envelope's device_tool_revision_id must
 * match device_tools.latest_revision_id, otherwise we throw
 * tool_definition_changed before issuing the dispatch.
 *
 * subject-scope-refactor: kept as a thin wrapper for sideways callers (paths
 * NOT going through `selectAndClaimRuntimeAuthorizationGrant`). The drift
 * check + INSERT run in the same Kysely transaction so a concurrent catalog
 * sync can't slip in between.
 */
export async function beginDeviceOperation(
  input: BeginOperationInput
): Promise<BeginOperationResult> {
  return db.transaction().execute(async (trx) => {
    await assertNoDeviceToolRevisionDrift(
      trx,
      input.envelope.device_tool_id,
      input.envelope.device_tool_revision_id
    )
    return beginDeviceOperationOn(trx, input)
  })
}

export interface CompleteOperationInput {
  operationId: string
  attemptId: string
  ok: boolean
  resultHash?: string
  error?: SynapseError
}

/**
 * Mark a previously-begun operation as completed or failed. Always called
 * in the dispatch loop's `finally` so partial states (errors mid-dispatch)
 * still land in the audit trail.
 */
export async function completeDeviceOperation(
  input: CompleteOperationInput
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("device_operation_attempts")
      .set({
        status: input.ok ? "acknowledged" : "failed",
        response_at: sql`NOW()`,
        acknowledged_at: input.ok ? sql`NOW()` : null,
        updated_at: sql`NOW()`,
        metadata: input.error
          ? sql`${JSON.stringify({ error: input.error })}::jsonb`
          : sql`'{}'::jsonb`,
      })
      .where("id", "=", input.attemptId)
      .execute()
    await trx
      .updateTable("device_operations")
      .set({
        // Schema's device_operations_status terminal enum value is
        // 'succeeded' (not 'completed'). Failed dispatches use 'failed'.
        status: input.ok ? "succeeded" : "failed",
        result_hash: input.resultHash ?? null,
        error_code: input.error?.code ?? null,
        error_message: input.error?.message ?? null,
        completed_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      })
      .where("id", "=", input.operationId)
      .execute()
  })
}

// subject-scope-refactor: private `assertNoRevisionDrift` removed; superseded
// by the public `assertNoDeviceToolRevisionDrift` helper above. Callers (incl.
// canonical claim path + `beginDeviceOperation` wrapper) use the public form.

async function getCatalogRevisionForToolRevision(
  trx: DatabaseTransaction,
  toolRevisionId: string
): Promise<string> {
  const row = await trx
    .selectFrom("device_tool_revisions")
    .select(["catalog_revision_id"])
    .where("id", "=", toolRevisionId)
    .executeTakeFirst()
  if (!row) {
    throw new Error(
      `device_tool_revision ${toolRevisionId} not found — envelope is stale`
    )
  }
  return row.catalog_revision_id as string
}

export class RevisionDriftError extends Error {
  readonly code = "tool_definition_changed" as const
  constructor(message: string) {
    super(message)
    this.name = "RevisionDriftError"
  }
}
