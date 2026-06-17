import test from "node:test"
import assert from "node:assert/strict"
import {
  processImTransportDeliveryJob,
  type ImTransportDeliveryDeps,
} from "./im-transport-delivery.js"
import { PermanentTransportError } from "../modules/im/connectors/types.js"

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
    patchLinkMetadata: FAIL("patchLinkMetadata"),
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
    // Binding-changed check now runs before the account-status
    // short-circuit (so a legitimate binding switch from a disabled
    // old account → active new account can be detected). Provide a
    // matching binding so the new check passes silently and the test
    // exercises the account_disabled path it was originally written
    // for.
    getBinding: async () =>
      ({
        account: { id: "acc-1", status: "active" },
        endpoint: { id: "ep-1" },
        outboundEnabled: true,
      }) as any,
    updateStatus: async (params) => {
      calls.push(params as any)
      return null
    },
  })
  const result = await processImTransportDeliveryJob({ linkId: "x" }, deps)
  assert.deepEqual(result, { success: true, reason: "account disabled" })
  assert.deepEqual(calls[0].metadata, { skippedReason: "account_disabled" })
})

test("binding moved to a different (account, endpoint) → updateStatus skipped/binding_changed BEFORE account-status check", async () => {
  // Regression test for the binding-changed reorder. Before the fix,
  // a link whose stale account was disabled would short-circuit to
  // account_disabled even when the current binding had legitimately
  // moved onto a fresh active account — recovery code that looks for
  // `binding_changed` skipReason never saw the link.
  const calls: Array<Record<string, unknown>> = []
  const deps = baseDeps({
    loadLink: async () =>
      outboundLink({ account: { id: "acc-1", status: "disabled" } }),
    getBinding: async () =>
      ({
        // current binding points at a NEW account/endpoint — id
        // mismatch with the link's snapshot.
        account: { id: "acc-2", status: "active" },
        endpoint: { id: "ep-2" },
        outboundEnabled: true,
      }) as any,
    updateStatus: async (params) => {
      calls.push(params as any)
      return null
    },
  })
  const result = await processImTransportDeliveryJob({ linkId: "x" }, deps)
  assert.deepEqual(result, { success: true, reason: "binding changed" })
  assert.deepEqual(calls[0].metadata, { skippedReason: "binding_changed" })
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
    getBinding: async () =>
      ({
        account: { id: "acc-1", status: "active" },
        endpoint: { id: "ep-1" },
        outboundEnabled: true,
      }) as any,
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
    getBinding: async () =>
      ({
        account: { id: "acc-1", status: "active" },
        endpoint: { id: "ep-1" },
        outboundEnabled: true,
      }) as any,
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
    getBinding: async () =>
      ({
        account: { id: "acc-1", status: "active" },
        endpoint: { id: "ep-1" },
        outboundEnabled: true,
      }) as any,
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
    getBinding: async () =>
      ({
        account: { id: "acc-1", status: "active" },
        endpoint: { id: "ep-1" },
        outboundEnabled: true,
      }) as any,
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
      loadRecipientAddress: async () => undefined,
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

// ─── OutboundSendInput contract: 4 new fields + ambiguous delivery ───
//
// shared prep added `transportMessageLinkId`, `linkMetadata`,
// `attemptNumber`, `patchLinkMetadata` to OutboundSendInput, and
// `deliveryAmbiguous` to OutboundSendResult. The worker is responsible
// for constructing these from the loaded link + the BullMQ job. These
// tests pin the contract: connector receives the right values, the
// patch helper writes to the right link, ambiguous result marks `sent`
// without an external id, and missing id without ambiguity raises a
// PermanentTransportError (caught + re-thrown as BullMQ
// UnrecoverableError).

test("sendMessage receives transportMessageLinkId / linkMetadata / patchLinkMetadata / attemptNumber from worker", async () => {
  const captured: Partial<{
    transportMessageLinkId: string
    linkMetadata: Record<string, unknown>
    attemptNumber: number
  }> = {}
  const patchCalls: Array<{ linkId: string; patch: Record<string, unknown> }> =
    []
  const link = outboundLink({ metadata: { qq: { msg_seq: 7 } } })
  const deps = baseDeps({
    ...happyPathDepsExceptConnector(),
    loadLink: async () => link,
    findExternalMessageIdForItem: async () => null,
    updateStatus: async () => null,
    patchLinkMetadata: async (params) => {
      patchCalls.push(params)
    },
    getConnector: () =>
      ({
        messageCapabilities: { directMentionPolicy: "attached_only" },
        sendMessage: async (input: any) => {
          captured.transportMessageLinkId = input.transportMessageLinkId
          captured.linkMetadata = input.linkMetadata
          captured.attemptNumber = input.attemptNumber
          // Exercise the patch callback the connector receives — the
          // worker wires it to deps.patchLinkMetadata with the same
          // link.id.
          await input.patchLinkMetadata({ qq: { msg_seq: 8 } })
          return { externalMessageId: "qq_42" }
        },
      }) as any,
  })
  await processImTransportDeliveryJob({ linkId: link.id }, deps, 3)
  assert.equal(
    captured.transportMessageLinkId,
    link.id,
    "transportMessageLinkId must be the link's id"
  )
  assert.deepEqual(
    captured.linkMetadata,
    { qq: { msg_seq: 7 } },
    "linkMetadata must be the loaded link.metadata snapshot"
  )
  assert.equal(
    captured.attemptNumber,
    3,
    "attemptNumber must come from BullMQ job.attemptsMade"
  )
  assert.deepEqual(patchCalls, [
    { linkId: link.id, patch: { qq: { msg_seq: 8 } } },
  ])
})

test("attemptNumber defaults to 0 when worker invoked without a job (test convenience)", async () => {
  let seen: number | undefined
  const deps = baseDeps({
    ...happyPathDepsExceptConnector(),
    findExternalMessageIdForItem: async () => null,
    updateStatus: async () => null,
    patchLinkMetadata: async () => {},
    getConnector: () =>
      ({
        messageCapabilities: { directMentionPolicy: "attached_only" },
        sendMessage: async (input: any) => {
          seen = input.attemptNumber
          return { externalMessageId: "x" }
        },
      }) as any,
  })
  await processImTransportDeliveryJob({ linkId: "x" }, deps)
  assert.equal(seen, 0)
})

test("linkMetadata defaults to {} when DB row had no metadata", async () => {
  let seen: Record<string, unknown> | undefined
  const deps = baseDeps({
    ...happyPathDepsExceptConnector(),
    loadLink: async () =>
      outboundLink({
        metadata: undefined as unknown as Record<string, unknown>,
      }),
    findExternalMessageIdForItem: async () => null,
    updateStatus: async () => null,
    patchLinkMetadata: async () => {},
    getConnector: () =>
      ({
        messageCapabilities: { directMentionPolicy: "attached_only" },
        sendMessage: async (input: any) => {
          seen = input.linkMetadata
          return { externalMessageId: "x" }
        },
      }) as any,
  })
  await processImTransportDeliveryJob({ linkId: "x" }, deps)
  assert.deepEqual(seen, {})
})

test("deliveryAmbiguous: true marks link sent with metadata.delivery.ambiguous and no external id", async () => {
  const updateCalls: any[] = []
  const deps = baseDeps({
    ...happyPathDepsExceptConnector(),
    findExternalMessageIdForItem: async () => null,
    patchLinkMetadata: async () => {},
    updateStatus: async (params) => {
      updateCalls.push(params)
      return null
    },
    getConnector: () =>
      ({
        messageCapabilities: { directMentionPolicy: "attached_only" },
        sendMessage: async () => ({ deliveryAmbiguous: true }),
      }) as any,
  })
  const result = await processImTransportDeliveryJob({ linkId: "x" }, deps)
  assert.deepEqual(result, { success: true })
  assert.equal(updateCalls.length, 1)
  assert.equal(updateCalls[0].status, "sent")
  assert.equal(
    updateCalls[0].externalMessageId,
    undefined,
    "no externalMessageId field — worker leaves the column NULL"
  )
  assert.deepEqual(updateCalls[0].metadata, { delivery: { ambiguous: true } })
})

test("missing externalMessageId without deliveryAmbiguous raises PermanentTransportError (no retry)", async () => {
  const updateCalls: any[] = []
  const deps = baseDeps({
    ...happyPathDepsExceptConnector(),
    findExternalMessageIdForItem: async () => null,
    patchLinkMetadata: async () => {},
    updateStatus: async (params) => {
      updateCalls.push(params)
      return null
    },
    getConnector: () =>
      ({
        transportKind: "qq",
        messageCapabilities: { directMentionPolicy: "attached_only" },
        // Bug shape: connector returns nothing → worker must NOT
        // silently mark sent (regression guard for the original
        // PermanentTransportError throw path).
        sendMessage: async () => ({}) as any,
      }) as any,
  })
  await assert.rejects(
    processImTransportDeliveryJob({ linkId: "x" }, deps),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match((err as Error).message, /missing|externalMessageId|no/i)
      return true
    }
  )
  // The worker still records the failure so the link metadata carries
  // a lastError; the throw is what stops retries (UnrecoverableError
  // wraps PermanentTransportError in the BullMQ wrapper).
  assert.equal(updateCalls.length, 1)
  assert.equal(updateCalls[0].status, "failed")
})

test("connector throws PermanentTransportError → worker re-throws (BullMQ UnrecoverableError) and marks failed", async () => {
  const updateCalls: any[] = []
  const deps = baseDeps({
    ...happyPathDepsExceptConnector(),
    findExternalMessageIdForItem: async () => null,
    patchLinkMetadata: async () => {},
    updateStatus: async (params) => {
      updateCalls.push(params)
      return null
    },
    getConnector: () =>
      ({
        messageCapabilities: { directMentionPolicy: "attached_only" },
        sendMessage: async () => {
          throw new PermanentTransportError("qq: bot banned", {
            code: "qq_bot_banned",
          })
        },
      }) as any,
  })
  await assert.rejects(
    processImTransportDeliveryJob({ linkId: "x" }, deps),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match((err as Error).message, /qq: bot banned/)
      return true
    }
  )
  assert.equal(updateCalls.length, 1)
  assert.equal(updateCalls[0].status, "failed")
  assert.match(String(updateCalls[0].error), /qq: bot banned/)
})
