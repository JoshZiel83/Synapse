import test from "node:test"
import assert from "node:assert/strict"
import { textBlocks } from "@synapse/shared"
// Import from the pure recall-query module rather than service.js so we
// don't drag in the module-level Redis client (which would block process
// exit on machines without Redis configured).
import { buildMemoryRecallQuery } from "./recall-query.js"

function hasIsolatedSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
        return true
      }
      index += 1
      continue
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true
    }
  }

  return false
}

test("buildMemoryRecallQuery preserves surrogate pairs when truncating long text", () => {
  const latestMessage = `${"a".repeat(236)}🧠xyzz`

  const query = buildMemoryRecallQuery({
    actorName: "Mia",
    contextItems: [
      {
        kind: "message",
        parts: textBlocks(latestMessage),
      } as any,
    ],
  })

  assert.equal(hasIsolatedSurrogate(query), false)
  assert.match(query, /🧠\.\.\.\nactor:Mia$/)
})
