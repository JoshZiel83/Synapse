import type { Executor } from "../../infrastructure/database/kysely.js"
import { appendWorkspaceMemberSyncEvent } from "./sync-events.js"
import {
  presentChatConversationRecord,
  type ChatConversationRecord,
} from "./presenter.js"
import { loadChatConversationView } from "./conversation-view-read.js"

export type LoadConversationViewForSync = (
  queryable: Executor,
  workspaceId: string,
  workspaceMemberId: string,
  conversationId: string
) => Promise<ChatConversationRecord | null>

export type SyncConversationUpsertDeps = {
  loadConversationView: LoadConversationViewForSync
  appendWorkspaceMemberSyncEvent?: typeof appendWorkspaceMemberSyncEvent
}

export async function syncConversationUpsertForWorkspaceMembersUseCase(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberIds: string[],
  conversationId: string,
  deps: SyncConversationUpsertDeps
) {
  const appendSyncEvent =
    deps.appendWorkspaceMemberSyncEvent ?? appendWorkspaceMemberSyncEvent
  for (const workspaceMemberId of [...new Set(workspaceMemberIds)]) {
    const conversationRecord = await deps.loadConversationView(
      queryable,
      workspaceId,
      workspaceMemberId,
      conversationId
    )
    if (!conversationRecord) {
      continue
    }
    await appendSyncEvent(queryable, {
      workspaceId,
      workspaceMemberId,
      conversationId,
      eventType: "conversation.upsert",
      payload: {
        conversation: presentChatConversationRecord(conversationRecord),
      },
    })
  }
}

export async function syncConversationUpsertForWorkspaceMembers(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberIds: string[],
  conversationId: string
) {
  await syncConversationUpsertForWorkspaceMembersUseCase(
    queryable,
    workspaceId,
    workspaceMemberIds,
    conversationId,
    { loadConversationView: loadChatConversationView }
  )
}
