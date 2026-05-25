import test from "node:test"
import assert from "node:assert/strict"
import { buildCanonicalMessage } from "./canonical-message.js"
import { FEISHU_MESSAGE_CAPABILITIES } from "../connectors/feishu/capabilities.js"
import { WEIXIN_MESSAGE_CAPABILITIES } from "../connectors/weixin/capabilities.js"
import {
  resolveMentionRecipients,
  resolveMentionRecipientsByParticipant,
  shouldUseAttachedAddressOnly,
  type MentionResolverDeps,
} from "./mention-resolver.js"

function makeDeps(
  overrides: Partial<MentionResolverDeps> = {}
): MentionResolverDeps {
  return {
    loadAttachedAddress: async () => null,
    loadReachableAddress: async () => null,
    ...overrides,
  }
}

test("shouldUseAttachedAddressOnly: groups always; direct policy-driven", () => {
  assert.equal(
    shouldUseAttachedAddressOnly(FEISHU_MESSAGE_CAPABILITIES, "group"),
    true
  )
  assert.equal(
    shouldUseAttachedAddressOnly(WEIXIN_MESSAGE_CAPABILITIES, "group"),
    true
  )
  assert.equal(
    shouldUseAttachedAddressOnly(FEISHU_MESSAGE_CAPABILITIES, "direct"),
    true,
    "feishu: attached_only policy keeps direct mentions attached"
  )
  assert.equal(
    shouldUseAttachedAddressOnly(WEIXIN_MESSAGE_CAPABILITIES, "direct"),
    false,
    "weixin: self_only policy uses reachable lookup then filters"
  )
})

test("resolves feishu group mentions via attached lookup only", () => {
  const calls: string[] = []
  const deps = makeDeps({
    loadAttachedAddress: async ({ conversationParticipantId }) => {
      calls.push(`attached:${conversationParticipantId}`)
      return { externalId: "ou_a", displayName: "Alice" }
    },
    loadReachableAddress: async () => {
      throw new Error("should not be called for groups")
    },
  })
  const msg = buildCanonicalMessage([
    { type: "mention", participantId: "p1", displayName: "alice" },
    { type: "text", text: "hi" },
  ])
  return resolveMentionRecipients(
    {
      parts: msg.parts,
      capabilities: FEISHU_MESSAGE_CAPABILITIES,
      transportAccountId: "acc",
      endpointType: "group",
      endpointExternalId: "oc_g",
    },
    deps
  ).then((out) => {
    assert.deepEqual(out, [{ externalId: "ou_a", displayName: "Alice" }])
    assert.deepEqual(calls, ["attached:p1"])
  })
})

test("weixin direct uses reachable lookup and requires externalId === endpoint", async () => {
  const deps = makeDeps({
    loadReachableAddress: async () => ({ externalId: "wx_other" }),
  })
  const msg = buildCanonicalMessage([
    { type: "mention", participantId: "p1", displayName: "x" },
  ])
  const out = await resolveMentionRecipients(
    {
      parts: msg.parts,
      capabilities: WEIXIN_MESSAGE_CAPABILITIES,
      transportAccountId: "acc",
      endpointType: "direct",
      endpointExternalId: "wx_target",
    },
    deps
  )
  assert.deepEqual(out, []) // dropped because externalId mismatch
})

test("weixin direct accepts mention when externalId matches endpoint", async () => {
  const deps = makeDeps({
    loadReachableAddress: async () => ({
      externalId: "wx_target",
      displayName: "Bob",
    }),
  })
  const msg = buildCanonicalMessage([
    { type: "mention", participantId: "p1", displayName: "fallback" },
  ])
  const out = await resolveMentionRecipients(
    {
      parts: msg.parts,
      capabilities: WEIXIN_MESSAGE_CAPABILITIES,
      transportAccountId: "acc",
      endpointType: "direct",
      endpointExternalId: "wx_target",
    },
    deps
  )
  assert.deepEqual(out, [{ externalId: "wx_target", displayName: "Bob" }])
})

