/**
 * Pure helpers for the account-update recovery flow. Both functions are
 * extracted from `accounts.ts updateTransportAccount` so the decision
 * logic (which transitions trigger which recovery actions) and the
 * binding-selection predicate (which auto-disabled bindings should be
 * re-enabled) can be unit-tested without a live database.
 *
 * The actual side-effects — the SQL UPDATE that flips outbound_enabled
 * and the call into `recoverSkippedProjectionsForRecoveryEvent` — live
 * in `accounts.ts`; this module just decides WHAT to do.
 */

import type { TransportKind } from "@synapse/shared/types"

export type AccountUpdateRecoveryAction =
  | { kind: "account_status_activated" }
  | {
      kind: "connection_mode_changed_to_long_connection"
      reEnableAutoDisabledBindings: true
    }
  | {
      kind: "config_webhook_confirmed"
      reEnableAutoDisabledBindings: true
    }

export interface PlanRecoveryActionsInput {
  transportKind: TransportKind
  previousStatus: string | undefined
  nextStatus: string
  previousConnectionMode: string | undefined
  nextConnectionMode: string
  /**
   * The config object the caller passed in (or undefined if they didn't
   * include `config` in their update). NOT the existing stored config —
   * we only fire the `config_webhook_confirmed` action when the caller
   * explicitly set the flag in this PUT, otherwise a status-only update
   * would re-trigger recovery every time.
   */
  incomingConfig: Record<string, unknown> | undefined
  /** The existing row's stored config (always defined; may be {}). */
  previousConfig: Record<string, unknown>
}

/**
 * Decide which recovery actions an account update should trigger.
 * Ordering is meaningful: `reEnableAutoDisabledBindings` actions return
 * BEFORE the matching projection-rearm, so the caller (accounts.ts) can
 * flip the bindings to `outbound_enabled = true` first — otherwise the
 * re-armed projection would just skip again with `outbound_disabled`.
 */
export function planAccountUpdateRecoveryActions(
  input: PlanRecoveryActionsInput
): AccountUpdateRecoveryAction[] {
  const actions: AccountUpdateRecoveryAction[] = []
  const wasActive = input.previousStatus === "active"
  const isNowActive = input.nextStatus === "active"
  if (!wasActive && isNowActive) {
    actions.push({ kind: "account_status_activated" })
  }
  if (
    input.previousConnectionMode === "webhook" &&
    input.nextConnectionMode === "long_connection"
  ) {
    actions.push({
      kind: "connection_mode_changed_to_long_connection",
      reEnableAutoDisabledBindings: true,
    })
  }
  if (
    input.transportKind === "qq" &&
    input.nextConnectionMode === "webhook" &&
    input.incomingConfig !== undefined
  ) {
    const wasConfirmed = input.previousConfig.webhookInboundConfirmed === true
    const isNowConfirmed = input.incomingConfig.webhookInboundConfirmed === true
    if (!wasConfirmed && isNowConfirmed) {
      actions.push({
        kind: "config_webhook_confirmed",
        reEnableAutoDisabledBindings: true,
      })
    }
  }
  return actions
}

/**
 * Predicate-as-data view of which auto-disabled bindings get re-enabled.
 * The SQL UPDATE in `accounts.ts` mirrors this predicate exactly; the
 * test suite exercises this function against synthetic rows so a future
 * refactor can't change the WHERE clause without also changing the
 * predicate and tripping the tests.
 */
export interface AutoDisabledBindingCandidate {
  id: string
  transportAccountId: string
  outboundEnabled: boolean
  metadata: Record<string, unknown>
}

export function shouldReEnableAutoDisabledBinding(
  binding: AutoDisabledBindingCandidate,
  transportAccountId: string
): boolean {
  if (binding.transportAccountId !== transportAccountId) return false
  if (binding.outboundEnabled !== false) return false
  return binding.metadata?.autoDisabledReason === "webhook_inbound_unavailable"
}
