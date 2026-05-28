/**
 * Shared, transport-neutral recovery helpers used by the IM delivery
 * worker (binding-changed link marking) and the generic account
 * recovery dispatch loop (binding re-enable SQL).
 *
 * Scope on shared prep:
 *   - Mark a stale link `skipped` with `metadata.skippedReason
 *     = "binding_changed"` (the worker's binding-mismatch branch).
 *   - Build a transport-neutral SQL that lifts `outbound_enabled = TRUE`
 *     for bindings whose `metadata.autoDisabledReason` matches a given
 *     marker (and atomically removes the marker).
 *
 * Out of scope on shared prep:
 *   - Anything that touches `interaction_transport_projections`
 *     (table introduced by QQ merge-prep). The QQ branch's
 *     `recoverSkippedProjectionsForRecoveryEvent` etc lands later and
 *     extends these helpers with projection reset inside the same
 *     transaction.
 */

import { sql } from "kysely"
import type { DatabaseTransaction } from "../../../infrastructure/database/kysely.js"
import {
  db,
  type TableUpdate,
} from "../../../infrastructure/database/kysely.js"

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
    .updateTable("transport_message_links")
    .set({
      delivery_status: "skipped",
      // jsonb merge with the existing metadata so we don't clobber
      // delivery.* / per-connector fields. Postgres `||` does a
      // SHALLOW merge — the top-level `skippedReason` key is what
      // the sweeper / recovery match on, so a shallow merge is the
      // right tool here.
      metadata:
        sql`metadata || ${JSON.stringify({ skippedReason: params.reason })}::jsonb` as unknown as TableUpdate<"transport_message_links">["metadata"],
      updated_at: sql`NOW()`,
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
 *  - `updated_at = NOW()`
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
    .updateTable("conversation_transport_bindings")
    .set({
      outbound_enabled: true,
      metadata:
        sql`metadata - 'autoDisabledReason'` as unknown as TableUpdate<"conversation_transport_bindings">["metadata"],
      updated_at: sql`NOW()`,
    })
    .where("workspace_id", "=", params.workspaceId)
    .where(
      sql`(metadata->>'autoDisabledReason') IS NOT DISTINCT FROM ${params.reason}` as unknown as never
    )
    .compile()
}
