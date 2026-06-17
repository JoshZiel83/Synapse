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

test("parseStoredActorDocs accepts partial stored docs and fills normalizer defaults", () => {
  // Regression: official actor-template docs are stored partially (no
  // visibility/priority) and rely on normalizeActorDocs to fill template
  // defaults. A strict schema parse used to throw here and 500 createWorkspace.
  const docs = parseStoredActorDocs(
    JSON.stringify([
      {
        key: "custom",
        title: "Mission",
        content: [{ type: "text", text: "Coordinate workspace work." }],
      },
    ])
  )

  assert.equal(docs.length, 1)
  assert.equal(docs[0]?.title, "Mission")
  assert.equal(docs[0]?.key, "custom")
  assert.ok(typeof docs[0]?.priority === "number")
  assert.ok(docs[0]?.visibility)
})

test("parseStoredActorDocs skips malformed entries instead of throwing", () => {
  // A doc whose content is not an array (or whose blocks are invalid) is
  // dropped by the normalizer, not treated as a fatal error — repo stays
  // resilient to legacy/partial rows while still rejecting non-JSON-array
  // top-level values.
  const docs = parseStoredActorDocs(
    JSON.stringify([
      {
        key: "custom",
        title: "Invalid",
        content: "not-an-array",
        visibility: "always",
        priority: 1,
      },
    ])
  )
  assert.equal(docs.length, 0)
})

test("parseStoredActorDocs fails closed on non-array stored docs", () => {
  assert.throws(
    () => parseStoredActorDocs("{not json"),
    /must be a valid JSON array/
  )
  assert.throws(
    () => parseStoredActorDocs({ docs: [] }),
    /must be a JSON array/
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
