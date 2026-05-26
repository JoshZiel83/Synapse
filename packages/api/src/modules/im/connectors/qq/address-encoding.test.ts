import test from "node:test"
import assert from "node:assert/strict"
import {
  decodeGroupOpenidFromMemberId,
  decodeMemberOpenid,
  decodeUserOpenid,
  encodeDirectEndpointExternalId,
  encodeGroupEndpointExternalId,
  encodeSenderExternalId,
} from "./address-encoding.js"

test("C2C sender encode roundtrip", () => {
  const encoded = encodeSenderExternalId({
    kind: "c2c",
    userOpenid: "USER123",
  })
  assert.equal(encoded, "c2c:USER123")
  assert.equal(decodeUserOpenid(encoded), "USER123")
  assert.equal(decodeMemberOpenid(encoded), null)
})

test("group-member sender encode roundtrip", () => {
  const encoded = encodeSenderExternalId({
    kind: "group_member",
    groupOpenid: "GRP1",
    memberOpenid: "MEM1",
  })
  assert.equal(encoded, "gm:GRP1:MEM1")
  assert.equal(decodeMemberOpenid(encoded), "MEM1")
  assert.equal(decodeGroupOpenidFromMemberId(encoded), "GRP1")
  assert.equal(decodeUserOpenid(encoded), null)
})

test("direct endpoint external_id matches C2C sender format", () => {
  assert.equal(encodeDirectEndpointExternalId("USER123"), "c2c:USER123")
})

test("group endpoint external_id is bare group_openid (no prefix)", () => {
  assert.equal(encodeGroupEndpointExternalId("GRP1"), "GRP1")
})

test("decoders return null on unrecognized shapes", () => {
  assert.equal(decodeMemberOpenid("plain-openid"), null)
  assert.equal(decodeMemberOpenid("gm:no-separator"), null)
  assert.equal(decodeMemberOpenid("gm:GRP:"), null)
  assert.equal(decodeUserOpenid(""), null)
  assert.equal(decodeUserOpenid("gm:GRP:MEM"), null)
  assert.equal(decodeGroupOpenidFromMemberId("c2c:USER"), null)
})

test("member_openid containing ':' is preserved (separator is FIRST colon)", () => {
  // Belt-and-suspenders: QQ doesn't put ':' in openids today, but if
  // they ever do the parser should still recover the member portion.
  const encoded = "gm:GRP1:MEM:WITH:COLONS"
  assert.equal(decodeGroupOpenidFromMemberId(encoded), "GRP1")
  assert.equal(decodeMemberOpenid(encoded), "MEM:WITH:COLONS")
})
