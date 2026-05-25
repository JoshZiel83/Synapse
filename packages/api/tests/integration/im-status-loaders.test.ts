// DB-loader behavior tests for the actor-status-hooks (Commit 5).
//
// The pure decideStatusLookupSource tests in
// `src/modules/im/integration/actor-status-hooks-decide.test.ts` cover
// the routing rule, but they can't catch SQL-level regressions in the
// three loaders themselves:
//
//   1. `loadCurrentRunningTurnRow` MUST filter `status = 'running'` (the
//      pre-Commit-5 bug at actor-status-hooks.ts:122-128 would silently
//      fall back to the most recent turn regardless of status, which let
//      a stale completed turn's `started_at` extend the fallback cutoff
//      far into the past). It also must order `started_at DESC NULLS
//      LAST, id DESC` so a dirty null started_at doesn't eclipse a real
//      running turn (Postgres default `NULLS FIRST` on DESC).
//
//   2. `findInboundLinkForTriggerItem` MUST exclude links whose
//      `external_message_id` is null / empty / whitespace-only — schema
//      permits all three (transport_message_links.external_message_id is
//      VARCHAR(255) nullable, no CHECK on emptiness). Falling through to
//      the fallback path is the correct behavior; using a placeholder id
//      downstream is not.
//
//   3. `findRecentInboundLinkForConversation` MUST apply the same
//      external_message_id predicate. Otherwise a newer row with empty
//      id and `LIMIT 1` would hide an older valid row.
//
// These tests connect to the test postgres directly (via pg, no API
// process needed), seed minimal rows, and call the loaders. They run
// via `bash packages/api/tests/integration/scripts/run-test.sh
// packages/api/tests/integration/im-status-loaders.test.ts`.

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import pg from "pg"

import {
  buildDatabaseUrl,
  resetDb,
  seedMinimal,
  teardownApiConnections,
  type MinimalSeed,
} from "./harness/index.js"

import {
  computeStatusFallbackCutoffIso,
  findInboundLinkForTriggerItem,
  findRecentInboundLinkForConversation,
  loadCurrentRunningTurnRow,
} from "../../src/modules/im/integration/actor-status-hooks.js"

let seed: MinimalSeed
let client: pg.Client

before(async () => {
  await resetDb()
  seed = await seedMinimal({ workspaceSlugSuffix: "im-status-loaders" })
  client = new pg.Client({ connectionString: buildDatabaseUrl() })
  await client.connect()
})

after(async () => {
  if (client) await client.end()
  await teardownApiConnections()
})

// ─── fixture helpers ───────────────────────────────────────────────

interface ConversationCtx {
  conversationId: string
  sessionId: string
  actorId: string
  accountId: string
  endpointId: string
}

