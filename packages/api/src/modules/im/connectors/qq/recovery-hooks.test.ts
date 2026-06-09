/**
 * Tests for the QQ connector's `planAccountRecoveryActions?()` hook.
 *
 * The hook is the QQ-specific replacement for the old
 * `planAccountUpdateRecoveryActions(...)` pure planner — the
 * generic `service/accounts.ts` executor now consults this hook
 * via the shared `account-recovery-planner.ts` dispatcher.
 *
 * Covers the recovery transitions the QQ branch originally
 * specified:
 *   - account_status_activated (status flip → re-arm projections)
 *   - connection_mode_changed_to_long_connection (re-enable bindings
 *     + re-arm projections)
 *   - config_webhook_confirmed (operator confirmed OQ2 — re-enable
 *     auto-disabled bindings AND re-arm projections)
 *
 * Tests are pure: register the QQ connector via the shared
 * `register-all` side-effect import, then call the hook directly.
 * No DB.
 */

import test from "node:test"
import assert from "node:assert/strict"
import type { TransportAccountSummary } from "@synapse/shared/types"
import "../register-all.js"
import { tryGetConnector } from "../registry.js"

function summary(
  overrides: Partial<TransportAccountSummary> = {}
): TransportAccountSummary {
  return {
    id: "acc-1",
    workspaceId: "ws-1",
    transportKind: "qq",
    accountKey: "qq-1",
    displayName: "QQ Bot",
    ownerScope: "workspace",
    inboundActorMode: "none",
    connectionMode: "long_connection",
    status: "active",
    credentials: {},
    config: {},
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as TransportAccountSummary
}

test("qq.planAccountRecoveryActions: status disabled→active emits projection re-arm", () => {
  const qq = tryGetConnector("qq")
  assert.ok(
    qq?.planAccountRecoveryActions,
    "qq connector must implement the hook"
  )
  const actions = qq!.planAccountRecoveryActions!({
    previous: summary({ status: "disabled" }),
    next: summary({ status: "active" }),
  })
  assert.deepEqual(
    actions.map((a) => a.type),
    ["recoverSkippedTaskProjections"]
  )
  const recover = actions[0] as { eventKind: string }
  assert.equal(recover.eventKind, "account_status_activated")
})

test("qq.planAccountRecoveryActions: webhook→long_connection re-enables bindings and re-arms projections", () => {
  const qq = tryGetConnector("qq")!
  const actions = qq.planAccountRecoveryActions!({
    previous: summary({ connectionMode: "webhook" }),
    next: summary({ connectionMode: "long_connection" }),
  })
  // Order matters — see AccountRecoveryAction execution-order
  // contract: re-enable bindings before recovery so the recovered
  // projection doesn't immediately re-skip on outbound_disabled.
  assert.deepEqual(
    actions.map((a) => a.type),
    ["reEnableAutoDisabledBindings", "recoverSkippedTaskProjections"]
  )
  const reEnable = actions[0] as { reason: string }
  const recover = actions[1] as { eventKind: string }
  // The re-enable `reason` MUST match the marker written by
  // `getBindingDefaults` (else the marker-based SQL has nothing
  // to find).
  assert.equal(reEnable.reason, "webhook_inbound_unavailable")
  // Plan spec: "connection_mode_changed_to_long_connection" event kind.
  assert.equal(recover.eventKind, "connection_mode_changed_to_long_connection")
})

test("qq.planAccountRecoveryActions: config_webhook_confirmed only fires when incomingConfig declares the flag", () => {
  const qq = tryGetConnector("qq")!
  // No incomingConfig → no confirm action.
  assert.deepEqual(
    qq.planAccountRecoveryActions!({
      previous: summary(),
      next: summary(),
      incomingConfig: undefined,
    }).map((a) => a.type),
    []
  )
  // incomingConfig with the flag → both re-enable + recover.
  const actions = qq.planAccountRecoveryActions!({
    previous: summary(),
    next: summary(),
    incomingConfig: { webhookInboundConfirmed: true },
  })
  assert.deepEqual(
    actions.map((a) => a.type),
    ["reEnableAutoDisabledBindings", "recoverSkippedTaskProjections"]
  )
  const recover = actions[1] as { eventKind: string }
  assert.equal(recover.eventKind, "config_webhook_confirmed")
})

test("qq.getTaskProjectionReadiness: long_connection always ready", () => {
  const qq = tryGetConnector("qq")!
  assert.deepEqual(
    qq.getTaskProjectionReadiness!(
      summary({ connectionMode: "long_connection" })
    ),
    { ok: true }
  )
})

test("qq.getTaskProjectionReadiness: webhook + unconfirmed blocks with stable reason", () => {
  const qq = tryGetConnector("qq")!
  const res = qq.getTaskProjectionReadiness!(
    summary({ connectionMode: "webhook", config: {} })
  )
  assert.deepEqual(res, {
    ok: false,
    reason: "webhook_inbound_unavailable",
  })
})

test("qq.getTaskProjectionReadiness: webhook + confirmed is ready", () => {
  const qq = tryGetConnector("qq")!
  const res = qq.getTaskProjectionReadiness!(
    summary({
      connectionMode: "webhook",
      config: { webhookInboundConfirmed: true },
    })
  )
  assert.deepEqual(res, { ok: true })
})

test("qq.getBindingDefaults: webhook + unconfirmed defaults outbound off with marker", () => {
  const qq = tryGetConnector("qq")!
  const res = qq.getBindingDefaults!({
    account: summary({ connectionMode: "webhook", config: {} }),
    endpoint: { endpointType: "group", externalId: "g-1" },
  })
  assert.equal(res.outboundEnabled, false)
  assert.deepEqual(res.metadata, {
    autoDisabledReason: "webhook_inbound_unavailable",
  })
})

test("qq.getBindingDefaults: webhook + confirmed leaves outbound on", () => {
  const qq = tryGetConnector("qq")!
  const res = qq.getBindingDefaults!({
    account: summary({
      connectionMode: "webhook",
      config: { webhookInboundConfirmed: true },
    }),
    endpoint: { endpointType: "group", externalId: "g-1" },
  })
  assert.equal(res.outboundEnabled, true)
})

test("qq.getBindingDefaults: long_connection leaves outbound on", () => {
  const qq = tryGetConnector("qq")!
  const res = qq.getBindingDefaults!({
    account: summary({ connectionMode: "long_connection" }),
    endpoint: { endpointType: "direct", externalId: "u-1" },
  })
  assert.equal(res.outboundEnabled, true)
})
