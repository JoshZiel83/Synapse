import test from "node:test"
import assert from "node:assert/strict"
import { extractText } from "@synapse/shared"
import { itemPartsToCanonicalContentBlocks } from "./message-content.js"

test("itemPartsToCanonicalContentBlocks reads Kysely camelCase part rows", () => {
  const blocks = itemPartsToCanonicalContentBlocks([
    {
      partType: "text",
      textValue: "hello from tool_result_parts",
    },
    {
      partType: "file_ref",
      refSha256:
        "0000000000000000000000000000000000000000000000000000000000000001",
      refPath: "/tmp/report.txt",
      mimeType: "text/plain",
      name: "report.txt",
      metadata: {
        sizeBytes: 42,
        category: "document",
      },
    },
  ])

  assert.equal(extractText(blocks), "hello from tool_result_parts")
  assert.equal(blocks[1]?.type, "file_ref")
  assert.equal(blocks[1]?.path, "/tmp/report.txt")
  assert.equal(blocks[1]?.mimeType, "text/plain")
})

test("itemPartsToCanonicalContentBlocks keeps legacy snake_case part rows working", () => {
  const blocks = itemPartsToCanonicalContentBlocks([
    {
      part_type: "text",
      text_value: "legacy archive text",
    },
  ])

  assert.equal(extractText(blocks), "legacy archive text")
})