test("mention without participantId is skipped", async () => {
  const deps = makeDeps()
  const msg = buildCanonicalMessage([
    { type: "mention", displayName: "no-id" },
    { type: "text", text: "x" },
  ])
  const out = await resolveMentionRecipients(
    {
      parts: msg.parts,
      capabilities: FEISHU_MESSAGE_CAPABILITIES,
      transportAccountId: "acc",
      endpointType: "group",
      endpointExternalId: "oc_g",
    },
    deps
  )
  assert.deepEqual(out, [])
})

test("falls back to mention.displayName when address has none", async () => {
  const deps = makeDeps({
    loadAttachedAddress: async () => ({ externalId: "ou_a" }),
  })
  const msg = buildCanonicalMessage([
    { type: "mention", participantId: "p1", displayName: "FallbackName" },
  ])
  const out = await resolveMentionRecipients(
    {
      parts: msg.parts,
      capabilities: FEISHU_MESSAGE_CAPABILITIES,
      transportAccountId: "acc",
      endpointType: "group",
      endpointExternalId: "oc_g",
    },
    deps
  )
  assert.deepEqual(out, [{ externalId: "ou_a", displayName: "FallbackName" }])
})

test("duplicate mentions resolve to one recipient (first-wins)", async () => {
  const deps = makeDeps({
    loadAttachedAddress: async ({ conversationParticipantId }) =>
      conversationParticipantId === "p1"
        ? { externalId: "ou_a", displayName: "Alice" }
        : { externalId: "ou_a", displayName: "AliceLater" }, // same externalId
  })
  const msg = buildCanonicalMessage([
    { type: "mention", participantId: "p1", displayName: "first" },
    { type: "mention", participantId: "p2", displayName: "later" },
  ])
  const out = await resolveMentionRecipients(
    {
      parts: msg.parts,
      capabilities: FEISHU_MESSAGE_CAPABILITIES,
      transportAccountId: "acc",
      endpointType: "group",
      endpointExternalId: "oc_g",
    },
    deps
  )
  assert.deepEqual(out, [{ externalId: "ou_a", displayName: "Alice" }])
})

test("address with empty/whitespace externalId is dropped", async () => {
  const deps = makeDeps({
    loadAttachedAddress: async () => ({ externalId: "   ", displayName: "x" }),
  })
  const msg = buildCanonicalMessage([
    { type: "mention", participantId: "p1", displayName: "x" },
  ])
  const out = await resolveMentionRecipients(
    {
      parts: msg.parts,
      capabilities: FEISHU_MESSAGE_CAPABILITIES,
      transportAccountId: "acc",
      endpointType: "group",
      endpointExternalId: "oc_g",
    },
    deps
  )
  assert.deepEqual(out, [])
})

test("feishu direct uses attached lookup (matches V1 bot semantics)", async () => {
  const calls: string[] = []
  const deps = makeDeps({
    loadAttachedAddress: async ({ conversationParticipantId }) => {
      calls.push(`attached:${conversationParticipantId}`)
      return { externalId: "ou_a", displayName: "Alice" }
    },
    loadReachableAddress: async () => {
      throw new Error("should not be called for feishu direct")
    },
  })
  const msg = buildCanonicalMessage([
    { type: "mention", participantId: "p1", displayName: "alice" },
  ])
  const out = await resolveMentionRecipients(
    {
      parts: msg.parts,
      capabilities: FEISHU_MESSAGE_CAPABILITIES,
      transportAccountId: "acc",
      endpointType: "direct",
      endpointExternalId: "ou_b",
    },
    deps
  )
  assert.deepEqual(out, [{ externalId: "ou_a", displayName: "Alice" }])
  assert.deepEqual(calls, ["attached:p1"])
})

// ─── resolveMentionRecipientsByParticipant (Commit 4) ───

