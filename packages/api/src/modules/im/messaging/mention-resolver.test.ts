import test from "node:test"
import assert from "node:assert/strict"
import { buildCanonicalMessage } from "./canonical-message.js"
import { FEISHU_MESSAGE_CAPABILITIES } from "../connectors/feishu/capabilities.js"
import { WEIXIN_MESSAGE_CAPABILITIES } from "../connectors/weixin/capabilities.js"
import {
  resolveMentionRecipients,
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
