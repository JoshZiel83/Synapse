import test from "node:test"
import assert from "node:assert/strict"
import {
  parseFeishuProviderJsonObjectText,
  resolveFeishuEmail,
} from "./better-auth.js"

// Regression for the production `email_is_missing` failure: Feishu returns an
// EMPTY STRING email (not null), `??` does not fall through on "", so the blank
// reached BA's generic-oauth callback and aborted the whole login.

test("resolveFeishuEmail: blank email ('') synthesizes @feishu.local (the prod bug)", () => {
  const email = resolveFeishuEmail({
    email: "",
    open_id: "ou_abc",
    union_id: "on_xyz",
  })
  assert.equal(email, "ou_abc@feishu.local")
})

test("resolveFeishuEmail: whitespace-only email is treated as absent", () => {
  const email = resolveFeishuEmail({
    email: "   ",
    open_id: "ou_abc",
    union_id: "on_xyz",
  })
  assert.equal(email, "ou_abc@feishu.local")
})

test("resolveFeishuEmail: missing email + missing open_id falls back to union_id", () => {
  const email = resolveFeishuEmail({ union_id: "on_xyz" })
  assert.equal(email, "on_xyz@feishu.local")
})

test("resolveFeishuEmail: real email is preferred and trimmed", () => {
  const email = resolveFeishuEmail({
    email: "  user@corp.com ",
    open_id: "ou_abc",
    union_id: "on_xyz",
  })
  assert.equal(email, "user@corp.com")
})

test("resolveFeishuEmail: falls back to enterprise_email when personal email blank", () => {
  const email = resolveFeishuEmail({
    email: "",
    enterprise_email: "user@enterprise.com",
    open_id: "ou_abc",
    union_id: "on_xyz",
  })
  assert.equal(email, "user@enterprise.com")
})

test("parseFeishuProviderJsonObjectText accepts only JSON object responses", () => {
  assert.deepEqual(parseFeishuProviderJsonObjectText('{"code":0}'), {
    ok: true,
    body: { code: 0 },
  })

  for (const text of ["{not-json", "[1,2,3]", "null", '"ok"', ""]) {
    assert.deepEqual(parseFeishuProviderJsonObjectText(text), {
      ok: false,
      message: "malformed_response",
    })
  }
})
