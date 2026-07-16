import test from "node:test"
import assert from "node:assert/strict"
import { z } from "zod"
import {
  isExpectedClientError,
  isMalformedUuidDatabaseError,
} from "./request-error-classification.js"

// These predicates must mirror the setErrorHandler classification in
// src/index.ts exactly (ZodError | 22P02-uuid | statusCode 400–499 ⇒ 4xx);
// the Sentry onError gate suppresses precisely this set, so a drift here
// silently either spams Sentry with 400s or swallows real 500s.

test("isMalformedUuidDatabaseError: 22P02 with uuid message", () => {
  const error = Object.assign(
    new Error('invalid input syntax for type uuid: "not-a-uuid"'),
    { code: "22P02" }
  )
  assert.equal(isMalformedUuidDatabaseError(error), true)
  assert.equal(isExpectedClientError(error), true)
})

test("isMalformedUuidDatabaseError: bare 22P02 without uuid message is not matched", () => {
  const error = Object.assign(new Error("invalid input syntax for type json"), {
    code: "22P02",
  })
  assert.equal(isMalformedUuidDatabaseError(error), false)
  // setErrorHandler maps this to 500 (no statusCode), so it is NOT expected.
  assert.equal(isExpectedClientError(error), false)
})

test("isMalformedUuidDatabaseError: non-objects", () => {
  assert.equal(isMalformedUuidDatabaseError(null), false)
  assert.equal(isMalformedUuidDatabaseError(undefined), false)
  assert.equal(isMalformedUuidDatabaseError("22P02"), false)
})

test("isExpectedClientError: ZodError", () => {
  const result = z.object({ id: z.string() }).safeParse({ id: 1 })
  assert.equal(result.success, false)
  if (result.success) return
  assert.equal(isExpectedClientError(result.error), true)
})

test("isExpectedClientError: statusCode 400–499 only", () => {
  const withStatus = (statusCode: unknown) =>
    Object.assign(new Error("boom"), { statusCode })
  assert.equal(isExpectedClientError(withStatus(400)), true)
  assert.equal(isExpectedClientError(withStatus(404)), true)
  assert.equal(isExpectedClientError(withStatus(499)), true)
  assert.equal(isExpectedClientError(withStatus(399)), false)
  assert.equal(isExpectedClientError(withStatus(500)), false)
  // setErrorHandler's typeof check: a stringly statusCode falls through to 500.
  assert.equal(isExpectedClientError(withStatus("404")), false)
})

test("isExpectedClientError: plain errors and non-objects", () => {
  assert.equal(isExpectedClientError(new Error("boom")), false)
  assert.equal(isExpectedClientError(null), false)
  assert.equal(isExpectedClientError(undefined), false)
})
