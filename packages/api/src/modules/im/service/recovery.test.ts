import test from "node:test"
import assert from "node:assert/strict"
import { canDeliverNowWithDeps, type CanDeliverNowDeps } from "./recovery.js"

type LinkSnapshot = Awaited<ReturnType<CanDeliverNowDeps["loadLink"]>>
type BindingSnapshot = Awaited<ReturnType<CanDeliverNowDeps["getBinding"]>>

function link(
  overrides: Partial<NonNullable<LinkSnapshot>> = {}
): LinkSnapshot {
  return {
    workspaceId: "ws-1",
    conversationId: "conv-1",
    transportAccountId: "acc-1",
    transportEndpointId: "ep-1",
    ...overrides,
  }
}

function binding(
  overrides: Partial<NonNullable<BindingSnapshot>> = {}
): BindingSnapshot {
  return {
    account: { id: "acc-1", status: "active" },
    endpoint: { id: "ep-1" },
    outboundEnabled: true,
    ...overrides,
  }
}

function deps(params: {
  link: LinkSnapshot
  binding?: BindingSnapshot
  calls?: string[]
}): CanDeliverNowDeps {
  return {
    loadLink: async () => {
      params.calls?.push("loadLink")
      return params.link
    },
    getBinding: async (query) => {
      params.calls?.push(
        `getBinding:${query.workspaceId}:${query.conversationId}`
      )
      return params.binding
    },
  }
}

test("canDeliverNowWithDeps returns link_not_found without binding lookup", async () => {
  const calls: string[] = []

  const result = await canDeliverNowWithDeps(
    "link-1",
    deps({ link: null, binding: binding(), calls })
  )

  assert.deepEqual(result, { ok: false, reason: "link_not_found" })
  assert.deepEqual(calls, ["loadLink"])
})

test("canDeliverNowWithDeps returns binding_missing for missing current binding", async () => {
  const calls: string[] = []

  const result = await canDeliverNowWithDeps(
    "link-1",
    deps({ link: link(), binding: null, calls })
  )

  assert.deepEqual(result, { ok: false, reason: "binding_missing" })
  assert.deepEqual(calls, ["loadLink", "getBinding:ws-1:conv-1"])
})

test("canDeliverNowWithDeps rejects disabled account before outbound check", async () => {
  const result = await canDeliverNowWithDeps(
    "link-1",
    deps({
      link: link(),
      binding: binding({
        account: { id: "acc-1", status: "disabled" },
        outboundEnabled: false,
      }),
    })
  )

  assert.deepEqual(result, { ok: false, reason: "account_disabled" })
})

test("canDeliverNowWithDeps rejects disabled outbound binding", async () => {
  const result = await canDeliverNowWithDeps(
    "link-1",
    deps({ link: link(), binding: binding({ outboundEnabled: false }) })
  )

  assert.deepEqual(result, { ok: false, reason: "outbound_disabled" })
})

test("canDeliverNowWithDeps rejects account or endpoint mismatch", async () => {
  assert.deepEqual(
    await canDeliverNowWithDeps(
      "link-1",
      deps({
        link: link(),
        binding: binding({ account: { id: "acc-2", status: "active" } }),
      })
    ),
    { ok: false, reason: "endpoint_mismatch" }
  )
  assert.deepEqual(
    await canDeliverNowWithDeps(
      "link-1",
      deps({
        link: link(),
        binding: binding({ endpoint: { id: "ep-2" } }),
      })
    ),
    { ok: false, reason: "endpoint_mismatch" }
  )
})

test("canDeliverNowWithDeps accepts matching active outbound binding", async () => {
  const result = await canDeliverNowWithDeps(
    "link-1",
    deps({ link: link(), binding: binding() })
  )

  assert.deepEqual(result, { ok: true })
})
