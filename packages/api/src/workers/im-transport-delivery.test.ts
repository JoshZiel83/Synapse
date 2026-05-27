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
    loadRecipientAddress: FAIL("loadRecipientAddress"),
    resolveMentions: FAIL("resolveMentions"),
    updateStatus: FAIL("updateStatus"),
    patchLinkMetadata: async () => undefined,
    recoverBindingChangedLink: async () => undefined,
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

test("link.account.status='disabled' → still loads binding (no early skip), routes through binding classification", async () => {
  // Regression for the "old account disabled but binding switched to a
  // new active account" case: the worker must NOT use the link snapshot's
  // account status to short-circuit, otherwise binding_changed recovery
  // never fires.
  const calls: Array<Record<string, unknown>> = []
  let getBindingCalled = false
  const deps = baseDeps({
    loadLink: async () =>
      outboundLink({
        transportAccountId: "acc-old",
        account: { id: "acc-old", status: "disabled" },
      }),
    getBinding: async () => {
      getBindingCalled = true
      // Same account+endpoint as the link, both disabled → classifies as
      // account_disabled (NOT binding_changed) after the binding load.
      return {
        account: { id: "acc-old", status: "disabled" },
        endpoint: { id: "ep-1" },
        outboundEnabled: true,
      }
    },
    updateStatus: async (params) => {
      calls.push(params as any)
      return null
    },
  })
  const result = await processImTransportDeliveryJob({ linkId: "x" }, deps)
  assert.equal(getBindingCalled, true)
  assert.equal(result.reason, "binding unavailable")
  assert.deepEqual(calls[0].metadata, { skippedReason: "account_disabled" })
})

