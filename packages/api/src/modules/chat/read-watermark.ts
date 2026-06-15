import type {
  DatabaseTransaction,
  Executor,
} from "../../infrastructure/database/kysely.js"
import { serializeNowInstant } from "../../infrastructure/datetime.js"
import {
  countUnreadVisibleConversationMessages,
  getConversationMaxSequence,
  getConversationParticipantReadState,
  getLastConversationItemIdAtOrBeforeSequence,
  upsertConversationDeviceState,
  upsertConversationParticipantReadState,
  upsertWorkspaceMemberConversationView,
  withChatTransaction,
} from "./repo.js"
import { requireConversationAccess } from "./conversation-access.js"
import { ensureClientInstance } from "./client-instances.js"
import { appendWorkspaceMemberSyncEvent } from "./sync-events.js"
import { recordDuplicateWatermarkPost } from "./observability.js"
import type { ChatConversationReadWatermarkRecord } from "./presenter.js"

export type ReadWatermarkInput = {
  workspaceId: string
  workspaceMemberId: string
  conversationId: string
  clientInstanceId: string
  readUpToSequence: number
  lastVisibleSequence?: number
}

export type SyncConversationUpsert = (
  queryable: Executor,
  workspaceId: string,
  workspaceMemberIds: string[],
  conversationId: string
) => Promise<void>

type RunReadWatermarkTransaction = <T>(
  fn: (trx: DatabaseTransaction) => Promise<T>
) => Promise<T>

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return 0
}

async function getConversationSequenceMaxValue(
  queryable: Executor,
  conversationId: string
) {
  return toNumber(await getConversationMaxSequence(queryable, conversationId))
}

async function countUnreadVisibleMessages(
  queryable: Executor,
  conversationId: string,
  participantId: string
) {
  return toNumber(
    await countUnreadVisibleConversationMessages(queryable, {
      conversationId,
      participantId,
    })
  )
}

export async function updateChatConversationReadWatermarkUseCase(
  params: ReadWatermarkInput,
  deps: {
    syncConversationUpsert: SyncConversationUpsert
    withTransaction?: RunReadWatermarkTransaction
  }
): Promise<ChatConversationReadWatermarkRecord> {
  const withTransaction = deps.withTransaction ?? withChatTransaction
  return withTransaction(async (client) => {
    const access = await requireConversationAccess(
      client,
      params.conversationId,
      params.workspaceMemberId
    )

    await ensureClientInstance(client, {
      workspaceId: params.workspaceId,
      workspaceMemberId: params.workspaceMemberId,
      clientInstanceId: params.clientInstanceId,
    })

    const maxSequence = await getConversationSequenceMaxValue(
      client,
      params.conversationId
    )
    const requestedSequence = Math.min(
      Math.max(params.readUpToSequence, 0),
      maxSequence
    )

    const existingRow = await getConversationParticipantReadState(client, {
      conversationId: params.conversationId,
      participantId: access.participant.id,
    })
    const existingSequence = toNumber(existingRow?.readWatermarkSequence)
    const nextSequence = Math.max(existingSequence, requestedSequence)
    // Count only genuine no-op retries. Participant creation pre-inserts a
    // sequence=0 row with lastReadAt=null, so the inaugural POST at 0 must not
    // look like a duplicate.
    const userHasMarkedBefore =
      Boolean(existingRow) && existingRow!.lastReadAt !== null
    if (userHasMarkedBefore && nextSequence === existingSequence) {
      recordDuplicateWatermarkPost()
    }
    const lastReadItemId = await getLastConversationItemIdAtOrBeforeSequence(
      client,
      params.conversationId,
      nextSequence
    )

    await upsertConversationParticipantReadState(client, {
      conversationId: params.conversationId,
      participantId: access.participant.id,
      readWatermarkSequence: nextSequence,
      lastReadItemId,
    })

    if (params.clientInstanceId) {
      const lastVisibleSequence = Math.min(
        maxSequence,
        Math.max(params.lastVisibleSequence ?? nextSequence, nextSequence)
      )
      await upsertConversationDeviceState(client, {
        conversationId: params.conversationId,
        clientInstanceId: params.clientInstanceId,
        lastVisibleSequence,
      })
    }

    const unreadCount = await countUnreadVisibleMessages(
      client,
      params.conversationId,
      access.participant.id
    )

    await upsertWorkspaceMemberConversationView(client, {
      workspaceMemberId: params.workspaceMemberId,
      conversationId: params.conversationId,
      unreadCount,
    })

    const lastReadAt = serializeNowInstant()
    await appendWorkspaceMemberSyncEvent(client, {
      workspaceId: params.workspaceId,
      workspaceMemberId: params.workspaceMemberId,
      conversationId: params.conversationId,
      eventType: "conversation.read.updated",
      payload: {
        conversationId: params.conversationId,
        workspaceMemberId: params.workspaceMemberId,
        participantId: access.participant.id,
        readWatermarkSequence: nextSequence,
        lastReadAt,
      },
    })

    await deps.syncConversationUpsert(
      client,
      params.workspaceId,
      [params.workspaceMemberId],
      params.conversationId
    )

    return {
      conversationId: params.conversationId,
      workspaceMemberId: params.workspaceMemberId,
      participantId: access.participant.id,
      readWatermarkSequence: nextSequence,
      lastReadAt,
    }
  })
}
