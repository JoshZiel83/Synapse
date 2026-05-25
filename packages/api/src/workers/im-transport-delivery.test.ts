import test from "node:test"
import assert from "node:assert/strict"
import {
  processImTransportDeliveryJob,
  type ImTransportDeliveryDeps,
} from "./im-transport-delivery.js"

/**
 * Worker-handler tests using the dep-injection seam introduced when the
 * BullMQ handler body was lifted into `processImTransportDeliveryJob`.
 *
 * Every test builds a minimal `ImTransportDeliveryDeps` with stub
 * functions; only the deps that matter for the path under test are
 * implemented, the rest throw if reached (which would itself be a test
 * failure signal).
 */

type Deps = ImTransportDeliveryDeps

const FAIL = (label: string) =>
  ((..._args: unknown[]) => {
    throw new Error(`unexpected ${label} call`)
  }) as any

function baseDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    loadLink: FAIL("loadLink"),
    findExternalMessageIdForItem: FAIL("findExternalMessageIdForItem"),
    updateStatus: FAIL("updateStatus"),
    getBinding: FAIL("getBinding"),
    getItem: FAIL("getItem"),
    decode: FAIL("decode"),
    getConnector: FAIL("getConnector"),
    ...overrides,
  }
}

// Convenience constructors for the shapes the handler reads. Cast to any
// at the dep boundary so we don't have to mirror the entire return type
// from loadTransportMessageLinkForDelivery (a join with ~30 columns).
function outboundLink(overrides: Record<string, unknown> = {}): any {
  return {
    id: "link-1",
    workspaceId: "ws-1",
    conversationId: "conv-1",
    itemId: "item-1",
    transportAccountId: "acc-1",
    transportEndpointId: "ep-1",
    transportKind: "feishu",
    direction: "outbound",
    deliveryStatus: "pending",
    account: {
      id: "acc-1",
      status: "active",
    },
    endpoint: {
      id: "ep-1",
      endpointType: "direct",
      externalId: "oc_chat_1",
      metadata: {},
    },
    ...overrides,
  }
}

function messageItem(overrides: Record<string, unknown> = {}): any {
  return {
    kind: "message",
    content: "hello",
    contentBlocks: [],
    author: { participantType: "user" },
    metadata: {},
    ...overrides,
  }
}

// ─── jobData parsing ───

test("missing jobData → failure shape, never calls loadLink", async () => {
  const result = await processImTransportDeliveryJob(undefined, baseDeps())
  assert.deepEqual(result, { success: false, reason: "missing linkId" })
})

test("null jobData → failure shape, never throws", async () => {
  const result = await processImTransportDeliveryJob(null, baseDeps())
  assert.deepEqual(result, { success: false, reason: "missing linkId" })
})

test("non-string linkId → failure shape", async () => {
  const result = await processImTransportDeliveryJob({ linkId: 42 }, baseDeps())
  assert.deepEqual(result, { success: false, reason: "missing linkId" })
})

test("empty linkId → failure shape", async () => {
  const result = await processImTransportDeliveryJob(
    { linkId: "   " },
    baseDeps()
  )
  assert.deepEqual(result, { success: false, reason: "missing linkId" })
})

// ─── loadLink ───

test("loadLink returns null → failure, no further calls", async () => {
  const deps = baseDeps({ loadLink: async () => null })
  const result = await processImTransportDeliveryJob({ linkId: "x" }, deps)
  assert.deepEqual(result, { success: false, reason: "missing link" })
})

// ─── direction != outbound ───

test("non-outbound link → updateStatus skipped/not_outbound, returns success", async () => {
  const calls: Array<Record<string, unknown>> = []
  const deps = baseDeps({
    loadLink: async () => outboundLink({ direction: "inbound" }),
    updateStatus: async (params) => {
      calls.push(params as any)
      return null
    },
  })
  const result = await processImTransportDeliveryJob({ linkId: "x" }, deps)
  assert.deepEqual(result, { success: true, reason: "not outbound" })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].status, "skipped")
  assert.deepEqual(calls[0].metadata, { skippedReason: "not_outbound" })
})

// ─── deliveryStatus short-circuits ───

test("sent deliveryStatus → no connector invoked, returns 'already sent'", async () => {
  const deps = baseDeps({
    loadLink: async () => outboundLink({ deliveryStatus: "sent" }),
  })
  const result = await processImTransportDeliveryJob({ linkId: "x" }, deps)
  assert.deepEqual(result, { success: true, reason: "already sent" })
})

test("skipped deliveryStatus → no connector invoked, returns 'already skipped'", async () => {
  const deps = baseDeps({
    loadLink: async () => outboundLink({ deliveryStatus: "skipped" }),
  })
  const result = await processImTransportDeliveryJob({ linkId: "x" }, deps)
  assert.deepEqual(result, { success: true, reason: "already skipped" })
})

