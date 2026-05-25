// Device operations + attempts lifecycle. Every dispatch creates a
// device_operations row (status='created' → 'dispatched' → 'completed' /
// 'failed') and a device_operation_attempts row (status='issued' →
// 'acknowledged' / 'failed'). The lifecycle gives the dashboard a
// complete audit trail of which actor invoked which device tool with
// which envelope, and lets retry logic key off attempt_seq.

import { randomUUID } from "node:crypto"
import { sql, type Transaction } from "kysely"
import type { OperationEnvelope, SynapseError } from "@synapse/device-protocol"
import { db } from "../../infrastructure/database/kysely.js"
import type { DB } from "../../infrastructure/database/generated/db.js"

export type OperationPrincipalKind =
  | "actor"
  | "conversation"
  | "actor_in_conversation"
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
  principalSubjectId: string | null
  initiatedByWorkspaceMemberId: string | null
  initiatedBySessionId: string | null
}

export interface BeginOperationResult {
  operationId: string
  attemptId: string
  attemptSeq: number
}

/**
 * Insert a device_operations + first device_operation_attempts row pair,
 * with a revision drift check: the envelope's device_tool_revision_id must
 * match device_tools.latest_revision_id, otherwise we throw
 * tool_definition_changed before issuing the dispatch.
 */
export async function beginDeviceOperation(
  input: BeginOperationInput
): Promise<BeginOperationResult> {
  return db.transaction().execute(async (trx) => {
    // Revision drift: between catalog-sync writing the latest revision and
    // the chat runtime issuing a tool call, the device may have re-synced
    // and bumped the revision. If so, the planner's mental model is stale
    // and the call must replan instead of dispatching.
    await assertNoRevisionDrift(trx, {
      toolId: input.envelope.device_tool_id,
      expectedRevisionId: input.envelope.device_tool_revision_id,
    })

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
        expires_at: input.envelope.expires_at,
      } as never)
      .execute()

    await trx
      .insertInto("device_operation_attempts")
      .values({
        id: attemptId,
        operation_id: operationId,
        attempt_seq: 1,
        transport: "tunnel_http",
        device_service_id: input.deviceServiceId,
        tunnel_internal_url: input.tunnelInternalUrl,
        mcp_request_id: attemptId,
        envelope_signature_kid: input.envelope.signature_kid,
        status: "issued",
        started_at: sql`NOW()`,
      } as never)
      .execute()

    return { operationId, attemptId, attemptSeq: 1 }
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
      } as never)
      .where("id", "=", input.attemptId)
      .execute()
    await trx
      .updateTable("device_operations")
      .set({
        status: input.ok ? "completed" : "failed",
        result_hash: input.resultHash ?? null,
        error_code: input.error?.code ?? null,
        error_message: input.error?.message ?? null,
        completed_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      } as never)
      .where("id", "=", input.operationId)
      .execute()
  })
}

async function assertNoRevisionDrift(
  trx: Transaction<DB>,
  args: { toolId: string; expectedRevisionId: string }
): Promise<void> {
  const tool = await trx
    .selectFrom("device_tools")
    .select(["latest_revision_id"])
    .where("id", "=", args.toolId)
    .executeTakeFirst()
  if (!tool) {
    throw new RevisionDriftError(
      `device_tool ${args.toolId} not found (catalog may have been re-synced and removed the tool)`
    )
  }
  if ((tool.latest_revision_id as string | null) !== args.expectedRevisionId) {
    throw new RevisionDriftError(
      `device_tool ${args.toolId} revision drifted: envelope expected ${args.expectedRevisionId}, current latest is ${tool.latest_revision_id ?? "null"}`
    )
  }
}

async function getCatalogRevisionForToolRevision(
  trx: Transaction<DB>,
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
