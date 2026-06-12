/**
 * S24: chat request schemas must derive from shared enums, not inline string
 * literals. Round-6 P1-2 moved the chat request bodies (typing / push-token /
 * etc.) from the API controller into @synapse/shared/schemas/chat.ts as the
 * schema-first source, so this guard now targets the shared chat schema (which
 * imports the enums) + still guards the controller against re-inlining literals.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { CHAT_TYPING_STATES, PUSH_TOKEN_PLATFORMS } from "@synapse/shared"

const here = path.dirname(fileURLToPath(import.meta.url))
const chatControllerPath = path.resolve(
  here,
  "..",
  "..",
  "modules",
  "chat",
  "controller.ts"
)
// The chat request schemas now live in the shared package (round-6 P1-2):
// packages/api/src/test/regression → repo packages/shared/src/schemas/chat.ts.
const sharedChatSchemaPath = path.resolve(
  here,
  "..",
  "..",
  "..",
  "..",
  "shared",
  "src",
  "schemas",
  "chat.ts"
)

test("shared chat schema imports CHAT_TYPING_STATES + PUSH_TOKEN_PLATFORMS from the enum source", async () => {
  const body = await readFile(sharedChatSchemaPath, "utf8")
  assert.match(
    body,
    /import \{[^}]*CHAT_TYPING_STATES[^}]*\}\s+from\s+"\.\.\/constants\/enums\.js"/s,
    "schemas/chat.ts must import CHAT_TYPING_STATES from the shared enum source"
  )
  assert.match(
    body,
    /import \{[^}]*PUSH_TOKEN_PLATFORMS[^}]*\}\s+from\s+"\.\.\/constants\/enums\.js"/s,
    "schemas/chat.ts must import PUSH_TOKEN_PLATFORMS from the shared enum source"
  )
})

test("neither chat controller nor shared chat schema inline typing/push literals", async () => {
  const typingLiteral = /z\.enum\(\[\s*"started"\s*,\s*"stopped"\s*\]\)/
  const pushLiteral = /z\.enum\(\[\s*"ios"\s*,\s*"android"\s*,\s*"web"\s*\]\)/
  for (const p of [chatControllerPath, sharedChatSchemaPath]) {
    const body = await readFile(p, "utf8")
    assert.equal(
      typingLiteral.test(body),
      false,
      `${p} must not inline ["started","stopped"] — use CHAT_TYPING_STATES`
    )
    assert.equal(
      pushLiteral.test(body),
      false,
      `${p} must not inline ["ios","android","web"] — use PUSH_TOKEN_PLATFORMS`
    )
  }
})

test("shared push-platform and typing-state tuples are stable", () => {
  // If a value is added/removed, the test breaks loudly so DB enum
  // migrations and client-side switches can be updated atomically.
  assert.deepEqual([...PUSH_TOKEN_PLATFORMS], ["ios", "android", "web"])
  assert.deepEqual([...CHAT_TYPING_STATES], ["started", "stopped"])
})