test("pending deliveryStatus → proceeds to connector path", async () => {
  let getBindingCalled = false
  const deps = baseDeps({
    loadLink: async () => outboundLink({ deliveryStatus: "pending" }),
    updateStatus: async () => null,
    getBinding: async () => {
      getBindingCalled = true
      return null
    },
  })
  const result = await processImTransportDeliveryJob({ linkId: "x" }, deps)
  // returns binding unavailable because getBinding returned null — what
  // matters here is that the function got past the short-circuit and into
  // the binding lookup.
  assert.equal(getBindingCalled, true)
  assert.equal(result.success, true)
})

test("failed deliveryStatus → proceeds (original regression)", async () => {
  let getBindingCalled = false
  const deps = baseDeps({
    loadLink: async () => outboundLink({ deliveryStatus: "failed" }),
    updateStatus: async () => null,
    getBinding: async () => {
      getBindingCalled = true
      return null
    },
  })
  await processImTransportDeliveryJob({ linkId: "x" }, deps)
  assert.equal(getBindingCalled, true)
})

// ─── account status ───

test("account status != active → updateStatus skipped/account_disabled", async () => {
  const calls: Array<Record<string, unknown>> = []
  const deps = baseDeps({
    loadLink: async () =>
      outboundLink({ account: { id: "acc-1", status: "disabled" } }),
    updateStatus: async (params) => {
      calls.push(params as any)
      return null
    },
  })
  const result = await processImTransportDeliveryJob({ linkId: "x" }, deps)
  assert.deepEqual(result, { success: true, reason: "account disabled" })
  assert.deepEqual(calls[0].metadata, { skippedReason: "account_disabled" })
})

// ─── binding checks ───

async function runWithBinding(
  binding: any,
  link = outboundLink()
): Promise<{ result: any; updateCalls: any[] }> {
  const updateCalls: any[] = []
  const deps = baseDeps({
    loadLink: async () => link,
    getBinding: async () => binding,
    updateStatus: async (params) => {
      updateCalls.push(params)
      return null
    },
  })
  const result = await processImTransportDeliveryJob({ linkId: "x" }, deps)
  return { result, updateCalls }
}

test("binding missing → skipped/binding_missing", async () => {
  const { result, updateCalls } = await runWithBinding(null)
  assert.equal(result.success, true)
  assert.equal(result.reason, "binding unavailable")
  assert.deepEqual(updateCalls[0].metadata, {
    skippedReason: "binding_missing",
  })
})

test("binding account.status disabled → skipped/account_disabled", async () => {
  const { updateCalls } = await runWithBinding({
    account: { id: "acc-1", status: "disabled" },
    endpoint: { id: "ep-1" },
    outboundEnabled: true,
  })
  assert.deepEqual(updateCalls[0].metadata, {
    skippedReason: "account_disabled",
  })
})

test("outboundEnabled=false → skipped/binding_disabled", async () => {
  const { updateCalls } = await runWithBinding({
    account: { id: "acc-1", status: "active" },
    endpoint: { id: "ep-1" },
    outboundEnabled: false,
  })
  assert.deepEqual(updateCalls[0].metadata, {
    skippedReason: "binding_disabled",
  })
})

test("account.id mismatch → skipped/binding_changed", async () => {
  const { updateCalls } = await runWithBinding({
    account: { id: "acc-OTHER", status: "active" },
    endpoint: { id: "ep-1" },
    outboundEnabled: true,
  })
  assert.deepEqual(updateCalls[0].metadata, {
    skippedReason: "binding_changed",
  })
})

test("endpoint.id mismatch → skipped/binding_changed", async () => {
  const { updateCalls } = await runWithBinding({
    account: { id: "acc-1", status: "active" },
    endpoint: { id: "ep-OTHER" },
    outboundEnabled: true,
  })
  assert.deepEqual(updateCalls[0].metadata, {
    skippedReason: "binding_changed",
  })
})

// ─── item checks ───

test("item missing → skipped/item_missing_or_not_message", async () => {
  const updateCalls: any[] = []
  const deps = baseDeps({
    loadLink: async () => outboundLink(),
    getBinding: async () => ({
      account: { id: "acc-1", status: "active" },
      endpoint: { id: "ep-1" },
      outboundEnabled: true,
    }),
    getItem: async () => null,
    updateStatus: async (params) => {
      updateCalls.push(params)
      return null
    },
  })
  const result = await processImTransportDeliveryJob({ linkId: "x" }, deps)
  assert.equal(result.reason, "item missing")
  assert.deepEqual(updateCalls[0].metadata, {
    skippedReason: "item_missing_or_not_message",
  })
})

