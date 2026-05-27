import test from "node:test"
import assert from "node:assert/strict"
import {
  planAccountUpdateRecoveryActions,
  shouldReEnableAutoDisabledBinding,
} from "./account-recovery-planner.js"

// ─────────────────────────────────────────────────────────────────────
// planAccountUpdateRecoveryActions: which transitions fire which
// recovery action. These tests lock in the contract surfaced from
// accounts.ts updateTransportAccount.
// ─────────────────────────────────────────────────────────────────────

test("planner: no transitions → no actions", () => {
  const actions = planAccountUpdateRecoveryActions({
    transportKind: "qq",
    previousStatus: "active",
    nextStatus: "active",
    previousConnectionMode: "long_connection",
    nextConnectionMode: "long_connection",
    incomingConfig: undefined,
    previousConfig: {},
  })
  assert.deepEqual(actions, [])
})

test("planner: status disabled→active → account_status_activated", () => {
  const actions = planAccountUpdateRecoveryActions({
    transportKind: "feishu",
    previousStatus: "disabled",
    nextStatus: "active",
    previousConnectionMode: "webhook",
    nextConnectionMode: "webhook",
    incomingConfig: undefined,
    previousConfig: {},
  })
  assert.equal(actions.length, 1)
  assert.equal(actions[0]!.kind, "account_status_activated")
})

test("planner: status active→active is a no-op even if other fields change", () => {
  // Regression: spurious recovery on every PUT would re-spam the
  // dashboard with old approval prompts.
  const actions = planAccountUpdateRecoveryActions({
    transportKind: "qq",
    previousStatus: "active",
    nextStatus: "active",
    previousConnectionMode: "long_connection",
    nextConnectionMode: "long_connection",
    incomingConfig: { allowProactiveBestEffort: true },
    previousConfig: {},
  })
  assert.deepEqual(actions, [])
})

test("planner: webhook→long_connection sets reEnableAutoDisabledBindings", () => {
  // CRITICAL: this flag is what tells the caller to flip the bindings
  // BEFORE running the projection re-arm. Without it, the re-armed
  // projection would just skip again with `outbound_disabled`.
  const actions = planAccountUpdateRecoveryActions({
    transportKind: "qq",
    previousStatus: "active",
    nextStatus: "active",
    previousConnectionMode: "webhook",
    nextConnectionMode: "long_connection",
    incomingConfig: undefined,
    previousConfig: {},
  })
  assert.equal(actions.length, 1)
  assert.deepEqual(actions[0], {
    kind: "connection_mode_changed_to_long_connection",
    reEnableAutoDisabledBindings: true,
  })
})

test("planner: long_connection→webhook does NOT fire recovery", () => {
  // The reverse transition isn't a "recovery"; it's a new gate. Caller
  // should leave existing approvals alone.
  const actions = planAccountUpdateRecoveryActions({
    transportKind: "qq",
    previousStatus: "active",
    nextStatus: "active",
    previousConnectionMode: "long_connection",
    nextConnectionMode: "webhook",
    incomingConfig: { webhookInboundConfirmed: false },
    previousConfig: {},
  })
  assert.deepEqual(actions, [])
})

test("planner: QQ webhookInboundConfirmed false→true → config_webhook_confirmed w/ binding-reenable", () => {
  const actions = planAccountUpdateRecoveryActions({
    transportKind: "qq",
    previousStatus: "active",
    nextStatus: "active",
    previousConnectionMode: "webhook",
    nextConnectionMode: "webhook",
    incomingConfig: { webhookInboundConfirmed: true },
    previousConfig: { webhookInboundConfirmed: false },
  })
  assert.equal(actions.length, 1)
  assert.deepEqual(actions[0], {
    kind: "config_webhook_confirmed",
    reEnableAutoDisabledBindings: true,
  })
})

test("planner: re-PUT of webhookInboundConfirmed=true with same prior value is a no-op", () => {
  // Spurious-fire guard: PUT with same value MUST NOT re-run recovery,
  // otherwise the operator can't safely re-PATCH unrelated fields.
  const actions = planAccountUpdateRecoveryActions({
    transportKind: "qq",
    previousStatus: "active",
    nextStatus: "active",
    previousConnectionMode: "webhook",
    nextConnectionMode: "webhook",
    incomingConfig: { webhookInboundConfirmed: true },
    previousConfig: { webhookInboundConfirmed: true },
  })
  assert.deepEqual(actions, [])
})

