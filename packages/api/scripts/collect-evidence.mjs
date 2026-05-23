/**
 * E2E evidence collector for the IM refactor.
 *
 * Run while the user is interacting with the bot in Feishu. Captures:
 *   - the latest inbound transport_message_link
 *   - the live reaction list via Lark API
 *   - the persisted external_emoji_reactions JSONB
 *   - the actor turn linked to that message
 *   - the conversation_items metadata.transport.canonicalParts
 *
 * Output: prints a JSON document to stdout suitable for piping into a
 * timestamped evidence file.
 *
 * Usage:
 *   FEISHU_APP_ID=... FEISHU_APP_SECRET=... \
 *   PGURL=postgres://... \
 *     npx tsx scripts/collect-evidence.mjs
 */
import * as Lark from "@larksuiteoapi/node-sdk"
import pg from "pg"

const appId = process.env.FEISHU_APP_ID
const appSecret = process.env.FEISHU_APP_SECRET
const pgUrl = process.env.PGURL || process.env.DATABASE_URL
if (!appId || !appSecret || !pgUrl) {
  console.error(
    "FEISHU_APP_ID / FEISHU_APP_SECRET / PGURL (or DATABASE_URL) must all be set"
  )
  process.exit(2)
}

const lark = new Lark.Client({
  appId,
  appSecret,
  loggerLevel: Lark.LoggerLevel.warn,
})

const client = new pg.Client({ connectionString: pgUrl })
await client.connect()

const out = {
  collectedAt: new Date().toISOString(),
  latestInbound: null,
  outboundReplies: [],
  reactionsLive: null,
  reactionsPersisted: null,
  triggerTurn: null,
  conversationItem: null,
}

const inboundRow = await client.query(
  `SELECT id, external_message_id, item_id, conversation_id,
          transport_endpoint_id, external_emoji_reactions, created_at
     FROM transport_message_links
     WHERE direction = 'inbound'
     ORDER BY created_at DESC
     LIMIT 1`
)
if (inboundRow.rowCount === 0) {
  console.error("no inbound link yet — send a message first")
  await client.end()
  process.exit(3)
}
const row = inboundRow.rows[0]
out.latestInbound = {
  id: row.id,
  externalMessageId: row.external_message_id,
  itemId: row.item_id,
  conversationId: row.conversation_id,
  endpointId: row.transport_endpoint_id,
  createdAt: row.created_at,
}
out.reactionsPersisted = row.external_emoji_reactions || {}

// Live reactions from Feishu
try {
  const r = await lark.im.messageReaction.list({
    path: { message_id: row.external_message_id },
  })
  out.reactionsLive = r?.data?.items || []
} catch (e) {
  out.reactionsLive = { error: e.message }
}

// Outbound replies linked to the same conversation, after the inbound
const outRows = await client.query(
  `SELECT external_message_id, delivery_status, delivered_at, created_at
     FROM transport_message_links
     WHERE conversation_id = $1
       AND direction = 'outbound'
       AND created_at >= $2
     ORDER BY created_at`,
  [row.conversation_id, row.created_at]
)
out.outboundReplies = outRows.rows

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

// Conversation item canonicalParts
const itemRow = await client.query(
  `SELECT metadata
     FROM conversation_items
     WHERE id = $1`,
  [row.item_id]
)
const meta = itemRow.rows[0]?.metadata
out.conversationItem = {
  hasCanonicalParts:
    !!meta?.transport?.canonicalParts &&
    Array.isArray(meta.transport.canonicalParts) &&
    meta.transport.canonicalParts.length > 0,
  canonicalPartsCount: Array.isArray(meta?.transport?.canonicalParts)
    ? meta.transport.canonicalParts.length
    : 0,
  canonicalPartsSample: Array.isArray(meta?.transport?.canonicalParts)
    ? meta.transport.canonicalParts.slice(0, 3)
    : null,
  externalReplyToId: meta?.transport?.externalReplyToId || null,
  externalThreadId: meta?.transport?.externalThreadId || null,
}

console.log(JSON.stringify(out, null, 2))
await client.end()
