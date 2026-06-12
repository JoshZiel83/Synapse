// Device operations + attempts lifecycle. Every dispatch creates a
// device_operations row (status='created' → 'dispatched' → 'succeeded' /
// 'failed') and a device_operation_attempts row (status='issued' →
// 'acknowledged' / 'failed'). The lifecycle gives the dashboard a
// complete audit trail of which actor invoked which device tool with
// which envelope, and lets retry logic key off attempt_seq.

import { sql } from "kysely"
import type { OperationEnvelope, SynapseError } from "@synapse/device-protocol"
import type {
  DatabaseTransaction,
  KyselyDb,
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
    .selectFrom("deviceTools")
    .select(["latestRevisionId"])
    .where("id", "=", toolId)
    .executeTakeFirst()
  if (!tool) {
    throw new RevisionDriftError(
      `device_tool ${toolId} not found (catalog may have been re-synced and removed the tool)`
    )
  }
  if ((tool.latestRevisionId as string | null) !== expectedRevisionId) {
    throw new RevisionDriftError(
      `device_tool ${toolId} revision drifted: envelope expected ${expectedRevisionId}, current latest is ${tool.latestRevisionId ?? "null"}`
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
    .insertInto("deviceOperations")
    .values({
      id: operationId,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      principalKind: input.principalKind,
      principalSubjectId: input.principalSubjectId,
      initiatedByWorkspaceMemberId: input.initiatedByWorkspaceMemberId,
      initiatedBySessionId: input.initiatedBySessionId,
      deviceId: input.deviceId,
      deviceExposureId: input.envelope.device_exposure_id,
      deviceCapabilityId: input.envelope.device_capability_id,
      catalogRevisionId: await getCatalogRevisionForToolRevision(
        trx,
        input.envelope.device_tool_revision_id
      ),
      toolId: input.envelope.device_tool_id,
      toolRevisionId: input.envelope.device_tool_revision_id,
      visibleToolName: input.toolName,
      taskMode: input.envelope.task_mode,
      status: "dispatched",
      inputPayload: sql`${JSON.stringify(input.args)}::jsonb`,
      authorizationPayload: sql`${JSON.stringify(
        input.envelope.runtime_authorization ?? {}
      )}::jsonb`,
      inputHash: input.envelope.input_hash,
      expiresAt: parseInstantString(input.envelope.expires_at),
    })
    .execute()

  await trx
    .insertInto("deviceOperationAttempts")
    .values({
      id: attemptId,
      operationId: operationId,
      attemptSeq: 1n,
      // Schema's device_operation_attempts_transport enum is
      // {mcp_http, control_plane_task}. The MCP-over-frp path is
      // mcp_http — control_plane_task is reserved for the async
      // task path (PR follow-up).
      transport: "mcp_http",
      deviceServiceId: input.deviceServiceId,
      tunnelInternalUrl: input.tunnelInternalUrl,
      mcpRequestId: attemptId,
      envelopeSignatureKid: input.envelope.signature_kid,
      status: "issued",
      startedAt: sql`NOW()`,
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
 *
 * The transactional body lives in repo.ts (guard r8: only repo*.ts may import
 * the db client). Re-exported here so existing importers
 * (`../devices/operations.js`) keep resolving it unchanged.
 */
export { beginDeviceOperation, completeDeviceOperation } from "./repo.js"

export interface CompleteOperationInput {
  operationId: string
  attemptId: string
  ok: boolean
  resultHash?: string
  error?: SynapseError
}

// subject-scope-refactor: private `assertNoRevisionDrift` removed; superseded
// by the public `assertNoDeviceToolRevisionDrift` helper above. Callers (incl.
// canonical claim path + `beginDeviceOperation` wrapper) use the public form.

async function getCatalogRevisionForToolRevision(
  trx: DatabaseTransaction,
  toolRevisionId: string
): Promise<string> {
  const row = await trx
    .selectFrom("deviceToolRevisions")
    .select(["catalogRevisionId"])
    .where("id", "=", toolRevisionId)
    .executeTakeFirst()
  if (!row) {
    throw new Error(
      `device_tool_revision ${toolRevisionId} not found — envelope is stale`
    )
  }
  return row.catalogRevisionId as string
}

export class RevisionDriftError extends Error {
  readonly code = "tool_definition_changed" as const
  constructor(message: string) {
    super(message)
    this.name = "RevisionDriftError"
  }
}
