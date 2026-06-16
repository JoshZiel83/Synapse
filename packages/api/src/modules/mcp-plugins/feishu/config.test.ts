import test from "node:test"
import assert from "node:assert/strict"
import { parseFeishuAuthConnectionRef } from "./config.js"

test("parseFeishuAuthConnectionRef accepts auth connection refs", () => {
  assert.deepEqual(
    parseFeishuAuthConnectionRef({
      __kind: "auth_connection_ref",
      connectionId: "conn-1",
      ignored: true,
    }),
    {
      __kind: "auth_connection_ref",
      connectionId: "conn-1",
    }
  )
})

test("parseFeishuAuthConnectionRef rejects non-object or malformed refs", () => {
  assert.equal(parseFeishuAuthConnectionRef(undefined), null)
  assert.equal(parseFeishuAuthConnectionRef(null), null)
  assert.equal(parseFeishuAuthConnectionRef([]), null)
  assert.equal(parseFeishuAuthConnectionRef('{"connectionId":"conn-1"}'), null)
  assert.equal(
    parseFeishuAuthConnectionRef({
      __kind: "other",
      connectionId: "conn-1",
    }),
    null
  )
  assert.equal(
    parseFeishuAuthConnectionRef({
      __kind: "auth_connection_ref",
      connectionId: 123,
    }),
    null
  )
})
