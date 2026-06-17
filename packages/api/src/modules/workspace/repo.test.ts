import assert from "node:assert/strict"
import test from "node:test"

import { parseStoredActorDocs, parseWorkspaceJsonRecord } from "./repo.js"

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

test("parseWorkspaceJsonRecord decodes workspace DB JSON objects at repo exit", () => {
  assert.deepEqual(
    parseWorkspaceJsonRecord(
      JSON.stringify({ is_chief_actor: true }),
      "workspace actor template config"
    ),
    { is_chief_actor: true }
  )
  assert.deepEqual(parseWorkspaceJsonRecord(null, "workspace actor config"), {})
})

test("parseWorkspaceJsonRecord rejects malformed or non-object workspace DB JSON", () => {
  assert.throws(
    () => parseWorkspaceJsonRecord("not json", "workspace actor config"),
    /workspace actor config must be a valid JSON object/
  )
  assert.throws(
    () =>
      parseWorkspaceJsonRecord(
        JSON.stringify(["not-object"]),
        "workspace actor config"
      ),
    /workspace actor config must be a JSON object/
  )
  assert.throws(
    () =>
      parseWorkspaceJsonRecord(
        JSON.stringify(42),
        "workspace actor template config"
      ),
    /workspace actor template config must be a JSON object/
  )
})
