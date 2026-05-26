/**
 * Recovery helpers (G5): respond to state-change events that make a
 * previously-skipped projection or link deliverable again. Triggered from
 * IM bindings/accounts mutation paths and from the outbox sweeper.
 *
 * Two ideas hold this module together:
 *
 *   1) **canDeliverNow(linkId)** — single predicate every recovery path
 *      consults before flipping a link `skipped → pending`. The check is
 *      "current binding still matches the link's account/endpoint AND
 *      account is active AND outbound is enabled". Without this predicate
 *      the sweeper would keep re-pending links that the delivery worker
 *      immediately re-skips, producing a hot loop.
 *
 *   2) **recoverProjectionForBindingChangedLink** — invoked from the
 *      delivery worker's binding-unavailable branch when the current
 *      binding's account/endpoint no longer matches the link. Old link
 *      goes terminal (`skippedReason='binding_changed' +
 *      replacedByProjectionRecovery=true`), the projection row is reset
 *      so the next projection-worker tick rebuilds token/item/link under
 *      the new binding. Same tx so projection-reset + link-terminal land
 *      together.
 *
 * The recovery helpers that turn account/binding state changes into
 * projection re-opens live in `interactions/recovery.ts` (their
 * responsibility is per-projection, not per-link).
 */

import { sql } from "kysely"
import {
  db,
  type DatabaseTransaction,
  type KyselyDb,
} from "../../../infrastructure/database/kysely.js"
import {
  getConversationTransportBinding,
  loadTransportMessageLinkForDelivery,
  removeTransportMessageLinkMetadataKey,
} from "../service.js"

type DbOrTx = KyselyDb | DatabaseTransaction

export type CanDeliverNowResult =
  | { ok: true }
  | {
      ok: false
      reason:
        | "link_not_found"
        | "binding_missing"
        | "account_disabled"
        | "outbound_disabled"
        | "endpoint_mismatch"
    }

/**
 * Is the link's intended (account, endpoint) still the conversation's
 * current binding, and is that binding actually deliverable?
 *
 * Used by:
 *   - the outbox sweeper to gate skipped→pending flips for
 *     binding_disabled/account_disabled links
 *   - the binding/account recovery helpers below as a final guard
 *     before re-opening a projection
 */
export async function canDeliverNow(
  linkId: string
): Promise<CanDeliverNowResult> {
  const link = await loadTransportMessageLinkForDelivery(linkId)
  if (!link) return { ok: false, reason: "link_not_found" }
  const binding = await getConversationTransportBinding({
    workspaceId: link.workspaceId,
    conversationId: link.conversationId,
  })
  if (!binding) return { ok: false, reason: "binding_missing" }
  if (binding.account.status !== "active") {
    return { ok: false, reason: "account_disabled" }
  }
  if (!binding.outboundEnabled) {
    return { ok: false, reason: "outbound_disabled" }
  }
  if (
    binding.account.id !== link.transportAccountId ||
    binding.endpoint.id !== link.transportEndpointId
  ) {
    return { ok: false, reason: "endpoint_mismatch" }
  }
  return { ok: true }
}

/**
 * Recover a `skipped` link with `skippedReason` in
 * `('binding_disabled','account_disabled')` whose current binding now
 * passes `canDeliverNow`. Flips delivery_status back to `pending` and
 * drops the `skippedReason` marker so the sweeper won't keep
 * re-processing it. Does NOT enqueue a job — the sweeper calls
 * `enqueueOrRetryTransportDeliveryLink` after this returns.
 *
 * Callers must call `canDeliverNow(linkId)` first; this helper does NOT
 * re-verify (sweeper already did, and we want this to be a tight
 * commit-then-enqueue pair).
 */
export async function recoverSkippedDisabledLink(
  linkId: string
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("transport_message_links")
      .set({
        delivery_status: "pending",
        updated_at: sql`NOW()`,
      })
      .where("id", "=", linkId)
      .where("delivery_status", "=", "skipped")
      .execute()
    await removeTransportMessageLinkMetadataKey(tx, linkId, "skippedReason")
  })
}

/**
 * The delivery worker calls this from its binding-unavailable branch when
 * the current binding's account/endpoint no longer matches the link
 * (i.e. the conversation binding was replaced). Three things happen
 * atomically:
 *
 *   1. Any `interaction_transport_projections` row that points at this
 *      link is reset (status='pending', transport_message_link_id=NULL,
 *      attempts=0, ...) so the projection worker rebuilds token + item +
 *      link under the new binding.
 *   2. The old link is marked terminal: `delivery_status='skipped'`,
 *      `metadata.skippedReason='binding_changed'`, and
 *      `metadata.replacedByProjectionRecovery=true` (an audit signal so
 *      the sweeper knows this is not retryable).
 *   3. No enqueue — the projection worker's next tick will pick up the
 *      reset row and produce a fresh link/job.
 *
 * If no projection row references this link, only step 2 runs. Either
 * way the function is idempotent.
 *
 * `exec` lets the caller (delivery worker, in its outer try/catch)
 * pass an existing tx; if omitted we open our own.
 */
export async function recoverProjectionForBindingChangedLink(
  linkId: string,
  exec?: DbOrTx
): Promise<void> {
  const run = async (tx: DbOrTx) => {
    // Step 1: reset any projection pinned to this link. The table only
    // lives if interactions/recovery has been wired up (G5 / Stage 8);
    // tolerate missing-table on early deploys by catching FK-shaped
    // errors at the caller boundary.
    await sql`
      UPDATE interaction_transport_projections
      SET status = 'pending',
          transport_message_link_id = NULL,
          error = NULL,
          next_attempt_at = NOW(),
          attempts = 0,
          updated_at = NOW()
      WHERE transport_message_link_id = ${linkId}
        AND status = 'projected'
    `.execute(tx)

    // Step 2: terminalize the old link. Use raw SQL for the jsonb merge
    // so Kysely's typed Updateable<JsonValue> column doesn't fight us.
    await sql`
      UPDATE transport_message_links
      SET delivery_status = 'skipped',
          metadata = metadata || ${JSON.stringify({
            skippedReason: "binding_changed",
            replacedByProjectionRecovery: true,
          })}::jsonb,
          updated_at = NOW()
      WHERE id = ${linkId}
    `.execute(tx)
  }
  if (exec) {
    await run(exec)
  } else {
    await db.transaction().execute(run)
  }
}
