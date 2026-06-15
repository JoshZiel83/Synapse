import type {
  ChatSyncEvent,
  ChatSyncEventPayloadMap,
  ChatSyncEventType,
} from "@synapse/shared"
import type {
  DatabaseTransaction,
  Executor,
} from "../../infrastructure/database/kysely.js"
import { requireInstantDate } from "../../infrastructure/datetime.js"
import { enqueueTransactionalEvent } from "../../infrastructure/events/index.js"
import {
  insertWorkspaceMemberSyncEventRow,
  isChatTransaction,
  withChatTransaction,
} from "./repo.js"
import { presentInstant } from "./presenter.js"

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

/**
 * Discriminate a Kysely transaction from the root executor. Kysely exposes
 * `isTransaction` on the instance (true only for a Transaction<DB>); used by the
 * sync-append wrapper to decide whether to reuse the caller's tx or open one.
 */
function isDatabaseTransaction(
  executor: Executor
): executor is DatabaseTransaction {
  return isChatTransaction(executor)
}

/**
 * Append one durable sync event for a single workspace member, assigning the
 * per-member, commit-ordered, gap-free `member_seq` cursor.
 *
 * MUST run inside a transaction (the caller's `trx`): it takes a 64-bit
 * advisory transaction lock keyed on the member id, reads `MAX(member_seq)+1`,
 * and inserts the sync row + the realtime outbox row atomically. The advisory
 * lock serializes all concurrent appends for the same member, so the commit
 * order equals the `member_seq` order with no holes -- exactly what the client
 * cursor (`getChatSync` paging by `member_seq > cursor`) relies on.
 *
 * Exported because external producers (tasks, remote-agents) append from inside
 * their own business transaction and must keep the domain write + sync + outbox
 * atomic; they call this directly with their `trx`. Root-executor callers go
 * through the `appendWorkspaceMemberSyncEvent` wrapper, which opens a tx.
 */
export async function appendWorkspaceMemberSyncEventInTransaction<
  T extends ChatSyncEventType,
>(
  trx: DatabaseTransaction,
  params: {
    workspaceId: string
    workspaceMemberId: string
    conversationId?: string
    itemId?: string
    eventType: T
    payload: ChatSyncEventPayloadMap[T]
  }
) {
  const row = await insertWorkspaceMemberSyncEventRow(trx, params)
  const envelope: ChatSyncEvent<T> = {
    syncSeq: toNumber(row?.syncSeq),
    memberSeq: toNumber(row?.memberSeq),
    workspaceId: params.workspaceId,
    workspaceMemberId: params.workspaceMemberId,
    conversationId: params.conversationId,
    itemId: params.itemId,
    eventType: params.eventType,
    payload: params.payload,
    occurredAt: presentInstant(
      requireInstantDate(
        row?.occurredAt ?? null,
        "workspace_member_sync_events.occurred_at"
      )
    ),
  }

  await enqueueTransactionalEvent(trx, {
    type: "chat.sync.event",
    workspaceId: params.workspaceId,
    recipientWorkspaceMemberId: params.workspaceMemberId,
    payload: envelope as unknown as Record<string, unknown>,
    timestamp: envelope.occurredAt,
  })

  return envelope
}

/**
 * Transaction-aware append wrapper. If the caller already holds a transaction
 * (`queryable` is a Kysely transaction), reuse it so the domain write + sync +
 * outbox stay atomic. If the caller passes the root executor (autocommit), open
 * a transaction here: the advisory-lock-protected `MAX(member_seq)+1` must live
 * inside a transaction or the lock would release at statement end and the
 * counter could race.
 */
export async function appendWorkspaceMemberSyncEvent<
  T extends ChatSyncEventType,
>(
  queryable: Executor,
  params: {
    workspaceId: string
    workspaceMemberId: string
    conversationId?: string
    itemId?: string
    eventType: T
    payload: ChatSyncEventPayloadMap[T]
  }
) {
  if (isDatabaseTransaction(queryable)) {
    return appendWorkspaceMemberSyncEventInTransaction(queryable, params)
  }
  return withChatTransaction((trx) =>
    appendWorkspaceMemberSyncEventInTransaction(trx, params)
  )
}
