import assert from "node:assert/strict"
import test from "node:test"
import type { ActorDoc } from "@synapse/shared"
import {
  normalizeInviteableActorDocs,
  normalizeToolResultMetadata,
} from "./repo.js"

const decodedDoc: ActorDoc = {
  id: "00000000-0000-4000-8000-000000000201",
  key: "custom",
  title: "Visible",
  content: [
    {
      id: "00000000-0000-4000-8000-000000000202",
      type: "text",
      text: "Decoded docs only.",
    },
  ],
  visibility: "multi_member_only",
  priority: 1,
}

test("normalizeInviteableActorDocs consumes decoded arrays", () => {
  const docs = normalizeInviteableActorDocs([decodedDoc])

  assert.equal(docs.length, 1)
  assert.equal(docs[0]?.title, "Visible")
  assert.equal(docs[0]?.content[0]?.type, "text")
})

test("normalizeInviteableActorDocs rejects JSON string fallback", () => {
  assert.deepEqual(
    normalizeInviteableActorDocs(JSON.stringify([decodedDoc])),
    []
  )
  assert.deepEqual(normalizeInviteableActorDocs({ docs: [decodedDoc] }), [])
})

test("normalizeToolResultMetadata returns decoded metadata records", () => {
  assert.deepEqual(
    normalizeToolResultMetadata({
      origin: { kind: "system", registryKey: "lookup" },
      structuredContent: { hits: 2 },
      traceId: "trc-1",
    }),
    {
      origin: { kind: "system", registryKey: "lookup" },
      structuredContent: { hits: 2 },
      traceId: "trc-1",
    }
  )
})

test("normalizeToolResultMetadata rejects non-object metadata", () => {
  assert.deepEqual(normalizeToolResultMetadata(null), {})
  assert.deepEqual(normalizeToolResultMetadata(["not", "an", "object"]), {})
  assert.deepEqual(normalizeToolResultMetadata("not json"), {})
})
