// Unit tests for the Synapse-owned bits of the AI-SDK provider layer.
// (Provider WIRE serialization is now the AI SDK's job and is validated by the
// live migration spikes, not re-tested here — that would be testing the SDK.)
import test from "node:test"
import assert from "node:assert/strict"

import { bigModelChatBase } from "./get-language-model.js"
import { toLanguageModelSpec } from "./to-language-model-spec.js"
import { reconcileToolPairing } from "./reconcile-tool-pairing.js"
import type { ConversationMessage, ResolvedModelConfig } from "@synapse/shared"

test("bigModelChatBase normalizes all three baseUrl shapes to /paas/v4", () => {
  assert.equal(
    bigModelChatBase("https://open.bigmodel.cn/api"),
    "https://open.bigmodel.cn/api/paas/v4"
  )
  assert.equal(
    bigModelChatBase("https://open.bigmodel.cn/api/paas/v4"),
    "https://open.bigmodel.cn/api/paas/v4"
  )
  assert.equal(
    bigModelChatBase("https://open.bigmodel.cn/api/paas/v4/chat/completions"),
    "https://open.bigmodel.cn/api/paas/v4"
  )
  // trailing slash tolerated
  assert.equal(
    bigModelChatBase("https://open.bigmodel.cn/api/paas/v4/"),
    "https://open.bigmodel.cn/api/paas/v4"
  )
})

function baseResolved(over: Partial<ResolvedModelConfig>): ResolvedModelConfig {
  return {
    groupId: "g",
    profileId: "p",
    profileRevisionId: "r",
    providerType: "anthropic",
    engineKind: "anthropic.messages",
    apiKey: "k",
    baseUrl: "http://x",
    modelName: "m",
    maxTokens: 1024,
    ...over,
  } as ResolvedModelConfig
}

test("toLanguageModelSpec derives providerKind/apiStyle from legacy fields", () => {
  assert.deepEqual(
    toLanguageModelSpec(
      baseResolved({
        providerType: "anthropic",
        engineKind: "anthropic.messages",
      })
    ),
    {
      providerKind: "anthropic",
      vendor: "anthropic",
      apiStyle: "chat",
      baseUrl: "http://x",
      apiKey: "k",
      modelName: "m",
    }
  )
  assert.equal(
    toLanguageModelSpec(
      baseResolved({
        providerType: "openai",
        engineKind: "openai.chat_completions",
      })
    ).apiStyle,
    "chat"
  )
  assert.equal(
    toLanguageModelSpec(
      baseResolved({ providerType: "openai", engineKind: "openai.responses" })
    ).apiStyle,
    "responses"
  )
  const compat = toLanguageModelSpec(
    baseResolved({
      providerType: "bigmodel",
      engineKind: "bigmodel.chat_completions",
    })
  )
  assert.equal(compat.providerKind, "openai_compatible")
  assert.equal(compat.vendor, "bigmodel")
})

test("reconcileToolPairing synthesizes a result for an orphan tool-call", () => {
  const messages: ConversationMessage[] = [
    { role: "user", content: [] },
    {
      role: "assistant",
      content: [],
      toolCalls: [{ callId: "c1", toolName: "t", input: {} }],
    },
    // no tool_result follows → orphan
  ]
  const out = reconcileToolPairing(messages)
  assert.equal(out.length, 3)
  const last = out[2]
  assert.equal(last.role, "tool_result")
  if (last.role === "tool_result") {
    assert.equal(last.results.length, 1)
    assert.equal(last.results[0].toolCallId, "c1")
    assert.equal(last.results[0].isError, true)
  }
})

test("reconcileToolPairing is a no-op when every tool-call has a result", () => {
  const messages: ConversationMessage[] = [
    {
      role: "assistant",
      content: [],
      toolCalls: [{ callId: "c1", toolName: "t", input: {} }],
    },
    {
      role: "tool_result",
      results: [{ toolCallId: "c1", toolName: "t", content: [] }],
    },
  ]
  const out = reconcileToolPairing(messages)
  assert.equal(out.length, 2)
})
