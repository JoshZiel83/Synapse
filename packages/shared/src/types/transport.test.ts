import test from "node:test"
import assert from "node:assert/strict"
import { describeTransportKind, isTransportKind } from "../constants/enums.js"
import { TRANSPORT_KINDS } from "../constants/enums.js"

test("isTransportKind: accepts every value in TRANSPORT_KINDS", () => {
  for (const kind of TRANSPORT_KINDS) {
    assert.equal(isTransportKind(kind), true, `expected ${kind} to be valid`)
  }
})

test("isTransportKind: rejects strings outside the enum", () => {
  for (const v of [
    "",
    "Feishu",
    "FEISHU",
    "wechat",
    "unknown",
    "telegram_bot",
  ]) {
    assert.equal(isTransportKind(v), false, `expected ${v} to be rejected`)
  }
})

test("isTransportKind: rejects non-string values", () => {
  for (const v of [undefined, null, 0, 1, true, false, {}, [], () => {}]) {
    assert.equal(isTransportKind(v), false)
  }
})

test("describeTransportKind: returns canonical user-facing label", () => {
  assert.equal(describeTransportKind("feishu"), "Feishu")
  assert.equal(describeTransportKind("weixin"), "WeChat")
  assert.equal(describeTransportKind("wecom"), "WeCom")
})

test("describeTransportKind: covers every TRANSPORT_KINDS value (no fallthrough)", () => {
  // If a new TransportKind is added to the enum without updating
  // describeTransportKind's switch, the exhaustiveness check there
  // will turn into a type error AND this loop will surface the
  // missing label at runtime.
  for (const kind of TRANSPORT_KINDS) {
    const label = describeTransportKind(kind)
    assert.ok(label && typeof label === "string" && label.length > 0)
  }
})
