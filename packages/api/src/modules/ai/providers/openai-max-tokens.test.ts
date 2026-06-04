import test from "node:test"
import assert from "node:assert/strict"
import { openAiMaxTokensField } from "./openai.js"

// The gpt-5 family and the o-series reasoning models REJECT the legacy
// `max_tokens` param (HTTP 400) and require `max_completion_tokens`. Older
// gpt-4*/gpt-3.5* still use `max_tokens`. This guards the model-id detection
// that picks the right key in the Chat Completions request body.

test("gpt-5 family uses max_completion_tokens", () => {
  for (const m of [
    "gpt-5",
    "gpt-5.5",
    "gpt-5.5-2026-04-24",
    "GPT-5.5",
    "openai/gpt-5.1",
  ]) {
    assert.equal(openAiMaxTokensField(m), "max_completion_tokens", m)
  }
})

test("o-series reasoning models use max_completion_tokens", () => {
  for (const m of ["o1", "o1-mini", "o3", "o3-mini", "o4-mini"]) {
    assert.equal(openAiMaxTokensField(m), "max_completion_tokens", m)
  }
})

test("legacy gpt-4 / gpt-3.5 models keep max_tokens", () => {
  for (const m of ["gpt-4.1", "gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"]) {
    assert.equal(openAiMaxTokensField(m), "max_tokens", m)
  }
})
