import type {
  DatabaseTransaction,
  Executor,
} from "../../infrastructure/database/kysely.js"
import { updateConversationMutableFields, withChatTransaction } from "./repo.js"
import { requireConversationManagement } from "./conversation-access.js"
import { createChatError } from "./errors.js"
import type {
  ChatConversationEnvelopeRecord,
  ChatConversationRecord,
} from "./presenter.js"

export type PatchChatConversationInput = {
  workspaceId: string
  workspaceMemberId: string
  conversationId: string
  title?: string | null
  metadata?: Record<string, unknown>
}

type ListRealtimeRecipients = (
  conversationId: string,
  queryable: Executor
) => Promise<Array<{ workspaceMemberId: string }>>

type LoadConversationView = (
  queryable: Executor,
  workspaceId: string,
  workspaceMemberId: string,
  conversationId: string
) => Promise<ChatConversationRecord | null>

type SyncConversationUpsert = (
  queryable: Executor,
  workspaceId: string,
  workspaceMemberIds: string[],
  conversationId: string
) => Promise<void>

type RunPatchConversationTransaction = <T>(
  fn: (trx: DatabaseTransaction) => Promise<T>
) => Promise<T>

export type PatchChatConversationDeps = {
  listConversationRealtimeRecipients: ListRealtimeRecipients
  loadConversationView: LoadConversationView
  syncConversationUpsert: SyncConversationUpsert
  withTransaction?: RunPatchConversationTransaction
}

export async function patchChatConversationUseCase(
  params: PatchChatConversationInput,
  deps: PatchChatConversationDeps
): Promise<ChatConversationEnvelopeRecord | undefined> {
  if (params.title === undefined && params.metadata === undefined) {
    throw createChatError(
      400,
      "invalid_patch",
      "At least one of title or metadata must be provided"
    )
  }

  const withTransaction = deps.withTransaction ?? withChatTransaction
  return withTransaction(async (client) => {
    await requireConversationManagement(
      client,
      params.conversationId,
      params.workspaceMemberId
    )

    const updated = await updateConversationMutableFields(client, {
      conversationId: params.conversationId,
      title: params.title,
      metadata: params.metadata,
    })
    if (!updated) {
      return
    }

    const recipients = await deps.listConversationRealtimeRecipients(
      params.conversationId,
      client
    )
    await deps.syncConversationUpsert(
      client,
      params.workspaceId,
      recipients.map((r) => r.workspaceMemberId),
      params.conversationId
    )

    const conversation = await deps.loadConversationView(
      client,
      params.workspaceId,
      params.workspaceMemberId,
      params.conversationId
    )
    if (!conversation) {
      throw createChatError(
        404,
        "conversation_not_found",
        "Conversation not found"
      )
    }
    return { conversation }
  })
}
