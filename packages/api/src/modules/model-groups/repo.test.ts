import test from "node:test"
import assert from "node:assert/strict"
import {
  decodeNullableModelGroupJsonRecord,
  normalizeModelGroupItemJson,
  normalizeModelGroupRowJson,
} from "./repo.js"

test("decodeNullableModelGroupJsonRecord decodes model-group JSON records at repo exit", () => {
  assert.deepEqual(
    decodeNullableModelGroupJsonRecord('{"apiStyle":"responses"}'),
    { apiStyle: "responses" }
  )
  assert.deepEqual(
    decodeNullableModelGroupJsonRecord({ provider: { timeoutMs: 5000 } }),
    { provider: { timeoutMs: 5000 } }
  )
  assert.equal(decodeNullableModelGroupJsonRecord(null), null)
  assert.equal(decodeNullableModelGroupJsonRecord(undefined), null)
  assert.throws(
    () => decodeNullableModelGroupJsonRecord("not json"),
    /model group JSON record must be valid JSON/
  )
  assert.throws(
    () => decodeNullableModelGroupJsonRecord("[1,2,3]"),
    /model group JSON record must be a JSON object/
  )
  assert.throws(
    () => decodeNullableModelGroupJsonRecord("42"),
    /model group JSON record must be a JSON object/
  )
})

test("normalizeModelGroupRowJson decodes attemptPolicy at repo exit", () => {
  const row = normalizeModelGroupRowJson({
    id: "group-1",
    attemptPolicy: JSON.stringify({
      maxAttemptsTotal: 3,
      continueOn: ["timeout"],
    }),
  })

  assert.deepEqual(row.attemptPolicy, {
    maxAttemptsTotal: 3,
    continueOn: ["timeout"],
  })
})

test("normalizeModelGroupItemJson decodes feature and provider option JSON at repo exit", () => {
  const row = normalizeModelGroupItemJson({
    id: "item-1",
    features: JSON.stringify({ apiStyle: "responses" }),
    providerOptions: { temperature: 0.2 },
  })

  assert.deepEqual(row.features, { apiStyle: "responses" })
  assert.deepEqual(row.providerOptions, { temperature: 0.2 })
})
