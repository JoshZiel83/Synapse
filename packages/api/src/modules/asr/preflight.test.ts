import test from "node:test"
import assert from "node:assert/strict"
import { z } from "zod"
import {
  AsrConcurrencyLimitError,
  AsrNotConfiguredError,
  startErrorCode,
  startErrorMessage,
  startRetryable,
} from "./preflight.js"

// The start() preflight mapping is generic (shared by every provider) and, before
// the abstraction, was dead code (the throws happened before the emitting try).
// These assertions pin the now-live, provider-neutral behavior.
test("startErrorCode maps the operational preflight failures", () => {
  assert.equal(startErrorCode(new z.ZodError([])), "ASR_INVALID_AUDIO_CONFIG")
  assert.equal(
    startErrorCode(new AsrConcurrencyLimitError()),
    "ASR_CONCURRENCY_LIMIT_REACHED"
  )
  assert.equal(
    startErrorCode(new AsrNotConfiguredError("nope")),
    "ASR_UPSTREAM_CONNECT_FAILED"
  )
  assert.equal(startErrorCode(new Error("boom")), "ASR_UPSTREAM_CONNECT_FAILED")
})

test("startRetryable: invalid-config and not-configured are terminal; concurrency/upstream are transient", () => {
  assert.equal(startRetryable(new z.ZodError([])), false)
  assert.equal(startRetryable(new AsrNotConfiguredError("nope")), false)
  assert.equal(startRetryable(new AsrConcurrencyLimitError()), true)
  assert.equal(startRetryable(new Error("upstream")), true)
})

test("startErrorMessage surfaces the underlying message", () => {
  assert.match(
    startErrorMessage(new AsrNotConfiguredError("not configured here")),
    /not configured here/
  )
  assert.equal(
    startErrorMessage(new AsrConcurrencyLimitError()),
    "ASR concurrency limit reached"
  )
})
