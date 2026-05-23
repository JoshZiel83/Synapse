/**
 * DB-only evidence: no Lark API call, no Feishu credentials needed.
 * Captures the persisted state that proves the IM refactor data path works:
 *   - latest inbound transport_message_link
 *   - reply/thread columns populated
 *   - external_emoji_reactions persisted JSONB
 *   - associated turn (trigger_item_id binding)
 *   - canonicalParts under metadata.transport
 *   - outbound replies linked to the same conversation
 *
 * Usage:
 *   PGURL=postgres://... npx tsx scripts/collect-evidence-db.mjs
 */
import pg from "pg"

const pgUrl = process.env.PGURL || process.env.DATABASE_URL
if (!pgUrl) {
  console.error("PGURL or DATABASE_URL must be set")
  process.exit(2)
}

const client = new pg.Client({ connectionString: pgUrl })
await client.connect()

const out = {
  collectedAt: new Date().toISOString(),
  latestInbound: null,
  reactionPersistence: null,
  conversationItem: null,
  triggerTurn: null,
  outboundReplies: [],
  recentMessageLinks: [],
}

const inboundRow = await client.query(
  `SELECT id, external_message_id, external_reply_to_id, external_thread_id,
          external_emoji_reactions, item_id, conversation_id,
          transport_endpoint_id, transport_kind, created_at
     FROM transport_message_links
     WHERE direction = 'inbound'
     ORDER BY created_at DESC
     LIMIT 1`
)
if (inboundRow.rowCount === 0) {
  console.log(JSON.stringify({ ...out, error: "no inbound link yet" }, null, 2))
  await client.end()
  process.exit(3)
}
const row = inboundRow.rows[0]
out.latestInbound = {
  id: row.id,
  externalMessageId: row.external_message_id,
  externalReplyToId: row.external_reply_to_id,
  externalThreadId: row.external_thread_id,
  itemId: row.item_id,
  conversationId: row.conversation_id,
  endpointId: row.transport_endpoint_id,
  transportKind: row.transport_kind,
  createdAt: row.created_at,
}
out.reactionPersistence = {
  raw: row.external_emoji_reactions,
  isPopulated:
    !!row.external_emoji_reactions &&
    typeof row.external_emoji_reactions === "object" &&
    Object.keys(row.external_emoji_reactions).length > 0,
  count:
    row.external_emoji_reactions &&
    typeof row.external_emoji_reactions === "object"
      ? Object.keys(row.external_emoji_reactions).length
      : 0,
}

// Conversation item canonicalParts
const itemRow = await client.query(
  `SELECT metadata FROM conversation_items WHERE id = $1`,
  [row.item_id]
)
const meta = itemRow.rows[0]?.metadata
const parts = meta?.transport?.canonicalParts
out.conversationItem = {
  hasCanonicalParts: Array.isArray(parts) && parts.length > 0,
  canonicalPartsCount: Array.isArray(parts) ? parts.length : 0,
  canonicalPartsSample: Array.isArray(parts) ? parts.slice(0, 3) : null,
  transportMetadata: meta?.transport || null,
}

// Turn that this inbound triggered
const turnRow = await client.query(
  `SELECT id, status, started_at, completed_at
     FROM turns
     WHERE trigger_item_id = $1
     ORDER BY started_at DESC NULLS LAST
     LIMIT 1`,
  [row.item_id]
)
out.triggerTurn = turnRow.rows[0] || null

// Outbound replies linked to the same conversation after this inbound
const outRows = await client.query(
  `SELECT external_message_id, delivery_status, delivered_at, created_at,
          (metadata->>'lastError') as last_error
     FROM transport_message_links
     WHERE conversation_id = $1
       AND direction = 'outbound'
       AND created_at >= $2
     ORDER BY created_at`,
  [row.conversation_id, row.created_at]
)
out.outboundReplies = outRows.rows

// Last 10 transport message links across all conversations
const recent = await client.query(
  `SELECT id, external_message_id, direction, delivery_status,
          transport_kind, created_at,
          jsonb_typeof(external_emoji_reactions) as reactions_type,
          (external_emoji_reactions::text) as reactions_text
     FROM transport_message_links
     ORDER BY created_at DESC
     LIMIT 10`
)
out.recentMessageLinks = recent.rows.map((r) => ({
  ...r,
  reactions:
    r.reactions_type === "object" ? JSON.parse(r.reactions_text) : null,
  reactions_text: undefined,
  reactions_type: undefined,
}))

console.log(JSON.stringify(out, null, 2))
await client.end()
