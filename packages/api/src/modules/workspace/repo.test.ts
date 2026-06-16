import assert from "node:assert/strict"
import test from "node:test"

import { parseStoredActorDocs } from "./repo.js"

test("parseStoredActorDocs decodes stored actor docs at repo exit", () => {
  const docs = parseStoredActorDocs(
    JSON.stringify([
      {
        id: "00000000-0000-4000-8000-000000000001",
        key: "custom",
        title: "Mission",
        content: [{ type: "text", text: "Coordinate workspace work." }],
        visibility: "always",
        priority: 1,
      },
    ])
  )

  assert.equal(docs.length, 1)
  assert.equal(docs[0]?.title, "Mission")
  assert.equal(docs[0]?.content[0]?.type, "text")
})

test("parseStoredActorDocs fails closed on malformed stored docs", () => {
  assert.throws(
    () => parseStoredActorDocs("{not json"),
    /must be a valid JSON array/
  )
  assert.throws(
    () => parseStoredActorDocs({ docs: [] }),
    /must be a JSON array/
  )
  assert.throws(
    () =>
      parseStoredActorDocs(
        JSON.stringify([
          {
            key: "custom",
            title: "Invalid",
            content: "not-an-array",
            visibility: "always",
            priority: 1,
          },
        ])
      ),
    /must contain actor doc inputs/
  )
  assert.throws(
    () =>
      parseStoredActorDocs(
        JSON.stringify([
          {
            key: "custom",
            title: "Invalid",
            content: [{ type: "text" }],
            visibility: "always",
            priority: 1,
          },
        ])
      ),
    /must contain actor doc inputs/
  )
  assert.deepEqual(parseStoredActorDocs(null), [])
})
