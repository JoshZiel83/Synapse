import { test } from "node:test"
import assert from "node:assert/strict"
import { parsePrefixedJson } from "./http.js"

test("parsePrefixedJson accepts prefixed Mijia JSON objects", () => {
  assert.deepEqual(parsePrefixedJson('&&&START&&&{"code":0,"qr":"url"}'), {
    code: 0,
    qr: "url",
  })
})

test("parsePrefixedJson accepts unprefixed JSON objects", () => {
  assert.deepEqual(parsePrefixedJson('{"location":"https://example.com"}'), {
    location: "https://example.com",
  })
})

test("parsePrefixedJson rejects invalid JSON", () => {
  assert.throws(
    () => parsePrefixedJson("&&&START&&&{"),
    /Mijia response is invalid JSON/
  )
})

test("parsePrefixedJson rejects non-object provider payloads", () => {
  for (const raw of ["[]", "null", '"ok"', "1", "true"]) {
    assert.throws(
      () => parsePrefixedJson(`&&&START&&&${raw}`),
      /Mijia response JSON must be an object/
    )
  }
})
