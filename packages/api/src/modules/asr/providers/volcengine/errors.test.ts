import test from "node:test"
import assert from "node:assert/strict"
import { mapProviderError } from "./errors.js"

test("mapProviderError marks provider busy as retryable", () => {
  assert.deepEqual(mapProviderError(55000031, { message: "busy" }, "log-1"), {
    code: "ASR_PROVIDER_BUSY",
    message: "busy",
    retryable: true,
    providerCode: 55000031,
    providerLogId: "log-1",
  })
})

test("mapProviderError classifies client (4xxxxxxx) vs server (>=55000000) codes", () => {
  assert.equal(
    mapProviderError(45000001, {}).code,
    "ASR_PROVIDER_INVALID_REQUEST"
  )
  assert.equal(mapProviderError(45000001, {}).retryable, false)
  assert.equal(mapProviderError(45000002, {}).code, "ASR_PROVIDER_EMPTY_AUDIO")
  assert.equal(mapProviderError(45000151, {}).retryable, false)

  const serverErr = mapProviderError(55000099, {})
  assert.equal(serverErr.code, "ASR_PROVIDER_INTERNAL_ERROR")
  assert.equal(serverErr.retryable, true)

  const genericClient = mapProviderError(45009999, {})
  assert.equal(genericClient.code, "ASR_PROVIDER_ERROR")
  assert.equal(genericClient.retryable, false)
})
