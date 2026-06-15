import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { Executor } from "../../infrastructure/database/kysely.js"
import { listConversationRealtimeRecipientsUseCase } from "./realtime-recipients.js"

test("listConversationRealtimeRecipientsUseCase maps realtime recipient rows", async () => {
  const queryable = {} as Executor
  const conversationId = randomUUID()
  const workspaceId = randomUUID()
  const firstMemberId = randomUUID()
  const secondMemberId = randomUUID()
  const calls: Array<{ queryable: Executor; conversationId: string }> = []

  const result = await listConversationRealtimeRecipientsUseCase(
    conversationId,
    queryable,
    {
      listRecipientRows: async (receivedQueryable, receivedConversationId) => {
        calls.push({
          queryable: receivedQueryable,
          conversationId: receivedConversationId,
        })
        return [
          { workspaceId, workspaceMemberId: firstMemberId },
          { workspaceId, workspaceMemberId: secondMemberId },
        ]
      },
    }
  )

  assert.deepEqual(calls, [{ queryable, conversationId }])
  assert.deepEqual(result, [
    { workspaceId, workspaceMemberId: firstMemberId },
    { workspaceId, workspaceMemberId: secondMemberId },
  ])
})
