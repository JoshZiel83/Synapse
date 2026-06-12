import { sql } from "kysely"
import { db, type Executor } from "../../infrastructure/database/kysely.js"
import { requireRemoteAgentConversationAccess } from "../chat/service.js"

/**
 * Pending message-delivery refs for a (remote agent, conversation) pair. Raw
 * `sql` tag bypasses the CamelCasePlugin, so the SELECT aliases item_id ->
 * itemId itself; the WHERE preserves the status = 'pending' guard verbatim.
 */
export async function listPendingDeliveryRefs(
  params: { remoteAgentId: string; conversationId: string },
  executor: Executor = db
): Promise<Array<{ id: string; itemId: string }>> {
  const result = await sql<{ id: string; itemId: string }>`
          SELECT delivery.id, delivery.item_id
          FROM remote_agent_message_deliveries delivery
          WHERE delivery.remote_agent_id = ${params.remoteAgentId}
            AND delivery.conversation_id = ${params.conversationId}
            AND delivery.status = 'pending'
        `.execute(executor)
  return result.rows
}

/**
 * Conversation type facts (kind + whether it has any transport binding). Raw
 * `sql` tag selects is_im (snake) verbatim; the repo maps it to camelCase
 * isIm. Returns null when the conversation does not exist.
 */
export async function getConversationTypeFacts(
  conversationId: string,
  executor: Executor = db
): Promise<{ kind: "direct" | "group"; isIm: boolean } | null> {
  const result = await sql<{
    kind: "direct" | "group"
    is_im: boolean
  }>`
    SELECT kind, EXISTS (
      SELECT 1 FROM conversation_transport_bindings b
      WHERE b.conversation_id = conversations.id
    ) AS is_im
    FROM conversations WHERE id = ${conversationId} LIMIT 1`.execute(executor)
  const row = result.rows[0]
  if (!row) {
    return null
  }
  return { kind: row.kind, isIm: Boolean(row.is_im) }
}

/**
 * Default-db-bound wrapper around the chat module's conversation-access guard.
 * Keeps the singleton `db` thread inside this guard-exempt repo file rather
 * than relocating it into the (guarded) mcp-endpoint caller.
 */
export async function requireConversationAccessOnDefaultDb(
  conversationId: string,
  remoteAgentId: string
) {
  return requireRemoteAgentConversationAccess(db, conversationId, remoteAgentId)
}
