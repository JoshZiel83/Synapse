import assert from "node:assert/strict"
import test from "node:test"

import { readProviderImageBlocks } from "./content-ingest.js"

test("readProviderImageBlocks keeps only provider image objects", () => {
  const imageBlock = {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: "abc123",
    },
  }

  assert.deepEqual(
    readProviderImageBlocks([
      null,
      "image",
      ["image"],
      { type: "text", text: "ignored" },
      { type: "image" },
      imageBlock,
    ]),
    [{ type: "image" }, imageBlock]
  )
})
