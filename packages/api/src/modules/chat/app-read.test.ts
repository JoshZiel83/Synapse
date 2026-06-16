import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { parseChatSyncEventRow } from "./app-read.js"
import type { ChatWorkspaceMemberSyncEventRow } from "./repo.js"

const occurredAt = new Date("2026-06-17T00:00:00.000Z")

function syncRow(
  values: Partial<ChatWorkspaceMemberSyncEventRow> = {}
): ChatWorkspaceMemberSyncEventRow {
  const workspaceId = randomUUID()
  const workspaceMemberId = randomUUID()
  const conversationId = randomUUID()
  return {
    syncSeq: 1,
    memberSeq: 1,
    workspaceId,
    workspaceMemberId,
    conversationId,
    itemId: null,
    eventType: "conversation.read.updated",
    payload: {
      conversationId,
      workspaceMemberId,
      participantId: randomUUID(),
      readWatermarkSequence: 12,
      lastReadAt: "2026-06-17T00:00:00.000Z",
    },
    occurredAt,
    ...values,
  }
}

test("parseChatSyncEventRow validates payload against event type", () => {
  const row = syncRow()
  const event = parseChatSyncEventRow(row)

  assert.equal(event.eventType, "conversation.read.updated")
  assert.deepEqual(event.payload, row.payload)
  assert.equal(event.occurredAt, "2026-06-17T00:00:00.000Z")
})

test("parseChatSyncEventRow rejects malformed sync event payloads before enrichment", () => {
  assert.throws(() =>
    parseChatSyncEventRow(
      syncRow({
        payload: {
          conversationId: randomUUID(),
          readWatermarkSequence: 12,
          lastReadAt: "2026-06-17T00:00:00.000Z",
        },
      })
    )
  )
})