async function makeConversationCtx(label: string): Promise<ConversationCtx> {
  const slug = label.replace(/[^a-z0-9_]/g, "_").slice(0, 50)

  const actorRow = await client.query<{ id: string }>(
    `INSERT INTO actors (workspace_id, name, role, title)
     VALUES ($1, $2, 'assistant', 'Loader test actor')
     RETURNING id`,
    [seed.workspaceId, `loader-actor-${slug}`]
  )
  const actorId = actorRow.rows[0].id

  const convRow = await client.query<{ id: string }>(
    `INSERT INTO conversations (kind, boundary, internal_workspace_id, title)
     VALUES ('private', 'internal', $1, $2)
     RETURNING id`,
    [seed.workspaceId, `loader-conv-${slug}`]
  )
  const conversationId = convRow.rows[0].id

  const sessRow = await client.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, actor_id, conversation_id, channel_type)
     VALUES ($1, $2, $3, 'web')
     RETURNING id`,
    [seed.workspaceId, actorId, conversationId]
  )
  const sessionId = sessRow.rows[0].id

  const accountRow = await client.query<{ id: string }>(
    `INSERT INTO transport_accounts (
       workspace_id, transport_kind, account_key, display_name,
       owner_scope, connection_mode
     )
     VALUES ($1, 'feishu', $2, $3, 'workspace', 'webhook')
     RETURNING id`,
    [
      seed.workspaceId,
      `acct-${slug}-${crypto.randomBytes(2).toString("hex")}`,
      `Loader test account ${slug}`,
    ]
  )
  const accountId = accountRow.rows[0].id

  const endpointRow = await client.query<{ id: string }>(
    `INSERT INTO transport_endpoints (
       transport_account_id, endpoint_type, external_id, display_name
     )
     VALUES ($1, 'direct', $2, 'Loader test endpoint')
     RETURNING id`,
    [accountId, `oc_${slug}_${crypto.randomBytes(2).toString("hex")}`]
  )
  const endpointId = endpointRow.rows[0].id

  return { conversationId, sessionId, actorId, accountId, endpointId }
}

async function insertConversationItem(
  ctx: ConversationCtx,
  subtype: string = "message"
): Promise<string> {
  const row = await client.query<{ id: string }>(
    `INSERT INTO conversation_items (
       conversation_id, session_id, scope, surface, item_type, subtype, role
     )
     VALUES ($1, $2, 'shared', 'visible', 'message', $3, 'user')
     RETURNING id`,
    [ctx.conversationId, ctx.sessionId, subtype]
  )
  return row.rows[0].id
}

async function insertTurn(
  ctx: ConversationCtx,
  opts: {
    status: "running" | "completed"
    triggerItemId?: string | null
    startedAt?: Date | null
  }
): Promise<string> {
  // Either pass started_at explicitly (including null for the dirty-row
  // test) or omit it so the DEFAULT NOW() applies.
  if (opts.startedAt === undefined) {
    const row = await client.query<{ id: string }>(
      `INSERT INTO turns (
         session_id, conversation_id, actor_id, trigger_item_id,
         trigger_type, status
       )
       VALUES ($1, $2, $3, $4, 'inbound_message', $5)
       RETURNING id`,
      [
        ctx.sessionId,
        ctx.conversationId,
        ctx.actorId,
        opts.triggerItemId ?? null,
        opts.status,
      ]
    )
    return row.rows[0].id
  }
  const row = await client.query<{ id: string }>(
    `INSERT INTO turns (
       session_id, conversation_id, actor_id, trigger_item_id,
       trigger_type, status, started_at
     )
     VALUES ($1, $2, $3, $4, 'inbound_message', $5, $6)
     RETURNING id`,
    [
      ctx.sessionId,
      ctx.conversationId,
      ctx.actorId,
      opts.triggerItemId ?? null,
      opts.status,
      opts.startedAt,
    ]
  )
  return row.rows[0].id
}

async function insertInboundLink(
  ctx: ConversationCtx,
  opts: {
    itemId: string
    externalMessageId: string | null
    createdAt?: Date
  }
): Promise<void> {
  if (opts.createdAt) {
    await client.query(
      `INSERT INTO transport_message_links (
         workspace_id, conversation_id, item_id, transport_account_id,
         transport_endpoint_id, transport_kind, direction,
         external_message_id, created_at
       )
       VALUES ($1, $2, $3, $4, $5, 'feishu', 'inbound', $6, $7)`,
      [
        seed.workspaceId,
        ctx.conversationId,
        opts.itemId,
        ctx.accountId,
        ctx.endpointId,
        opts.externalMessageId,
        opts.createdAt,
      ]
    )
  } else {
    await client.query(
      `INSERT INTO transport_message_links (
         workspace_id, conversation_id, item_id, transport_account_id,
         transport_endpoint_id, transport_kind, direction,
         external_message_id
       )
       VALUES ($1, $2, $3, $4, $5, 'feishu', 'inbound', $6)`,
      [
        seed.workspaceId,
        ctx.conversationId,
        opts.itemId,
        ctx.accountId,
        ctx.endpointId,
        opts.externalMessageId,
      ]
    )
  }
}

// ─── loadCurrentRunningTurnRow ──────────────────────────────────────

test("loadCurrentRunningTurnRow: returns null when no turn exists", async () => {
  const ctx = await makeConversationCtx("no-turn")
  const row = await loadCurrentRunningTurnRow(ctx.sessionId)
  assert.equal(row, null)
})

test("loadCurrentRunningTurnRow: returns null when only a completed turn exists", async () => {
  const ctx = await makeConversationCtx("only-completed")
  await insertTurn(ctx, { status: "completed" })
  const row = await loadCurrentRunningTurnRow(ctx.sessionId)
  assert.equal(row, null, "completed-only must not be promoted to running")
})

test(
  "loadCurrentRunningTurnRow: returns the running turn when a MORE RECENT completed turn also exists " +
    "(proves the status='running' filter is active — without it, the completed turn would win on started_at DESC)",
  async () => {
    const ctx = await makeConversationCtx("running-plus-newer-completed")
    const olderRunningStart = new Date(Date.now() - 60_000)
    const newerCompletedStart = new Date(Date.now() - 1_000)
    const itemId = await insertConversationItem(ctx)
    const runningTurnId = await insertTurn(ctx, {
      status: "running",
      triggerItemId: itemId,
      startedAt: olderRunningStart,
    })
    await insertTurn(ctx, {
      status: "completed",
      startedAt: newerCompletedStart,
    })
    const row = await loadCurrentRunningTurnRow(ctx.sessionId)
    assert.ok(row, "should find the running turn")
    assert.equal(row!.trigger_item_id, itemId)
    assert.equal(row!.started_at, olderRunningStart.toISOString())
    void runningTurnId // unused but documents the seeded id
  }
)

test("loadCurrentRunningTurnRow: NULLS LAST ordering — running turn with started_at=null does not eclipse one with real started_at", async () => {
  const ctx = await makeConversationCtx("nulls-last-ordering")
  const realStart = new Date(Date.now() - 60_000)
  const itemId = await insertConversationItem(ctx)
  // Seed the null-started_at row FIRST so its `id` is older — proves
  // NULLS LAST + id DESC tiebreaker doesn't accidentally pick it.
  await insertTurn(ctx, {
    status: "running",
    triggerItemId: null,
    startedAt: null,
  })
  await insertTurn(ctx, {
    status: "running",
    triggerItemId: itemId,
    startedAt: realStart,
  })
  const row = await loadCurrentRunningTurnRow(ctx.sessionId)
  assert.ok(row)
  assert.equal(row!.trigger_item_id, itemId)
  assert.equal(row!.started_at, realStart.toISOString())
})

test("loadCurrentRunningTurnRow: started_at=null is preserved through the loader", async () => {
  const ctx = await makeConversationCtx("started-at-null")
  const itemId = await insertConversationItem(ctx)
  await insertTurn(ctx, {
    status: "running",
    triggerItemId: itemId,
    startedAt: null,
  })
  const row = await loadCurrentRunningTurnRow(ctx.sessionId)
  assert.ok(row)
  assert.equal(row!.started_at, null)
  assert.equal(row!.trigger_item_id, itemId)
})

// ─── findInboundLinkForTriggerItem ──────────────────────────────────

test("findInboundLinkForTriggerItem: returns the inbound link when external_message_id is non-empty", async () => {
  const ctx = await makeConversationCtx("trigger-happy")
  const itemId = await insertConversationItem(ctx)
  await insertInboundLink(ctx, {
    itemId,
    externalMessageId: "om_real_123",
  })
  const link = await findInboundLinkForTriggerItem(itemId)
  assert.ok(link)
  assert.equal(link!.externalMessageId, "om_real_123")
  assert.equal(link!.endpointType, "direct")
  assert.equal(link!.transportKind, "feishu")
})

test("findInboundLinkForTriggerItem: returns null when external_message_id IS NULL (caller falls through to fallback)", async () => {
  const ctx = await makeConversationCtx("trigger-null")
  const itemId = await insertConversationItem(ctx)
  await insertInboundLink(ctx, {
    itemId,
    externalMessageId: null,
  })
  const link = await findInboundLinkForTriggerItem(itemId)
  assert.equal(link, null)
})

test("findInboundLinkForTriggerItem: returns null when external_message_id is empty string", async () => {
  const ctx = await makeConversationCtx("trigger-empty")
  const itemId = await insertConversationItem(ctx)
  await insertInboundLink(ctx, {
    itemId,
    externalMessageId: "",
  })
  const link = await findInboundLinkForTriggerItem(itemId)
  assert.equal(link, null)
})

test("findInboundLinkForTriggerItem: returns null when external_message_id is whitespace-only", async () => {
  const ctx = await makeConversationCtx("trigger-whitespace")
  const itemId = await insertConversationItem(ctx)
  await insertInboundLink(ctx, {
    itemId,
    externalMessageId: "   ",
  })
  const link = await findInboundLinkForTriggerItem(itemId)
  assert.equal(link, null)
})

// ─── findRecentInboundLinkForConversation ──────────────────────────

test("findRecentInboundLinkForConversation: returns the most recent inbound link within the cutoff", async () => {
  const ctx = await makeConversationCtx("recent-happy")
  const now = Date.now()
  const olderId = await insertConversationItem(ctx, "older")
  const newerId = await insertConversationItem(ctx, "newer")
  await insertInboundLink(ctx, {
    itemId: olderId,
    externalMessageId: "om_older",
    createdAt: new Date(now - 120_000),
  })
  await insertInboundLink(ctx, {
    itemId: newerId,
    externalMessageId: "om_newer",
    createdAt: new Date(now - 30_000),
  })
  const cutoff = new Date(now - 5 * 60 * 1000).toISOString()
  const link = await findRecentInboundLinkForConversation(
    ctx.conversationId,
    cutoff
  )
  assert.ok(link)
  assert.equal(link!.externalMessageId, "om_newer")
})

test(
  "findRecentInboundLinkForConversation: NULL external_message_id on the newest row " +
    "does NOT hide an older valid row (proves the WHERE filter is active)",
  async () => {
    const ctx = await makeConversationCtx("recent-null-newer")
    const now = Date.now()
    const olderId = await insertConversationItem(ctx, "older")
    const newerId = await insertConversationItem(ctx, "newer-null")
    await insertInboundLink(ctx, {
      itemId: olderId,
      externalMessageId: "om_older_valid",
      createdAt: new Date(now - 60_000),
    })
    await insertInboundLink(ctx, {
      itemId: newerId,
      externalMessageId: null,
      createdAt: new Date(now - 10_000),
    })
    const cutoff = new Date(now - 5 * 60 * 1000).toISOString()
    const link = await findRecentInboundLinkForConversation(
      ctx.conversationId,
      cutoff
    )
    assert.ok(link, "older valid row must be returned")
    assert.equal(link!.externalMessageId, "om_older_valid")
  }
)

test(
  "findRecentInboundLinkForConversation: empty-string external_message_id on the newest row " +
    "does NOT hide an older valid row (proves the BTRIM+NULLIF predicate)",
  async () => {
    const ctx = await makeConversationCtx("recent-empty-newer")
    const now = Date.now()
    const olderId = await insertConversationItem(ctx, "older")
    const newerId = await insertConversationItem(ctx, "newer-empty")
    await insertInboundLink(ctx, {
      itemId: olderId,
      externalMessageId: "om_older_valid",
      createdAt: new Date(now - 60_000),
    })
    await insertInboundLink(ctx, {
      itemId: newerId,
      externalMessageId: "",
      createdAt: new Date(now - 10_000),
    })
    const cutoff = new Date(now - 5 * 60 * 1000).toISOString()
    const link = await findRecentInboundLinkForConversation(
      ctx.conversationId,
      cutoff
    )
    assert.ok(link)
    assert.equal(link!.externalMessageId, "om_older_valid")
  }
)

test(
  "findRecentInboundLinkForConversation: whitespace-only external_message_id on the newest row " +
    "does NOT hide an older valid row",
  async () => {
    const ctx = await makeConversationCtx("recent-ws-newer")
    const now = Date.now()
    const olderId = await insertConversationItem(ctx, "older")
    const newerId = await insertConversationItem(ctx, "newer-ws")
    await insertInboundLink(ctx, {
      itemId: olderId,
      externalMessageId: "om_older_valid",
      createdAt: new Date(now - 60_000),
    })
    await insertInboundLink(ctx, {
      itemId: newerId,
      externalMessageId: "   ",
      createdAt: new Date(now - 10_000),
    })
    const cutoff = new Date(now - 5 * 60 * 1000).toISOString()
    const link = await findRecentInboundLinkForConversation(
      ctx.conversationId,
      cutoff
    )
    assert.ok(link)
    assert.equal(link!.externalMessageId, "om_older_valid")
  }
)

test("findRecentInboundLinkForConversation: returns null when no inbound link is within the cutoff", async () => {
  const ctx = await makeConversationCtx("recent-stale")
  const itemId = await insertConversationItem(ctx)
  await insertInboundLink(ctx, {
    itemId,
    externalMessageId: "om_old",
    createdAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
  })
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  const link = await findRecentInboundLinkForConversation(
    ctx.conversationId,
    cutoff
  )
  assert.equal(link, null)
})

// ─── computeStatusFallbackCutoffIso integration ────────────────────

test(
  "computeStatusFallbackCutoffIso: end-to-end with a real running turn " +
    "(loader returns ISO string; cutoff equals started_at)",
  async () => {
    const ctx = await makeConversationCtx("cutoff-end-to-end")
    const startedAt = new Date(Date.now() - 90_000)
    await insertTurn(ctx, {
      status: "running",
      startedAt,
    })
    const turn = await loadCurrentRunningTurnRow(ctx.sessionId)
    assert.ok(turn)
    const cutoff = computeStatusFallbackCutoffIso(turn, Date.now())
    assert.equal(cutoff, startedAt.toISOString())
  }
)
