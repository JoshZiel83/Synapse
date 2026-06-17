import type { Executor } from "../../infrastructure/database/kysely.js"
import {
  chatRootExecutor,
  listConversationRealtimeRecipientRows,
} from "./repo.js"

export type ConversationRealtimeRecipient = {
  workspaceId: string
  workspaceMemberId: string
}

export type ListConversationRealtimeRecipientsDeps = {
  listRecipientRows?: (
    queryable: Executor,
    conversationId: string
  ) => Promise<ConversationRealtimeRecipient[]>
}

export async function listConversationRealtimeRecipientsUseCase(
  conversationId: string,
  queryable: Executor,
  deps: ListConversationRealtimeRecipientsDeps = {}
): Promise<ConversationRealtimeRecipient[]> {
  const listRecipientRows =
    deps.listRecipientRows ?? listConversationRealtimeRecipientRows
  const rows = await listRecipientRows(queryable, conversationId)

  return rows.map((row) => ({
    workspaceId: row.workspaceId,
    workspaceMemberId: row.workspaceMemberId,
  }))
}

function rootQueryable(): Executor {
  return chatRootExecutor()
}

export async function listConversationRealtimeRecipients(
  conversationId: string,
  queryable: Executor = rootQueryable()
) {
  return listConversationRealtimeRecipientsUseCase(conversationId, queryable)
}