test("planner: webhookInboundConfirmed flip needs incomingConfig to be set explicitly", () => {
  // The flag is only checked when the caller sent a `config` field. A
  // status-only PUT must not retroactively flip the gate.
  const actions = planAccountUpdateRecoveryActions({
    transportKind: "qq",
    previousStatus: "active",
    nextStatus: "active",
    previousConnectionMode: "webhook",
    nextConnectionMode: "webhook",
    incomingConfig: undefined,
    previousConfig: { webhookInboundConfirmed: false },
  })
  assert.deepEqual(actions, [])
})

test("planner: non-QQ transports never get config_webhook_confirmed even with the flag", () => {
  const actions = planAccountUpdateRecoveryActions({
    transportKind: "feishu",
    previousStatus: "active",
    nextStatus: "active",
    previousConnectionMode: "webhook",
    nextConnectionMode: "webhook",
    incomingConfig: { webhookInboundConfirmed: true },
    previousConfig: { webhookInboundConfirmed: false },
  })
  assert.deepEqual(actions, [])
})

test("planner: status + connection mode + confirm flip combine in order", () => {
  // When several transitions land in one PUT, the order matters
  // because the caller applies them sequentially and the
  // binding-reenable actions must precede the same-kind projection
  // rearm. account_status_activated comes first because it has no
  // binding-flip dependency.
  const actions = planAccountUpdateRecoveryActions({
    transportKind: "qq",
    previousStatus: "disabled",
    nextStatus: "active",
    previousConnectionMode: "webhook",
    nextConnectionMode: "long_connection",
    incomingConfig: { webhookInboundConfirmed: true },
    previousConfig: { webhookInboundConfirmed: false },
  })
  // Note: once we're long_connection the webhook-confirmed flip
  // doesn't fire (the `nextConnectionMode === "webhook"` gate inside
  // the planner blocks it). The combined PUT therefore produces two
  // actions: status flip + mode flip.
  assert.equal(actions.length, 2)
  assert.equal(actions[0]!.kind, "account_status_activated")
  assert.equal(actions[1]!.kind, "connection_mode_changed_to_long_connection")
})

// ─────────────────────────────────────────────────────────────────────
// shouldReEnableAutoDisabledBinding: which binding rows the SQL UPDATE
// will pick up. Mirrors the WHERE clause in
// reEnableAutoDisabledQqWebhookBindings.
// ─────────────────────────────────────────────────────────────────────

test("binding predicate: system-auto-disabled binding under target account → reopen", () => {
  assert.equal(
    shouldReEnableAutoDisabledBinding(
      {
        id: "b1",
        transportAccountId: "acc-target",
        outboundEnabled: false,
        metadata: { autoDisabledReason: "webhook_inbound_unavailable" },
      },
      "acc-target"
    ),
    true
  )
})

test("binding predicate: user-manually-disabled binding (no marker) is NOT reopened", () => {
  // Plan §G5 "autoDisabledReason 全生命周期" rule: only system
  // auto-disabled bindings get auto-reopened. User manually flipped
  // outbound off → marker absent → leave it alone.
  assert.equal(
    shouldReEnableAutoDisabledBinding(
      {
        id: "b2",
        transportAccountId: "acc-target",
        outboundEnabled: false,
        metadata: {},
      },
      "acc-target"
    ),
    false
  )
})

test("binding predicate: marker present but outbound already true → skip (idempotent)", () => {
  assert.equal(
    shouldReEnableAutoDisabledBinding(
      {
        id: "b3",
        transportAccountId: "acc-target",
        outboundEnabled: true,
        metadata: { autoDisabledReason: "webhook_inbound_unavailable" },
      },
      "acc-target"
    ),
    false
  )
})

test("binding predicate: different autoDisabledReason marker → skip", () => {
  // Defensive: a future feature might add another marker kind; we
  // should only re-enable rows for the reason we know how to handle.
  assert.equal(
    shouldReEnableAutoDisabledBinding(
      {
        id: "b4",
        transportAccountId: "acc-target",
        outboundEnabled: false,
        metadata: { autoDisabledReason: "some_future_reason" },
      },
      "acc-target"
    ),
    false
  )
})

test("binding predicate: binding under a different account → skip", () => {
  assert.equal(
    shouldReEnableAutoDisabledBinding(
      {
        id: "b5",
        transportAccountId: "acc-other",
        outboundEnabled: false,
        metadata: { autoDisabledReason: "webhook_inbound_unavailable" },
      },
      "acc-target"
    ),
    false
  )
})
