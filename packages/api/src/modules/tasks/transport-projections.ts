/**
 * Persistent projection state for the task-projection worker.
 *
 * Logical model:
 *   - When `createRuntimeAuthorizationTaskRequest` succeeds, the
 *     core tx inserts (or refreshes) a row in
 *     `tool_call_task_transport_projections(status='pending')` so the
 *     projection worker has a durable handle on "this task
 *     wants to be rendered onto an IM transport".
 *   - The worker scans pending rows, runs:
 *        resolveBindingForOutbound(conversationId, allowedKinds=['qq'])
 *        ↓ ok → mint action tokens → createConversationItem(subtype='system',
 *               surface='internal', interaction_prompt part) →
 *               persistOutboundLinkRow(tx) → projection.status='projected'
 *        ↓ skip → projection.status='skipped' + error reason
 *   - Recovery: subsequent calls to createRuntimeAuthorizationTaskRequest
 *     that hit an existing-pending task re-arm the projection
 *     row (via ON CONFLICT DO UPDATE) so a fixed binding triggers a
 *     fresh projection attempt.
 */

import { sql } from "kysely"
import type { Executor } from "../../infrastructure/database/kysely.js"

export interface UpsertProjectionParams {
  taskId: string
  workspaceId: string
  conversationId: string
}

/**
 * Insert (or re-arm) the projection row. Re-arm only fires when the
 * existing row is `skipped` for a recoverable reason
 * (no_binding / outbound_disabled / webhook_inbound_unavailable).
 * `not_supported_in_v1` stays skipped — that requires a
 * binding_created_or_replaced event to re-open.
 */
export async function upsertTaskTransportProjection(
  executor: Executor,
  params: UpsertProjectionParams
): Promise<void> {
  await sql`
    INSERT INTO tool_call_task_transport_projections (
      task_id, workspace_id, conversation_id, status
    )
    VALUES (${params.taskId}, ${params.workspaceId}, ${params.conversationId}, 'pending')
    ON CONFLICT (task_id) DO UPDATE
      SET status = 'pending',
          next_attempt_at = NOW(),
          attempts = 0,
          error = NULL,
          transport_message_link_id = NULL
      WHERE tool_call_task_transport_projections.status = 'skipped'
        AND tool_call_task_transport_projections.error IN (
          'no_binding',
          'outbound_disabled',
          'webhook_inbound_unavailable'
        )
  `.execute(executor)
}
