import test from "node:test"
import assert from "node:assert/strict"
import type { Kysely } from "kysely"
import { withTestDb } from "../../../test/helpers/db.js"
import { recoverSkippedDisabledLink } from "./repo-recovery.js"
import { canDeliverNowWithDeps, type CanDeliverNowDeps } from "./recovery.js"

type AnyDb = Kysely<any>
type LinkSnapshot = Awaited<ReturnType<CanDeliverNowDeps["loadLink"]>>
type BindingSnapshot = Awaited<ReturnType<CanDeliverNowDeps["getBinding"]>>

function rid(): string {
  return Math.random().toString(36).slice(2, 10)
}

async function insertUser(db: AnyDb): Promise<string> {
  const row = await db
    .insertInto("users")
    .values({ email: `${rid()}@im-recovery.test`, name: "im recovery" })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertRecoveryFixture(db: AnyDb): Promise<{
  workspaceId: string
  conversationId: string
  transportAccountId: string
  transportEndpointId: string
}> {
  const ownerId = await insertUser(db)
  const workspace = await db
    .insertInto("workspaces")
    .values({
      ownerId,
      slug: `im-rec-${rid()}`,
      name: "IM recovery",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const conversation = await db
    .insertInto("conversations")
    .values({
      workspaceId: workspace.id as string,
      kind: "group",
      title: "IM recovery",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const account = await db
    .insertInto("transportAccounts")
    .values({
      workspaceId: workspace.id as string,
      transportKind: "qq",
      accountKey: `acct-${rid()}`,
      displayName: "IM recovery account",
      connectionMode: "webhook",
      ownerScope: "workspace",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const endpoint = await db
    .insertInto("transportEndpoints")
    .values({
      transportAccountId: account.id as string,
      endpointType: "group",
      externalId: `ep-${rid()}`,
      displayName: "IM recovery endpoint",
    })
    .returning("id")
    .executeTakeFirstOrThrow()

  return {
    workspaceId: workspace.id as string,
    conversationId: conversation.id as string,
    transportAccountId: account.id as string,
    transportEndpointId: endpoint.id as string,
  }
}

async function insertConversationItem(
  db: AnyDb,
  conversationId: string
): Promise<string> {
  const item = await db
    .insertInto("conversationItems")
    .values({
      conversationId,
      scope: "shared",
      surface: "visible",
      itemType: "message",
      subtype: "user_message",
      role: "user",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return item.id as string
}

async function insertTransportMessageLink(
  db: AnyDb,
  params: Awaited<ReturnType<typeof insertRecoveryFixture>> & {
    deliveryStatus: "pending" | "skipped"
    metadata: Record<string, unknown>
  }
): Promise<string> {
  const itemId = await insertConversationItem(db, params.conversationId)
  const link = await db
    .insertInto("transportMessageLinks")
    .values({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      itemId,
      transportAccountId: params.transportAccountId,
      transportEndpointId: params.transportEndpointId,
      transportKind: "qq",
      direction: "outbound",
      deliveryStatus: params.deliveryStatus,
      metadata: params.metadata,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return link.id as string
}

async function loadTransportMessageLink(
  db: AnyDb,
  linkId: string
): Promise<{ deliveryStatus: string; metadata: Record<string, unknown> }> {
  const row = await db
    .selectFrom("transportMessageLinks")
    .select(["deliveryStatus", "metadata"])
    .where("id", "=", linkId)
    .executeTakeFirstOrThrow()
  return {
    deliveryStatus: row.deliveryStatus as string,
    metadata: row.metadata as Record<string, unknown>,
  }
}

function link(
  overrides: Partial<NonNullable<LinkSnapshot>> = {}
): LinkSnapshot {
  return {
    workspaceId: "ws-1",
    conversationId: "conv-1",
    transportAccountId: "acc-1",
    transportEndpointId: "ep-1",
    ...overrides,
  }
}

function binding(
  overrides: Partial<NonNullable<BindingSnapshot>> = {}
): BindingSnapshot {
  return {
    account: { id: "acc-1", status: "active" },
    endpoint: { id: "ep-1" },
    outboundEnabled: true,
    ...overrides,
  }
}

function deps(params: {
  link: LinkSnapshot
  binding?: BindingSnapshot
  calls?: string[]
}): CanDeliverNowDeps {
  return {
    loadLink: async () => {
      params.calls?.push("loadLink")
      return params.link
    },
    getBinding: async (query) => {
      params.calls?.push(
        `getBinding:${query.workspaceId}:${query.conversationId}`
      )
      return params.binding
    },
  }
}

test("recoverSkippedDisabledLink flips skipped links and clears skippedReason", async () => {
  await withTestDb(async (db) => {
    const fixture = await insertRecoveryFixture(db)
    const linkId = await insertTransportMessageLink(db, {
      ...fixture,
      deliveryStatus: "skipped",
      metadata: {
        skippedReason: "account_disabled",
        delivery: { sweeperRetryCount: 2 },
      },
    })

    await recoverSkippedDisabledLink(linkId, db)

    const row = await loadTransportMessageLink(db, linkId)
    assert.equal(row.deliveryStatus, "pending")
    assert.equal("skippedReason" in row.metadata, false)
    assert.deepEqual(row.metadata.delivery, { sweeperRetryCount: 2 })
  })
})

test("recoverSkippedDisabledLink leaves non-skipped link metadata untouched", async () => {
  await withTestDb(async (db) => {
    const fixture = await insertRecoveryFixture(db)
    const linkId = await insertTransportMessageLink(db, {
      ...fixture,
      deliveryStatus: "pending",
      metadata: {
        skippedReason: "account_disabled",
        delivery: { sweeperRetryCount: 2 },
      },
    })

    await recoverSkippedDisabledLink(linkId, db)

    const row = await loadTransportMessageLink(db, linkId)
    assert.equal(row.deliveryStatus, "pending")
    assert.equal(row.metadata.skippedReason, "account_disabled")
    assert.deepEqual(row.metadata.delivery, { sweeperRetryCount: 2 })
  })
})

test("canDeliverNowWithDeps returns link_not_found without binding lookup", async () => {
  const calls: string[] = []

  const result = await canDeliverNowWithDeps(
    "link-1",
    deps({ link: null, binding: binding(), calls })
  )

  assert.deepEqual(result, { ok: false, reason: "link_not_found" })
  assert.deepEqual(calls, ["loadLink"])
})

test("canDeliverNowWithDeps returns binding_missing for missing current binding", async () => {
  const calls: string[] = []

  const result = await canDeliverNowWithDeps(
    "link-1",
    deps({ link: link(), binding: null, calls })
  )

  assert.deepEqual(result, { ok: false, reason: "binding_missing" })
  assert.deepEqual(calls, ["loadLink", "getBinding:ws-1:conv-1"])
})

test("canDeliverNowWithDeps rejects disabled account before outbound check", async () => {
  const result = await canDeliverNowWithDeps(
    "link-1",
    deps({
      link: link(),
      binding: binding({
        account: { id: "acc-1", status: "disabled" },
        outboundEnabled: false,
      }),
    })
  )

  assert.deepEqual(result, { ok: false, reason: "account_disabled" })
})

test("canDeliverNowWithDeps rejects disabled outbound binding", async () => {
  const result = await canDeliverNowWithDeps(
    "link-1",
    deps({ link: link(), binding: binding({ outboundEnabled: false }) })
  )

  assert.deepEqual(result, { ok: false, reason: "outbound_disabled" })
})

test("canDeliverNowWithDeps rejects account or endpoint mismatch", async () => {
  assert.deepEqual(
    await canDeliverNowWithDeps(
      "link-1",
      deps({
        link: link(),
        binding: binding({ account: { id: "acc-2", status: "active" } }),
      })
    ),
    { ok: false, reason: "endpoint_mismatch" }
  )
  assert.deepEqual(
    await canDeliverNowWithDeps(
      "link-1",
      deps({
        link: link(),
        binding: binding({ endpoint: { id: "ep-2" } }),
      })
    ),
    { ok: false, reason: "endpoint_mismatch" }
  )
})

test("canDeliverNowWithDeps accepts matching active outbound binding", async () => {
  const result = await canDeliverNowWithDeps(
    "link-1",
    deps({ link: link(), binding: binding() })
  )

  assert.deepEqual(result, { ok: true })
})