test("by-participant: feishu group attached lookup, keyed by participantId", async () => {
  const calls: string[] = []
  const deps = makeDeps({
    loadAttachedAddress: async ({ conversationParticipantId }) => {
      calls.push(`attached:${conversationParticipantId}`)
      return { externalId: "ou_a", displayName: "Alice" }
    },
    loadReachableAddress: async () => {
      throw new Error("should not be called for groups")
    },
  })
  const msg = buildCanonicalMessage([
    { type: "mention", participantId: "p1", displayName: "alice" },
    { type: "text", text: "hi" },
  ])
  const out = await resolveMentionRecipientsByParticipant(
    {
      parts: msg.parts,
      capabilities: FEISHU_MESSAGE_CAPABILITIES,
      transportAccountId: "acc",
      endpointType: "group",
      endpointExternalId: "oc_g",
    },
    deps
  )
  assert.equal(out.size, 1)
  assert.deepEqual(out.get("p1"), {
    externalId: "ou_a",
    displayName: "Alice",
  })
  assert.deepEqual(calls, ["attached:p1"])
})

test("by-participant: feishu direct uses reachable lookup when policy != attached_only", async () => {
  // Compose a synthetic capability with a non-attached direct policy that
  // still has supportsMention; ensures the function routes to reachable.
  const caps = {
    ...FEISHU_MESSAGE_CAPABILITIES,
    directMentionPolicy: "self_only" as const,
  }
  const calls: string[] = []
  const deps = makeDeps({
    loadAttachedAddress: async () => {
      throw new Error("should not be called when policy != attached_only")
    },
    loadReachableAddress: async ({ conversationParticipantId }) => {
      calls.push(`reachable:${conversationParticipantId}`)
      return { externalId: "ou_target", displayName: "Bob" }
    },
  })
  const msg = buildCanonicalMessage([
    { type: "mention", participantId: "p1", displayName: "Bob" },
  ])
  const out = await resolveMentionRecipientsByParticipant(
    {
      parts: msg.parts,
      capabilities: caps,
      transportAccountId: "acc",
      endpointType: "direct",
      endpointExternalId: "ou_target",
    },
    deps
  )
  assert.equal(out.size, 1)
  assert.deepEqual(out.get("p1"), {
    externalId: "ou_target",
    displayName: "Bob",
  })
  assert.deepEqual(calls, ["reachable:p1"])
})

test("by-participant: self_only direct filters non-peer addresses", async () => {
  const deps = makeDeps({
    loadReachableAddress: async () => ({
      externalId: "wx_other",
      displayName: "Other",
    }),
  })
  const msg = buildCanonicalMessage([
    { type: "mention", participantId: "p1", displayName: "x" },
  ])
  const out = await resolveMentionRecipientsByParticipant(
    {
      parts: msg.parts,
      capabilities: WEIXIN_MESSAGE_CAPABILITIES,
      transportAccountId: "acc",
      endpointType: "direct",
      endpointExternalId: "wx_target",
    },
    deps
  )
  assert.equal(out.size, 0)
})

test("by-participant: two parts with same participantId → one lookup, one map entry", async () => {
  let lookupCount = 0
  const deps = makeDeps({
    loadAttachedAddress: async () => {
      lookupCount++
      return { externalId: "ou_a", displayName: "Alice" }
    },
  })
  const msg = buildCanonicalMessage([
    { type: "mention", participantId: "p1", displayName: "first" },
    { type: "text", text: " and again " },
    { type: "mention", participantId: "p1", displayName: "second" },
  ])
  const out = await resolveMentionRecipientsByParticipant(
    {
      parts: msg.parts,
      capabilities: FEISHU_MESSAGE_CAPABILITIES,
      transportAccountId: "acc",
      endpointType: "group",
      endpointExternalId: "oc_g",
    },
    deps
  )
  assert.equal(out.size, 1)
  assert.equal(
    lookupCount,
    1,
    "second mention with same participantId is not re-looked-up"
  )
  assert.deepEqual(out.get("p1"), {
    externalId: "ou_a",
    displayName: "Alice",
  })
})

