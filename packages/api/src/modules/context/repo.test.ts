import assert from "node:assert/strict"
import test from "node:test"
import { normalizeArchivePointRow, parseArchiveFrameJsonArray } from "./repo.js"
import type { ArchivePointRow } from "./repo.js"

test("normalizeArchivePointRow decodes archive point metadata at repo exit", () => {
  const row = normalizeArchivePointRow({
    id: "archive-1",
    chainScope: "shared",
    conversationId: "conversation-1",
    sessionId: null,
    parentArchivePointId: null,
    coversUntilSequence: "42",
    metadata: JSON.stringify({ reason: "compaction" }),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  } satisfies ArchivePointRow)

  assert.equal(row.chainScope, "shared")
  assert.equal(row.conversationId, "conversation-1")
  assert.equal(row.sessionId, null)
  assert.equal(row.parentArchivePointId, null)
  assert.equal(row.coversUntilSequence, "42")
  assert.deepEqual(row.metadata, { reason: "compaction" })
  assert.equal(row.createdAt.toISOString(), "2026-01-01T00:00:00.000Z")
})

test("normalizeArchivePointRow rejects malformed archive point metadata", () => {
  assert.throws(
    () =>
      normalizeArchivePointRow({
        id: "archive-1",
        chainScope: "shared",
        conversationId: "conversation-1",
        sessionId: null,
        parentArchivePointId: null,
        coversUntilSequence: "42",
        metadata: "not json",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      } satisfies ArchivePointRow),
    /context archive point metadata must be a valid JSON object/
  )
})

test("normalizeArchivePointRow rejects non-object archive point metadata", () => {
  assert.throws(
    () =>
      normalizeArchivePointRow({
        id: "archive-1",
        chainScope: "shared",
        conversationId: "conversation-1",
        sessionId: null,
        parentArchivePointId: null,
        coversUntilSequence: "42",
        metadata: JSON.stringify(["not-object"]),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      } satisfies ArchivePointRow),
    /context archive point metadata must be a JSON object/
  )
  assert.equal(
    normalizeArchivePointRow({
      id: "archive-1",
      chainScope: "shared",
      conversationId: "conversation-1",
      sessionId: null,
      parentArchivePointId: null,
      coversUntilSequence: "42",
      metadata: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    } satisfies ArchivePointRow).metadata,
    undefined
  )
})

test("parseArchiveFrameJsonArray decodes archive frame arrays at repo exit", () => {
  assert.deepEqual(parseArchiveFrameJsonArray<string>('["item-1"]'), ["item-1"])
  assert.deepEqual(parseArchiveFrameJsonArray<number[]>([[1], [2]]), [[1], [2]])
})

test("parseArchiveFrameJsonArray fails closed for malformed or non-array JSON", () => {
  assert.throws(
    () => parseArchiveFrameJsonArray('{"not":"array"}'),
    /must be a JSON array/
  )
  assert.throws(
    () => parseArchiveFrameJsonArray('"scalar"'),
    /must be a JSON array/
  )
  assert.throws(
    () => parseArchiveFrameJsonArray("{"),
    /must be a valid JSON array/
  )
  assert.throws(
    () => parseArchiveFrameJsonArray(""),
    /must be a valid JSON array/
  )
  assert.equal(parseArchiveFrameJsonArray(null), undefined)
})
