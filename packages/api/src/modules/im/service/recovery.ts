/**
 * Shared, transport-neutral recovery helpers used by the IM delivery
 * worker (binding-changed link marking) and the generic account
 * recovery dispatch loop (binding re-enable SQL).
 *
 * Scope:
 *   - Mark a stale link `skipped` with `metadata.skippedReason
 *     = "binding_changed"` (the worker's binding-mismatch branch).
 *   - Build a transport-neutral SQL that lifts `outbound_enabled = TRUE`
 *     for bindings whose `metadata.autoDisabledReason` matches a given
 *     marker (and atomically removes the marker).
 *   - Re-arm `tool_call_task_transport_projections` rows that were skipped
 *     for a now-resolvable reason (account/connection-mode/config
 *     transitions + binding-level events). The QQ merge-prep brought
 *     in the task projection table and these helpers; they're
 *     transport-neutral by row design — any connector that opts into
 *     task projection participates without further code here.
 *   - `canDeliverNow` + `recoverSkippedDisabledLink` for the outbox
 *     sweeper's gate-then-flip-then-enqueue dance.
 *   - `recoverProjectionForBindingChangedLink` for the delivery worker
 *     when current binding's (account, endpoint) no longer matches
 *     the link snapshot.
 *
 * The raw DB writes live in repo-recovery.ts (a repo file, which may
 * import the db client + sql); this file keeps the db-free orchestration
 * (`canDeliverNow`) and re-exports the repo helpers so existing importers
 * (accounts.ts, bindings.ts, the contract test, the outbox sweeper's
 * dynamic import) stay unchanged.
 */

import {
  getConversationTransportBinding,
  loadTransportMessageLinkForDelivery,
} from "../service.js"

export type {
  DbOrTx,
  SkipReason,
  SkippedRecoveryEvent,
  RecoverySummary,
} from "./repo-recovery.js"
export {
  markLinkSkipped,
  reEnableAutoDisabledBindings,
  buildReEnableAutoDisabledBindingsSql,
  recoverSkippedDisabledLink,
  recoverProjectionForBindingChangedLink,
  recoverSkippedProjectionsForRecoveryEvent,
} from "./repo-recovery.js"

// ─── Projection-aware recovery (tool_call_task_transport_projections) ───

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
 * Sweeper / per-link recovery checks this before flipping any
 * skipped→pending — without it the sweeper would just re-skip in a
 * tight loop.
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
  if (binding.account.status !== "active")
    return { ok: false, reason: "account_disabled" }
  if (!binding.outboundEnabled)
    return { ok: false, reason: "outbound_disabled" }
  if (
    binding.account.id !== link.transportAccountId ||
    binding.endpoint.id !== link.transportEndpointId
  )
    return { ok: false, reason: "endpoint_mismatch" }
  return { ok: true }
}
