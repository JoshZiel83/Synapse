/**
 * S24: chat controller schemas must derive from shared enums, not
 * inline string literals. Regression guards that future controllers
 * don't sneak `z.enum(["ios","android","web"])` or
 * `z.enum(["started","stopped"])` back in.
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
  "src",
  "modules",
  "chat",
  "controller.ts"
)

test("chat controller imports CHAT_TYPING_STATES + PUSH_TOKEN_PLATFORMS from shared", async () => {
  const body = await readFile(chatControllerPath, "utf8")
  assert.match(
    body,
    /import \{[^}]*CHAT_TYPING_STATES[^}]*\}\s+from\s+"@synapse\/shared"/s,
    "controller.ts must import CHAT_TYPING_STATES from @synapse/shared"
  )
  assert.match(
    body,
    /import \{[^}]*PUSH_TOKEN_PLATFORMS[^}]*\}\s+from\s+"@synapse\/shared"/s,
    "controller.ts must import PUSH_TOKEN_PLATFORMS from @synapse/shared"
  )
})

test("chat controller does not redeclare typing-state or push-platform literals", async () => {
  const body = await readFile(chatControllerPath, "utf8")
  const typingLiteral = /z\.enum\(\[\s*"started"\s*,\s*"stopped"\s*\]\)/
  const pushLiteral = /z\.enum\(\[\s*"ios"\s*,\s*"android"\s*,\s*"web"\s*\]\)/
  assert.equal(
    typingLiteral.test(body),
    false,
    'controller.ts must not inline ["started","stopped"] — use CHAT_TYPING_STATES'
  )
  assert.equal(
    pushLiteral.test(body),
    false,
    'controller.ts must not inline ["ios","android","web"] — use PUSH_TOKEN_PLATFORMS'
  )
})

test("shared push-platform and typing-state tuples are stable", () => {
  // If a value is added/removed, the test breaks loudly so DB enum
  // migrations and client-side switches can be updated atomically.
  assert.deepEqual([...PUSH_TOKEN_PLATFORMS], ["ios", "android", "web"])
  assert.deepEqual([...CHAT_TYPING_STATES], ["started", "stopped"])
})
