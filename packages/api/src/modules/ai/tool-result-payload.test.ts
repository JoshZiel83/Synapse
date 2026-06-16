import assert from "node:assert/strict"
import test from "node:test"

import {
  readToolResultOrigin,
  readToolResultStructuredContent,
} from "./tool-result-payload.js"

test("readToolResultStructuredContent accepts only object payloads", () => {
  assert.deepEqual(
    readToolResultStructuredContent({
      structuredContent: { count: 2 },
    }),
    { count: 2 }
  )
  assert.equal(
    readToolResultStructuredContent({ structuredContent: ["bad"] }),
    undefined
  )
  assert.equal(
    readToolResultStructuredContent({ structuredContent: "bad" }),
    undefined
  )
  assert.equal(readToolResultStructuredContent(null), undefined)
})

test("readToolResultOrigin accepts only shared tool result origins", () => {
  assert.deepEqual(
    readToolResultOrigin({
      origin: { kind: "system", registryKey: "memory_search" },
    }),
    { kind: "system", registryKey: "memory_search" }
  )
  assert.deepEqual(
    readToolResultOrigin({
      origin: {
        kind: "plugin",
        installationId: "plugin-1",
        upstreamToolName: "search",
      },
    }),
    { kind: "plugin", installationId: "plugin-1", upstreamToolName: "search" }
  )
  assert.equal(readToolResultOrigin({ origin: { kind: "unknown" } }), undefined)
  assert.equal(readToolResultOrigin("bad"), undefined)
})