test("by-participant: null address lookup → participant absent from map", async () => {
  const deps = makeDeps({
    loadAttachedAddress: async () => null,
  })
  const msg = buildCanonicalMessage([
    { type: "mention", participantId: "p_missing", displayName: "Ghost" },
  ])
  const out = await resolveMentionRecipientsByParticipant(
    {
      parts: msg.parts,
      capabilities: FEISHU_MESSAGE_CAPABILITIES,
      transportAccountId: "acc",
      endpointType: "group",
      endpointExternalId: "oc_g",
    },
    deps
  )
  assert.equal(out.size, 0)
})

test("by-participant: mention without participantId is skipped (inbound-mirrored)", async () => {
  let lookupCount = 0
  const deps = makeDeps({
    loadAttachedAddress: async () => {
      lookupCount++
      return null
    },
  })
  const msg = buildCanonicalMessage([
    { type: "mention", externalId: "ou_already", displayName: "X" },
  ])
  const out = await resolveMentionRecipientsByParticipant(
    {
      parts: msg.parts,
      capabilities: FEISHU_MESSAGE_CAPABILITIES,
      transportAccountId: "acc",
      endpointType: "group",
      endpointExternalId: "oc_g",
    },
    deps
  )
  assert.equal(out.size, 0)
  assert.equal(lookupCount, 0)
})

test(
  "by-participant: whitespace-only part displayName + address has displayName " +
    "→ map entry uses the address displayName (not whitespace)",
  async () => {
    const deps = makeDeps({
      loadAttachedAddress: async () => ({
        externalId: "ou_a",
        displayName: "Alice",
      }),
    })
    const msg = buildCanonicalMessage([
      { type: "mention", participantId: "p1", displayName: "   " },
    ])
    const out = await resolveMentionRecipientsByParticipant(
      {
        parts: msg.parts,
        capabilities: FEISHU_MESSAGE_CAPABILITIES,
        transportAccountId: "acc",
        endpointType: "group",
        endpointExternalId: "oc_g",
      },
      deps
    )
    assert.equal(out.get("p1")?.displayName, "Alice")
  }
)

test(
  "by-participant: whitespace-only part displayName + address has no displayName " +
    "→ map entry falls back to externalId (not whitespace)",
  async () => {
    const deps = makeDeps({
      loadAttachedAddress: async () => ({ externalId: "ou_a" }),
    })
    const msg = buildCanonicalMessage([
      { type: "mention", participantId: "p1", displayName: "   " },
    ])
    const out = await resolveMentionRecipientsByParticipant(
      {
        parts: msg.parts,
        capabilities: FEISHU_MESSAGE_CAPABILITIES,
        transportAccountId: "acc",
        endpointType: "group",
        endpointExternalId: "oc_g",
      },
      deps
    )
    assert.equal(out.get("p1")?.displayName, "ou_a")
  }
)

test(
  "by-participant: two distinct participants resolving to the same externalId " +
    "→ both kept as separate map entries",
  async () => {
    const deps = makeDeps({
      loadAttachedAddress: async ({ conversationParticipantId }) => ({
        externalId: "ou_shared",
        displayName: conversationParticipantId === "p1" ? "FromP1" : "FromP2",
      }),
    })
    const msg = buildCanonicalMessage([
      { type: "mention", participantId: "p1", displayName: "Alice" },
      { type: "mention", participantId: "p2", displayName: "Bob" },
    ])
    const out = await resolveMentionRecipientsByParticipant(
      {
        parts: msg.parts,
        capabilities: FEISHU_MESSAGE_CAPABILITIES,
        transportAccountId: "acc",
        endpointType: "group",
        endpointExternalId: "oc_g",
      },
      deps
    )
    assert.equal(out.size, 2)
    assert.equal(out.get("p1")?.externalId, "ou_shared")
    assert.equal(out.get("p2")?.externalId, "ou_shared")
  }
)
