/**
 * IM recovery repo — owns the raw DB writes/queries for the
 * transport-neutral recovery helpers (link skip marking, binding
 * re-enable SQL, projection re-arm). Lives in a repo file (`repo-*.ts`
 * matches the guard's isRepo glob) so it may legitimately import the db
 * client + the `sql` tag.
 *
 * The business facade stays in recovery.ts, which re-exports everything
 * here so existing importers (accounts.ts, bindings.ts, the contract
 * test, the outbox sweeper's dynamic import) keep working unchanged.
 */

import { sql } from "kysely"
import type {
  DatabaseTransaction,
  KyselyDb,
} from "../../../infrastructure/database/kysely.js"
import { db } from "../../../infrastructure/database/kysely.js"
import type {
  TransportMessageLinkMetadataUpdate,
  ConversationTransportBindingMetadataUpdate,
  ConversationTransportBindingUpdatedAtUpdate,
} from "../repo.types.js"

export type DbOrTx = KyselyDb | DatabaseTransaction

export type SkipReason = "binding_changed" | (string & {})

/**
 * Mark a transport_message_link as `skipped` with a stable
 * `metadata.skippedReason`. Sweeper and account/binding recovery code
 * scan this top-level key (`metadata->>'skippedReason'`) — do NOT
 * write under `metadata.delivery.*` for skipReason, that namespace is
 * reserved for ambiguity / sweeper retry counters etc.
 *
 * Accepts an optional `tx` so callers can compose with other writes
 * in the same transaction (binding mutation, projection reset).
 */
export async function markLinkSkipped(params: {
  linkId: string
  reason: SkipReason
  tx?: DatabaseTransaction
}): Promise<void> {
  const exec = params.tx ?? db
  await exec
    .updateTable("transportMessageLinks")
    .set({
      deliveryStatus: "skipped",
      // jsonb merge with the existing metadata so we don't clobber
      // delivery.* / per-connector fields. Postgres `||` does a
      // SHALLOW merge — the top-level `skippedReason` key is what
      // the sweeper / recovery match on, so a shallow merge is the
      // right tool here.
      metadata:
        sql`metadata || ${JSON.stringify({ skippedReason: params.reason })}::jsonb` as unknown as TransportMessageLinkMetadataUpdate,
    })
    .where("id", "=", params.linkId)
    .execute()
}

/**
 * Atomically re-enable every binding in `workspaceId` that was
 * auto-disabled under `reason` (matched against
 * `metadata->>'autoDisabledReason'`) AND remove the marker so the
 * binding can't be redundantly re-enabled in the future.
 *
 * Generic helper — connector-agnostic. The `reason` string is the
 * connector's own marker (e.g. QQ writes `webhook_inbound_unavailable`
 * via `getBindingDefaults?()`). Multiple connectors can use the same
 * marker without conflict; the WHERE clause is per-workspace.
 *
 * SQL contract (asserted by `accounts.re-enable-bindings.test.ts`):
 *  - `outbound_enabled = TRUE`
 *  - `metadata = metadata - 'autoDisabledReason'`
 *  - filter: workspace_id = $1 AND metadata->>'autoDisabledReason' = $2
 */
export async function reEnableAutoDisabledBindings(params: {
  workspaceId: string
  reason: string
  tx?: DatabaseTransaction
}): Promise<{ updated: number }> {
  const exec = params.tx ?? db
  const compiled = buildReEnableAutoDisabledBindingsSql(params)
  const result = await exec.executeQuery(compiled)
  // pg's RowDescription doesn't carry an UPDATE row count, but
  // node-postgres surfaces it as `rowCount` on the wrapped result.
  // Kysely's `executeQuery` returns the same shape via `result.rows`
  // + a `numAffectedRows` field. Either may be undefined under
  // alternate dialects — coalesce to 0 to keep the function total.
  const affected = (result as unknown as { numAffectedRows?: bigint | number })
    .numAffectedRows
  return {
    updated:
      typeof affected === "bigint" ? Number(affected) : Number(affected ?? 0),
  }
}

/**
 * Pure SQL builder for the re-enable UPDATE — exposed so the
 * contract test can assert the SQL shape (column updates + WHERE
 * clause) without booting Postgres.
 */
export function buildReEnableAutoDisabledBindingsSql(params: {
  workspaceId: string
  reason: string
}) {
  return db
    .updateTable("conversationTransportBindings")
    .set({
      outboundEnabled: true,
      updatedAt:
        sql`NOW()` as unknown as ConversationTransportBindingUpdatedAtUpdate,
      metadata:
        sql`metadata - 'autoDisabledReason'` as unknown as ConversationTransportBindingMetadataUpdate,
    })
    .where("workspaceId", "=", params.workspaceId)
    .where(
      sql`(metadata->>'autoDisabledReason') IS NOT DISTINCT FROM ${params.reason}` as unknown as never
    )
    .compile()
}

/**
 * Flip a `skipped` link back to `pending` (sweeper's flip step). Drops
 * the `skippedReason` marker so the sweeper doesn't re-pick the same
 * row. Callers MUST run `canDeliverNow(linkId)` first; this helper
 * does not re-verify.
 */
