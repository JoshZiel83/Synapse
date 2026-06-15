import assert from "node:assert/strict"
import test from "node:test"
import { normalizeArchivePointRow } from "./repo.js"
import type { ArchivePointRow } from "./repo.js"

test("normalizeArchivePointRow decodes archive point metadata at repo exit", () => {
  const row = normalizeArchivePointRow({
    id: "archive-1",
    chain_scope: "shared",
    conversation_id: "conversation-1",
    session_id: null,
    parent_archive_point_id: null,
    covers_until_sequence: "42",
    metadata: JSON.stringify({ reason: "compaction" }),
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  } satisfies ArchivePointRow)

  assert.deepEqual(row.metadata, { reason: "compaction" })
})