test("link account disabled BUT binding switched to new active account → binding_changed recovery", async () => {
  let recovered = false
  const deps = baseDeps({
    loadLink: async () =>
      outboundLink({
        transportAccountId: "acc-old",
        account: { id: "acc-old", status: "disabled" },
      }),
    getBinding: async () => ({
      account: { id: "acc-new", status: "active" },
      endpoint: { id: "ep-new" },
      outboundEnabled: true,
    }),
    recoverBindingChangedLink: async () => {
      recovered = true
    },
  })
  const result = await processImTransportDeliveryJob({ linkId: "x" }, deps)
  assert.equal(recovered, true)
  assert.equal(result.reason, "binding changed (recovered)")
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

test("account.id mismatch → triggers recoverBindingChangedLink (no updateStatus)", async () => {
  const updateCalls: any[] = []
  const recoveredFor: string[] = []
  const deps = baseDeps({
    loadLink: async () => outboundLink(),
    getBinding: async () => ({
      account: { id: "acc-OTHER", status: "active" },
      endpoint: { id: "ep-1" },
      outboundEnabled: true,
    }),
    updateStatus: async (params) => {
      updateCalls.push(params)
      return null
    },
    recoverBindingChangedLink: async (linkId) => {
      recoveredFor.push(linkId)
    },
  })
  const result = await processImTransportDeliveryJob({ linkId: "x" }, deps)
  assert.equal(result.success, true)
  assert.match(result.reason ?? "", /binding changed/)
  assert.deepEqual(recoveredFor, ["x"])
  assert.equal(updateCalls.length, 0)
})

test("endpoint.id mismatch → triggers recoverBindingChangedLink (no updateStatus)", async () => {
  const updateCalls: any[] = []
  const recoveredFor: string[] = []
  const deps = baseDeps({
    loadLink: async () => outboundLink(),
    getBinding: async () => ({
      account: { id: "acc-1", status: "active" },
      endpoint: { id: "ep-OTHER" },
      outboundEnabled: true,
    }),
    updateStatus: async (params) => {
      updateCalls.push(params)
      return null
    },
    recoverBindingChangedLink: async (linkId) => {
      recoveredFor.push(linkId)
    },
  })
  const result = await processImTransportDeliveryJob({ linkId: "x" }, deps)
  assert.equal(result.success, true)
  assert.match(result.reason ?? "", /binding changed/)
  assert.deepEqual(recoveredFor, ["x"])
  assert.equal(updateCalls.length, 0)
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
    // Default to "no mentions" so connector-path tests that don't care
    // about the mention pipeline don't have to opt in.
    resolveMentions: async () => new Map(),
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

// ─── recipientAddressMetadata pre-load (Weixin contextToken path) ───

function recipientMetadataConnector(opts: {
  requires: boolean
  capture: { received?: any }
}) {
  return {
    requiresRecipientAddressMetadata: opts.requires,
    messageCapabilities: { directMentionPolicy: "attached_only" },
    sendMessage: async (input: any) => {
      opts.capture.received = input.recipientAddressMetadata
      return { externalMessageId: "om_external_123" }
    },
  } as any
}

test(
  "recipient pre-load: requiresRecipientAddressMetadata=true + address row present " +
    "→ connector receives recipientAddressMetadata with contextToken",
  async () => {
    const capture: { received?: any } = {}
    let loadCallCount = 0
    const deps = baseDeps({
      ...happyPathDepsExceptConnector(),
      getConnector: () =>
        recipientMetadataConnector({ requires: true, capture }),
      loadRecipientAddress: async (params) => {
        loadCallCount++
        assert.equal(params.transportAccountId, "acc-1")
        assert.equal(params.addressType, "user")
        assert.equal(params.externalId, "oc_chat_1")
        return { id: "addr-1", metadata: { contextToken: "ctx-abc" } } as any
      },
      findExternalMessageIdForItem: async () => null,
      updateStatus: async () => null,
    })
    await processImTransportDeliveryJob({ linkId: "x" }, deps)
    assert.equal(loadCallCount, 1)
    assert.deepEqual(capture.received, { contextToken: "ctx-abc" })
  }
)

test(
  "recipient pre-load: requiresRecipientAddressMetadata=true + null address row " +
    "→ connector receives undefined",
  async () => {
    const capture: { received?: any } = {}
    const deps = baseDeps({
      ...happyPathDepsExceptConnector(),
      getConnector: () =>
        recipientMetadataConnector({ requires: true, capture }),
      loadRecipientAddress: async () => null,
      findExternalMessageIdForItem: async () => null,
      updateStatus: async () => null,
    })
    await processImTransportDeliveryJob({ linkId: "x" }, deps)
    assert.equal(capture.received, undefined)
  }
)

test(
  "recipient pre-load: requiresRecipientAddressMetadata=false " +
    "→ loadRecipientAddress NOT called, connector receives undefined (Feishu regression)",
  async () => {
    const capture: { received?: any } = {}
    const deps = baseDeps({
      ...happyPathDepsExceptConnector(),
      getConnector: () =>
        recipientMetadataConnector({ requires: false, capture }),
      // loadRecipientAddress left as FAIL — must not be called.
      findExternalMessageIdForItem: async () => null,
      updateStatus: async () => null,
    })
    await processImTransportDeliveryJob({ linkId: "x" }, deps)
    assert.equal(capture.received, undefined)
  }
)

test(
  "recipient pre-load: address row metadata is a primitive " +
    "→ connector receives undefined (asObjectMetadata guard)",
  async () => {
    const capture: { received?: any } = {}
    const deps = baseDeps({
      ...happyPathDepsExceptConnector(),
      getConnector: () =>
        recipientMetadataConnector({ requires: true, capture }),
      loadRecipientAddress: async () =>
        ({ id: "addr-1", metadata: "a string, not an object" }) as any,
      findExternalMessageIdForItem: async () => null,
      updateStatus: async () => null,
    })
    await processImTransportDeliveryJob({ linkId: "x" }, deps)
    assert.equal(capture.received, undefined)
  }
)

test(
  "recipient pre-load: address row metadata is an array " +
    "→ connector receives undefined (asObjectMetadata guard)",
  async () => {
    const capture: { received?: any } = {}
    const deps = baseDeps({
      ...happyPathDepsExceptConnector(),
      getConnector: () =>
        recipientMetadataConnector({ requires: true, capture }),
      loadRecipientAddress: async () =>
        ({ id: "addr-1", metadata: [1, 2, 3] }) as any,
      findExternalMessageIdForItem: async () => null,
      updateStatus: async () => null,
    })
    await processImTransportDeliveryJob({ linkId: "x" }, deps)
    assert.equal(capture.received, undefined)
  }
)

test(
  "recipient pre-load: loadRecipientAddress throws → updateStatus failed with error, re-throws " +
    "(catch range covers the address pre-fetch)",
  async () => {
    const updateCalls: any[] = []
    const capture: { received?: any } = {}
    const deps = baseDeps({
      ...happyPathDepsExceptConnector(),
      getConnector: () =>
        recipientMetadataConnector({ requires: true, capture }),
      loadRecipientAddress: async () => {
        throw new Error("address lookup boom")
      },
      updateStatus: async (params) => {
        updateCalls.push(params)
        return null
      },
    })
    await assert.rejects(
      processImTransportDeliveryJob({ linkId: "x" }, deps),
      /address lookup boom/
    )
    assert.equal(updateCalls.length, 1)
    assert.equal(updateCalls[0].status, "failed")
    assert.equal(updateCalls[0].error, "address lookup boom")
  }
)

// ─── in-place mention fill via deps.resolveMentions ───

/**
 * Build a `decode` stub that returns a CanonicalMessage with the supplied
 * parts. The worker calls `deps.decode` to translate the conversation_item
 * into CanonicalMessage; in tests we skip that translation and hand the
 * parts directly.
 */
function decodeStub(parts: any[]) {
  return () =>
    ({
      schemaVersion: 1,
      parts,
      plainText: "",
    }) as any
}

/**
 * Connector that captures the final `message.parts` array passed into
 * `sendMessage`. The worker's mutation must be observable so we can
 * assert in-place fill (not append).
 */
function capturingConnector(): {
  connector: any
  capture: { receivedParts?: any[] }
} {
  const capture: { receivedParts?: any[] } = {}
  const connector = {
    messageCapabilities: { directMentionPolicy: "attached_only" },
    sendMessage: async (input: any) => {
      capture.receivedParts = input.message.parts
      return { externalMessageId: "om_x" }
    },
  } as any
  return { connector, capture }
}

test("mention fill: single mention with participantId → external fill in place, no appended parts", async () => {
  const { connector, capture } = capturingConnector()
  const initialParts = [
    { type: "text", text: "hello " },
    { type: "mention", participantId: "p1", displayName: "Alice" },
    { type: "text", text: " bye" },
  ]
  const deps = baseDeps({
    ...happyPathDepsExceptConnector(),
    getConnector: () => connector,
    decode: decodeStub(initialParts),
    resolveMentions: async () =>
      new Map([["p1", { externalId: "ou_a", displayName: "Alice" }]]),
    findExternalMessageIdForItem: async () => null,
    updateStatus: async () => null,
  })
  await processImTransportDeliveryJob({ linkId: "x" }, deps)
  const parts = capture.receivedParts!
  assert.equal(parts.length, 3, "no appended parts")
  assert.equal(parts[0].type, "text")
  assert.equal(parts[1].type, "mention")
  assert.equal(parts[1].externalId, "ou_a")
  assert.equal(parts[1].displayName, "Alice")
  assert.equal(parts[2].type, "text")
})

test("mention fill: inbound-mirrored mention (externalId set, no participantId) → unchanged", async () => {
  const { connector, capture } = capturingConnector()
  const initialParts = [
    { type: "mention", externalId: "ou_already", displayName: "Pre" },
  ]
  const deps = baseDeps({
    ...happyPathDepsExceptConnector(),
    getConnector: () => connector,
    decode: decodeStub(initialParts),
    resolveMentions: async () => new Map(), // no participants to resolve
    findExternalMessageIdForItem: async () => null,
    updateStatus: async () => null,
  })
  await processImTransportDeliveryJob({ linkId: "x" }, deps)
  const parts = capture.receivedParts!
  assert.equal(parts.length, 1)
  assert.equal(parts[0].externalId, "ou_already")
  assert.equal(parts[0].displayName, "Pre")
})

test("mention fill: two parts with same participantId → both filled to same externalId", async () => {
  const { connector, capture } = capturingConnector()
  const initialParts = [
    { type: "mention", participantId: "p1", displayName: "Alice" },
    { type: "text", text: " and " },
    { type: "mention", participantId: "p1", displayName: "Alice" },
  ]
  const deps = baseDeps({
    ...happyPathDepsExceptConnector(),
    getConnector: () => connector,
    decode: decodeStub(initialParts),
    resolveMentions: async () =>
      new Map([["p1", { externalId: "ou_a", displayName: "Alice" }]]),
    findExternalMessageIdForItem: async () => null,
    updateStatus: async () => null,
  })
  await processImTransportDeliveryJob({ linkId: "x" }, deps)
  const parts = capture.receivedParts!
  assert.equal(parts.length, 3)
  assert.equal(parts[0].externalId, "ou_a")
  assert.equal(parts[2].externalId, "ou_a")
})

test("mention fill: stubbed resolver returns empty Map → message.parts unchanged", async () => {
  const { connector, capture } = capturingConnector()
  const initialParts = [
    { type: "mention", participantId: "p_missing", displayName: "Alice" },
  ]
  const deps = baseDeps({
    ...happyPathDepsExceptConnector(),
    getConnector: () => connector,
    decode: decodeStub(initialParts),
    resolveMentions: async () => new Map(),
    findExternalMessageIdForItem: async () => null,
    updateStatus: async () => null,
  })
  await processImTransportDeliveryJob({ linkId: "x" }, deps)
  const parts = capture.receivedParts!
  assert.equal(parts.length, 1)
  assert.equal(parts[0].externalId, undefined)
  assert.equal(parts[0].displayName, "Alice")
})

test("mention fill: empty displayName + resolver returns name → part.displayName fills", async () => {
  const { connector, capture } = capturingConnector()
  const initialParts = [
    { type: "mention", participantId: "p1", displayName: "" },
  ]
  const deps = baseDeps({
    ...happyPathDepsExceptConnector(),
    getConnector: () => connector,
    decode: decodeStub(initialParts),
    resolveMentions: async () =>
      new Map([["p1", { externalId: "ou_a", displayName: "Alice" }]]),
    findExternalMessageIdForItem: async () => null,
    updateStatus: async () => null,
  })
  await processImTransportDeliveryJob({ linkId: "x" }, deps)
  const parts = capture.receivedParts!
  assert.equal(parts[0].displayName, "Alice")
})

test(
  "mention fill: whitespace-only displayName + resolver returns name → part.displayName fills " +
    "(trim-based emptiness check, not just falsy)",
  async () => {
    const { connector, capture } = capturingConnector()
    const initialParts = [
      { type: "mention", participantId: "p1", displayName: "   " },
    ]
    const deps = baseDeps({
      ...happyPathDepsExceptConnector(),
      getConnector: () => connector,
      decode: decodeStub(initialParts),
      resolveMentions: async () =>
        new Map([["p1", { externalId: "ou_a", displayName: "Alice" }]]),
      findExternalMessageIdForItem: async () => null,
      updateStatus: async () => null,
    })
    await processImTransportDeliveryJob({ linkId: "x" }, deps)
    const parts = capture.receivedParts!
    assert.equal(parts[0].displayName, "Alice")
  }
)

test(
  "mention fill: resolveMentions throws → updateStatus failed with error, re-throws " +
    "(catch range covers the resolver call, mirroring the loadRecipientAddress test)",
  async () => {
    const { connector } = capturingConnector()
    const updateCalls: any[] = []
    const deps = baseDeps({
      ...happyPathDepsExceptConnector(),
      getConnector: () => connector,
      decode: decodeStub([]),
      resolveMentions: async () => {
        throw new Error("resolve boom")
      },
      updateStatus: async (params) => {
        updateCalls.push(params)
        return null
      },
    })
    await assert.rejects(
      processImTransportDeliveryJob({ linkId: "x" }, deps),
      /resolve boom/
    )
    assert.equal(updateCalls.length, 1)
    assert.equal(updateCalls[0].status, "failed")
    assert.equal(updateCalls[0].error, "resolve boom")
  }
)

test(
  "mention fill: original positional order preserved — no trailing block of duplicate mentions " +
    "(the prior worker appended mentions to the end of message.parts)",
  async () => {
    const { connector, capture } = capturingConnector()
    const initialParts = [
      { type: "text", text: "ping " },
      { type: "mention", participantId: "p1", displayName: "Alice" },
      { type: "text", text: " and " },
      { type: "mention", participantId: "p2", displayName: "Bob" },
      { type: "text", text: " — done" },
    ]
    const deps = baseDeps({
      ...happyPathDepsExceptConnector(),
      getConnector: () => connector,
      decode: decodeStub(initialParts),
      resolveMentions: async () =>
        new Map([
          ["p1", { externalId: "ou_a", displayName: "Alice" }],
          ["p2", { externalId: "ou_b", displayName: "Bob" }],
        ]),
      findExternalMessageIdForItem: async () => null,
      updateStatus: async () => null,
    })
    await processImTransportDeliveryJob({ linkId: "x" }, deps)
    const parts = capture.receivedParts!
    assert.equal(parts.length, 5, "exactly the original 5 parts — no append")
    assert.equal(parts[0].type, "text")
    assert.equal(parts[1].type, "mention")
    assert.equal(parts[1].externalId, "ou_a")
    assert.equal(parts[2].type, "text")
    assert.equal(parts[3].type, "mention")
    assert.equal(parts[3].externalId, "ou_b")
    assert.equal(parts[4].type, "text")
  }
)
