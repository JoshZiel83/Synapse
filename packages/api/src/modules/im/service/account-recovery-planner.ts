/**
 * Generic dispatcher for connector-supplied account recovery actions.
 *
 * Collects `AccountRecoveryAction[]` from the connector's
 * `planAccountRecoveryActions?()` hook for a (previous, next) account
 * snapshot pair. The generic `updateTransportAccount` executor then
 * runs them under §AccountRecoveryAction's order contract.
 *
 * Kept DB-free so the test suite can exercise the action shape
 * without booting a pg.Pool.
 */

import type {
  AccountRecoveryAction,
  TransportConnector,
} from "../connectors/types.js"
import type { TransportAccountSummary } from "@synapse/shared/types"
import { tryGetConnector } from "../connectors/registry.js"

export interface AccountRecoveryPlanInput {
  previous: TransportAccountSummary
  next: TransportAccountSummary
  /**
   * Literal `config` argument from the update call. Undefined when
   * the caller did not touch config. Connectors use this (NOT a diff
   * of previous/next) to detect "config was accepted in this very
   * request" — preventing spurious re-fire on unrelated status updates.
   */
  incomingConfig?: Record<string, unknown>
}

export function planAccountRecoveryActions(
  input: AccountRecoveryPlanInput
): AccountRecoveryAction[] {
  return planActionsFor(tryGetConnector(input.next.transportKind), input)
}

/**
 * Same as `planAccountRecoveryActions` but accepts an explicit
 * connector reference — handy for tests that bypass the global
 * registry.
 */
export function planActionsFor(
  connector: TransportConnector | undefined,
  input: AccountRecoveryPlanInput
): AccountRecoveryAction[] {
  if (!connector?.planAccountRecoveryActions) return []
  return connector.planAccountRecoveryActions(input)
}

/**
 * Order the collected actions per the execution-order contract on
 * {@link AccountRecoveryAction}: all `reEnableAutoDisabledBindings`
 * first, then all `recoverSkippedTaskProjections`. Anything
 * else (future action types) lands after, in the order returned by
 * the connector, so adding a new type doesn't accidentally re-order
 * the two well-known ones.
 *
 * Stable sort by group only — within a group, order is preserved.
 */
export function orderAccountRecoveryActions(
  actions: AccountRecoveryAction[]
): AccountRecoveryAction[] {
  const reEnable: AccountRecoveryAction[] = []
  const recover: AccountRecoveryAction[] = []
  const other: AccountRecoveryAction[] = []
  for (const a of actions) {
    if (a.type === "reEnableAutoDisabledBindings") reEnable.push(a)
    else if (a.type === "recoverSkippedTaskProjections") recover.push(a)
    else other.push(a)
  }
  return [...reEnable, ...recover, ...other]
}
