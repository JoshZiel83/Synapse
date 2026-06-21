import test from "node:test"
import assert from "node:assert/strict"
import {
  reconcileWhatsappStatus,
  type StatusReconcileDeps,
  type StatusReconcileLink,
} from "./status-reconcile.js"

function makeDeps(link: StatusReconcileLink | null) {
  const updates: Array<{
    linkId: string
    status: string
    error?: string
    metadata?: Record<string, unknown>
  }> = []
  const deps: StatusReconcileDeps = {
    findOutboundLink: async () => link,
    updateLinkStatus: async (input) => {
      updates.push(input)
      return undefined
    },
  }
  return { deps, updates }
}

test("status-reconcile: status=failed flips the matched outbound link to failed", async () => {
  const { deps, updates } = makeDeps({ id: "link-1", deliveryStatus: "sent" })
  const flipped = await reconcileWhatsappStatus({
    accountId: "acct",
    entry: {
      id: "wamid.OUT",
      status: "failed",
      errors: [{ code: 131047, title: "Re-engagement message" }],
    },
    deps,
  })
  assert.equal(flipped, true)
  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.linkId, "link-1")
  assert.equal(updates[0]?.status, "failed")
  assert.match(updates[0]?.error ?? "", /131047/)
  const meta = updates[0]?.metadata as {
    whatsapp?: { statusError?: { code?: number } }
  }
  assert.equal(meta?.whatsapp?.statusError?.code, 131047)
})

test("status-reconcile: non-failed statuses are ignored", async () => {
  for (const status of ["sent", "delivered", "read", "played"] as const) {
    const { deps, updates } = makeDeps({ id: "l", deliveryStatus: "sent" })
    const flipped = await reconcileWhatsappStatus({
      accountId: "acct",
      entry: { id: "wamid.OUT", status },
      deps,
    })
    assert.equal(flipped, false)
    assert.equal(updates.length, 0)
  }
})

test("status-reconcile: unknown wamid (no link) is a no-op, no throw", async () => {
  const { deps, updates } = makeDeps(null)
  const flipped = await reconcileWhatsappStatus({
    accountId: "acct",
    entry: {
      id: "wamid.UNKNOWN",
      status: "failed",
      errors: [{ code: 131026 }],
    },
    deps,
  })
  assert.equal(flipped, false)
  assert.equal(updates.length, 0)
})

test("status-reconcile: blank wamid is skipped", async () => {
  const { deps, updates } = makeDeps({ id: "l" })
  const flipped = await reconcileWhatsappStatus({
    accountId: "acct",
    entry: { id: "  ", status: "failed" },
    deps,
  })
  assert.equal(flipped, false)
  assert.equal(updates.length, 0)
})

test("status-reconcile: idempotent — re-running flips again to the same terminal state", async () => {
  const { deps, updates } = makeDeps({ id: "link-1", deliveryStatus: "failed" })
  const entry = {
    id: "wamid.OUT",
    status: "failed" as const,
    errors: [{ code: 131026, title: "Undeliverable" }],
  }
  await reconcileWhatsappStatus({ accountId: "a", entry, deps })
  await reconcileWhatsappStatus({ accountId: "a", entry, deps })
  assert.equal(updates.length, 2)
  assert.equal(updates[1]?.status, "failed")
})