export async function recoverSkippedDisabledLink(
  linkId: string,
  exec: DbOrTx = db
): Promise<void> {
  await exec
    .updateTable("transportMessageLinks")
    .set({
      deliveryStatus: "pending",
      metadata:
        sql`metadata - 'skippedReason'` as unknown as TransportMessageLinkMetadataUpdate,
    })
    .where("id", "=", linkId)
    .where("deliveryStatus", "=", "skipped")
    .execute()
}

/**
 * Called from the delivery worker's binding-mismatch branch when the
 * current binding has been replaced. Resets any
 * `tool_call_task_transport_projections` row that points at this link AND
 * terminalizes the old link with
 * `metadata.replacedByProjectionRecovery=true` so the sweeper knows
 * this isn't retryable. Same tx by default.
 */
export async function recoverProjectionForBindingChangedLink(
  linkId: string,
  exec?: DbOrTx
): Promise<void> {
  const run = async (tx: DbOrTx) => {
    await sql`
      UPDATE tool_call_task_transport_projections
      SET status = 'pending',
          transport_message_link_id = NULL,
          error = NULL,
          next_attempt_at = NOW(),
          attempts = 0
      WHERE transport_message_link_id = ${linkId}
        AND status = 'projected'
    `.execute(tx)
    await sql`
      UPDATE transport_message_links
      SET delivery_status = 'skipped',
          metadata = metadata || ${JSON.stringify({
            skippedReason: "binding_changed",
            replacedByProjectionRecovery: true,
          })}::jsonb
      WHERE id = ${linkId}
    `.execute(tx)
  }
  if (exec) await run(exec)
  else await db.transaction().execute(run)
}

/**
 * The closed-enum recovery events that account/binding mutation paths
 * trigger. Mapping → re-armable reasons in `reasonsForEvent`. Never
 * re-arm `not_supported_in_v1` from anything other than
 * `binding_created_or_replaced` (the new binding may satisfy
 * supportsInteractionPrompt where the old one didn't), and never
 * re-arm `task_already_resolved_or_expired` (that's terminal).
 */
export type SkippedRecoveryEvent =
  | { kind: "config_webhook_confirmed"; transportAccountId: string }
  | {
      kind: "connection_mode_changed_to_long_connection"
      transportAccountId: string
    }
  | { kind: "account_status_activated"; transportAccountId: string }
  | {
      kind: "outbound_re_enabled"
      transportAccountId: string
      transportEndpointId: string
    }
  | {
      kind: "binding_created_or_replaced"
      conversationId: string
      transportAccountId: string
      transportEndpointId: string
    }

export interface RecoverySummary {
  rearmedProjections: number
}

/**
 * Re-arm skipped projection rows in response to a state-change event.
 * Kysely-tx flavored (`exec` is the top-level db or a transaction).
 */
export async function recoverSkippedProjectionsForRecoveryEvent(
  exec: DbOrTx,
  event: SkippedRecoveryEvent
): Promise<RecoverySummary> {
  const reasons = reasonsForEvent(event.kind)
  switch (event.kind) {
    case "config_webhook_confirmed":
    case "connection_mode_changed_to_long_connection":
    case "account_status_activated": {
      const result = await sql<{ id: string }>`
        UPDATE tool_call_task_transport_projections p
        SET status = 'pending',
            next_attempt_at = NOW(),
            attempts = 0,
            error = NULL,
            transport_message_link_id = NULL
        FROM conversation_transport_bindings ctb
        WHERE ctb.conversation_id = p.conversation_id
          AND ctb.transport_account_id = ${event.transportAccountId}
          AND p.status = 'skipped'
          AND p.error = ANY (${reasons}::text[])
        RETURNING p.id
      `.execute(exec)
      return { rearmedProjections: result.rows.length }
    }
    case "outbound_re_enabled": {
      const result = await sql<{ id: string }>`
        UPDATE tool_call_task_transport_projections p
        SET status = 'pending',
            next_attempt_at = NOW(),
            attempts = 0,
            error = NULL,
            transport_message_link_id = NULL
        FROM conversation_transport_bindings ctb
        WHERE ctb.conversation_id = p.conversation_id
          AND ctb.transport_account_id = ${event.transportAccountId}
          AND ctb.transport_endpoint_id = ${event.transportEndpointId}
          AND p.status = 'skipped'
          AND p.error = ANY (${reasons}::text[])
        RETURNING p.id
      `.execute(exec)
      return { rearmedProjections: result.rows.length }
    }
    case "binding_created_or_replaced": {
      const result = await sql<{ id: string }>`
        UPDATE tool_call_task_transport_projections p
        SET status = 'pending',
            next_attempt_at = NOW(),
            attempts = 0,
            error = NULL,
            transport_message_link_id = NULL
        WHERE p.conversation_id = ${event.conversationId}
          AND p.status = 'skipped'
          AND p.error = ANY (${reasons}::text[])
        RETURNING p.id
      `.execute(exec)
      return { rearmedProjections: result.rows.length }
    }
  }
}

function reasonsForEvent(kind: SkippedRecoveryEvent["kind"]): string[] {
  const base = [
    "no_binding",
    "outbound_disabled",
    "webhook_inbound_unavailable",
  ]
  return kind === "binding_created_or_replaced"
    ? [...base, "not_supported_in_v1"]
    : base
}