test("item kind != message → skipped/item_missing_or_not_message", async () => {
  const updateCalls: any[] = []
  const deps = baseDeps({
    loadLink: async () => outboundLink(),
    getBinding: async () => ({
      account: { id: "acc-1", status: "active" },
      endpoint: { id: "ep-1" },
      outboundEnabled: true,
    }),
    getItem: async () => ({ kind: "event" }) as any,
    updateStatus: async (params) => {
      updateCalls.push(params)
      return null
    },
  })
  await processImTransportDeliveryJob({ linkId: "x" }, deps)
  assert.deepEqual(updateCalls[0].metadata, {
    skippedReason: "item_missing_or_not_message",
  })
})

test("external author → skipped/external_author", async () => {
  const updateCalls: any[] = []
  const deps = baseDeps({
    loadLink: async () => outboundLink(),
    getBinding: async () => ({
      account: { id: "acc-1", status: "active" },
      endpoint: { id: "ep-1" },
      outboundEnabled: true,
    }),
    getItem: async () =>
      messageItem({ author: { participantType: "external" } }),
    updateStatus: async (params) => {
      updateCalls.push(params)
      return null
    },
  })
  const result = await processImTransportDeliveryJob({ linkId: "x" }, deps)
  assert.equal(result.reason, "external author")
  assert.deepEqual(updateCalls[0].metadata, {
    skippedReason: "external_author",
  })
})

// ─── connector / decode / send failures ───

function happyPathDepsExceptConnector(): Partial<Deps> {
  return {
    loadLink: async () => outboundLink(),
    getBinding: async () => ({
      account: { id: "acc-1", status: "active" },
      endpoint: { id: "ep-1" },
      outboundEnabled: true,
    }),
    getItem: async () => messageItem(),
    decode: () =>
      ({
        schemaVersion: 1,
        parts: [],
        plainText: "",
      }) as any,
  }
}

test("getConnector throws → updateStatus failed with error, re-throws", async () => {
  const updateCalls: any[] = []
  const deps = baseDeps({
    ...happyPathDepsExceptConnector(),
    getConnector: () => {
      throw new Error("test connector-missing")
    },
    updateStatus: async (params) => {
      updateCalls.push(params)
      return null
    },
  })
  await assert.rejects(
    processImTransportDeliveryJob({ linkId: "x" }, deps),
    /test connector-missing/
  )
  assert.equal(updateCalls.length, 1)
  assert.equal(updateCalls[0].status, "failed")
  assert.equal(updateCalls[0].error, "test connector-missing")
})

test("decode throws → updateStatus failed with error, re-throws (catch range preserved)", async () => {
  const updateCalls: any[] = []
  const deps = baseDeps({
    ...happyPathDepsExceptConnector(),
    getConnector: () =>
      ({
        messageCapabilities: { directMentionPolicy: "attached_only" },
        sendMessage: async () => ({ externalMessageId: "irrelevant" }),
      }) as any,
    decode: () => {
      throw new Error("decode boom")
    },
    updateStatus: async (params) => {
      updateCalls.push(params)
      return null
    },
  })
  await assert.rejects(
    processImTransportDeliveryJob({ linkId: "x" }, deps),
    /decode boom/
  )
  assert.equal(updateCalls[0].status, "failed")
  assert.equal(updateCalls[0].error, "decode boom")
})

test("connector.sendMessage throws → updateStatus failed, re-throws for BullMQ retry", async () => {
  const updateCalls: any[] = []
  const deps = baseDeps({
    ...happyPathDepsExceptConnector(),
    getConnector: () =>
      ({
        messageCapabilities: { directMentionPolicy: "attached_only" },
        sendMessage: async () => {
          throw new Error("send boom")
        },
      }) as any,
    updateStatus: async (params) => {
      updateCalls.push(params)
      return null
    },
  })
  await assert.rejects(
    processImTransportDeliveryJob({ linkId: "x" }, deps),
    /send boom/
  )
  assert.equal(updateCalls[0].status, "failed")
  assert.equal(updateCalls[0].error, "send boom")
})

// ─── happy path ───

test("happy path → connector.sendMessage called, status updated to sent, returns messageId", async () => {
  const updateCalls: any[] = []
  let sendCalled = false
  const deps = baseDeps({
    ...happyPathDepsExceptConnector(),
    getConnector: () =>
      ({
        messageCapabilities: { directMentionPolicy: "attached_only" },
        sendMessage: async () => {
          sendCalled = true
          return { externalMessageId: "om_external_123" }
        },
      }) as any,
    findExternalMessageIdForItem: async () => null,
    updateStatus: async (params) => {
      updateCalls.push(params)
      return null
    },
  })
  const result = await processImTransportDeliveryJob({ linkId: "x" }, deps)
  assert.equal(sendCalled, true)
  assert.equal(result.success, true)
  assert.equal(result.messageId, "om_external_123")
  assert.equal(updateCalls[0].status, "sent")
  assert.equal(updateCalls[0].externalMessageId, "om_external_123")
})
