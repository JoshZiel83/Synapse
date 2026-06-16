import test from "node:test"
import assert from "node:assert/strict"
import { normalizePdfParseMetadata } from "./parse-metadata.js"

test("normalizePdfParseMetadata accepts object metadata and page count", () => {
  assert.deepEqual(
    normalizePdfParseMetadata({
      info: { Title: "Demo" },
      metadata: { Producer: "pdf-parse" },
      numpages: 3,
    }),
    {
      info: { Title: "Demo" },
      metadata: { Producer: "pdf-parse" },
      numPages: 3,
    }
  )
})

test("normalizePdfParseMetadata rejects non-object metadata shapes", () => {
  assert.deepEqual(
    normalizePdfParseMetadata({
      info: ["not-object"],
      metadata: 42,
      numpages: "3",
    }),
    {
      info: undefined,
      metadata: undefined,
      numPages: undefined,
    }
  )
})

test("normalizePdfParseMetadata preserves JSON-string object compatibility", () => {
  assert.deepEqual(
    normalizePdfParseMetadata({
      info: '{"Title":"Demo"}',
      metadata: '{"Producer":"pdf-parse"}',
      numpages: 1,
    }),
    {
      info: { Title: "Demo" },
      metadata: { Producer: "pdf-parse" },
      numPages: 1,
    }
  )
})
