import test from "node:test"
import assert from "node:assert/strict"
import {
  extractSecretTokenHeader,
  timingSafeEqualStr,
  verifyTelegramWebhookSecret,
} from "./webhook-signature.js"

test("extractSecretTokenHeader: lowercase + canonical + array", () => {
  assert.equal(
    extractSecretTokenHeader({ "x-telegram-bot-api-secret-token": "abc" }),
    "abc"
  )
  assert.equal(
    extractSecretTokenHeader({ "X-Telegram-Bot-Api-Secret-Token": "xyz" }),
    "xyz"
  )
  assert.equal(
    extractSecretTokenHeader({ "x-telegram-bot-api-secret-token": ["a", "b"] }),
    "a"
  )
  assert.equal(extractSecretTokenHeader({}), undefined)
})

test("timingSafeEqualStr: equal, unequal, length-mismatch", () => {
  assert.equal(timingSafeEqualStr("secret", "secret"), true)
  assert.equal(timingSafeEqualStr("secret", "Secret"), false)
  assert.equal(timingSafeEqualStr("a", "ab"), false)
})

test("verifyTelegramWebhookSecret: header match", () => {
  assert.equal(
    verifyTelegramWebhookSecret({
      headers: { "x-telegram-bot-api-secret-token": "s3cr3t" },
      expected: "s3cr3t",
    }),
    true
  )
})

test("verifyTelegramWebhookSecret: mismatch / missing", () => {
  assert.equal(
    verifyTelegramWebhookSecret({
      headers: { "x-telegram-bot-api-secret-token": "wrong" },
      expected: "s3cr3t",
    }),
    false
  )
  assert.equal(
    verifyTelegramWebhookSecret({ headers: {}, expected: "s3cr3t" }),
    false
  )
  assert.equal(
    verifyTelegramWebhookSecret({
      headers: { "x-telegram-bot-api-secret-token": "s" },
      expected: undefined,
    }),
    false
  )
})
