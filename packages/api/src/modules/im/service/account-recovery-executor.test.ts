/**
 * Contract test for the AccountRecoveryAction execution-order
 * contract documented on `connectors/types.ts`. The connector hook
 * `planAccountRecoveryActions?()` may return actions in any order,
 * but the generic executor MUST run them in
 *   1) all `reEnableAutoDisabledBindings`
 *   2) all `recoverSkippedInteractionProjections`
 *   3) future types, preserving connector-returned relative order
 *
 * Why: projection recovery would otherwise immediately re-skip on
 * the `outbound_disabled` reason that re-enable lifts. Test guards
 * against an editor "tidying up" the executor's dispatch loop into a
 * single pass that loses the ordering invariant.
 *
 * `orderAccountRecoveryActions` is the pure ordering primitive; this
 * test asserts its behavior directly so the contract holds even if
 * the executor is refactored.
 */

import test from "node:test"
import assert from "node:assert/strict"
import type { AccountRecoveryAction } from "../connectors/types.js"
import { orderAccountRecoveryActions } from "./account-recovery-planner.js"

test("re-enable actions run before projection-recovery actions", () => {
  const actions: AccountRecoveryAction[] = [
    {
      type: "recoverSkippedInteractionProjections",
      eventKind: "account_status_activated",
    },
    {
      type: "reEnableAutoDisabledBindings",
      reason: "webhook_inbound_unavailable",
    },
    {
      type: "recoverSkippedInteractionProjections",
      eventKind: "config_webhook_confirmed",
    },
    {
      type: "reEnableAutoDisabledBindings",
      reason: "some_other_reason",
    },
  ]
  const ordered = orderAccountRecoveryActions(actions)
  // Every re-enable index must be strictly less than every recovery
  // index after the sort.
  const lastReEnableIdx = ordered.findLastIndex(
    (a) => a.type === "reEnableAutoDisabledBindings"
  )
  const firstRecoverIdx = ordered.findIndex(
    (a) => a.type === "recoverSkippedInteractionProjections"
  )
  assert.ok(
    lastReEnableIdx >= 0 && firstRecoverIdx >= 0,
    "both action types should remain present after ordering"
  )
  assert.ok(
    lastReEnableIdx < firstRecoverIdx,
    `expected all reEnableAutoDisabledBindings before any recoverSkippedInteractionProjections (got ${JSON.stringify(
      ordered.map((a) => a.type)
    )})`
  )
})

test("orderAccountRecoveryActions preserves intra-group relative order", () => {
  const actions: AccountRecoveryAction[] = [
    { type: "reEnableAutoDisabledBindings", reason: "r1" },
    { type: "reEnableAutoDisabledBindings", reason: "r2" },
    {
      type: "recoverSkippedInteractionProjections",
      eventKind: "account_status_activated",
    },
    {
      type: "recoverSkippedInteractionProjections",
      eventKind: "config_webhook_confirmed",
    },
  ]
  const ordered = orderAccountRecoveryActions(actions)
  assert.deepEqual(
    ordered.map((a) =>
      a.type === "reEnableAutoDisabledBindings"
        ? `re:${a.reason}`
        : `recover:${a.eventKind}`
    ),
    [
      "re:r1",
      "re:r2",
      "recover:account_status_activated",
      "recover:config_webhook_confirmed",
    ]
  )
})

test("orderAccountRecoveryActions is a no-op when only one group is present", () => {
  const onlyReEnable: AccountRecoveryAction[] = [
    { type: "reEnableAutoDisabledBindings", reason: "r1" },
    { type: "reEnableAutoDisabledBindings", reason: "r2" },
  ]
  assert.deepEqual(orderAccountRecoveryActions(onlyReEnable), onlyReEnable)
  const onlyRecover: AccountRecoveryAction[] = [
    {
      type: "recoverSkippedInteractionProjections",
      eventKind: "account_status_activated",
    },
  ]
  assert.deepEqual(orderAccountRecoveryActions(onlyRecover), onlyRecover)
})
