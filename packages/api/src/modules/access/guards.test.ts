import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { withTestDb } from "../../test/helpers/db.js"
import { createRequireRequestAction } from "./guards.js"
import { grantApprovedContactVisibility } from "./contact-approval.js"
import { upsertAccessSubject } from "./subject-registry.js"
import { SUBJECT_KIND } from "@synapse/shared"

type AnyDb = import("kysely").Kysely<any>

async function insertUser(db: AnyDb): Promise<string> {
  const row = await db
    .insertInto("users")
    .values({
      email: `u-${Math.random().toString(36).slice(2, 10)}@example.test`,
      name: "test user",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertWorkspace(db: AnyDb, ownerId: string): Promise<string> {
  const row = await db
    .insertInto("workspaces")
    .values({
      owner_id: ownerId,
      slug: `ws-${Math.random().toString(36).slice(2, 10)}`,
      name: "test workspace",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertWorkspaceMember(
  db: AnyDb,
  workspaceId: string,
  userId: string
): Promise<string> {
  const row = await db
    .insertInto("workspace_members")
    .values({
      workspace_id: workspaceId,
      user_id: userId,
      trust_level: "member",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function creatorSubjectId(
  db: AnyDb,
  workspaceId: string
): Promise<string> {
  const memberId = await insertWorkspaceMember(
    db,
    workspaceId,
    await insertUser(db)
  )
  return upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId,
  })
}

async function insertActor(db: AnyDb, workspaceId: string): Promise<string> {
  const actorId = crypto.randomUUID()
  await db
    .insertInto("workspace_resources")
    .values({
      id: actorId,
      workspace_id: workspaceId,
      kind: "actor",
      display_name: "test actor",
      status: "active",
      created_by_subject_id: await creatorSubjectId(db, workspaceId),
    })
    .execute()
  const row = await db
    .insertInto("actors")
    .values({
      id: actorId,
      role: "assistant",
      title: "test",
      current_version: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

type ReplyMock = {
  statusCode: number
  body: unknown
  status: (code: number) => ReplyMock
  send: (body: unknown) => ReplyMock
}

function mockReply(): ReplyMock {
  const reply: ReplyMock = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code
      return this
    },
    send(body: unknown) {
      this.body = body
      return this
    },
  }
  return reply
}

function mockRequest(opts: {
  userId?: string
  workspaceMemberId?: string
}): any {
  return {
    user: opts.userId ? { userId: opts.userId } : undefined,
    workspaceMember: opts.workspaceMemberId
      ? { id: opts.workspaceMemberId }
      : undefined,
  }
}

test(
  "requireRequestAction returns true and leaves reply unchanged when allowed",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, ownerId)
      const guestUserId = await insertUser(db)
      const memberId = await insertWorkspaceMember(db, workspaceId, guestUserId)
      const actorId = await insertActor(db, workspaceId)
      await grantApprovedContactVisibility(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        grantedToMemberId: memberId,
      })

      const guard = createRequireRequestAction(db)
      const reply = mockReply()
      const allowed = await guard(
        mockRequest({ userId: guestUserId, workspaceMemberId: memberId }),
        reply as any,
        "actor.invoke",
        actorId
      )
      assert.equal(allowed, true)
      assert.equal(reply.statusCode, 200)
      assert.equal(reply.body, undefined)
    })
  }
)

test(
  "requireRequestAction returns false and sends a 403 reply when denied",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, ownerId)
      const guestUserId = await insertUser(db)
      const memberId = await insertWorkspaceMember(db, workspaceId, guestUserId)
      const actorId = await insertActor(db, workspaceId)

      const guard = createRequireRequestAction(db)
      const reply = mockReply()
      const allowed = await guard(
        mockRequest({ userId: guestUserId, workspaceMemberId: memberId }),
        reply as any,
        "actor.invoke",
        actorId,
        "Not allowed to invoke this actor"
      )
      assert.equal(allowed, false)
      assert.equal(reply.statusCode, 403)
      assert.deepEqual(reply.body, {
        error: "Not allowed to invoke this actor",
      })
    })
  }
)

test(
  "requireRequestAction uses the request's user when no workspaceMember is decorated",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const actorId = await insertActor(db, workspaceId)
      const guard = createRequireRequestAction(db)
      const reply = mockReply()
      const allowed = await guard(
        mockRequest({ userId }),
        reply as any,
        "actor.invoke",
        actorId
      )
      // user-subject without a workspace_member fails actor.invoke (the
      // evaluator's hasActorPermission branch returns false for non-member
      // subjects).
      assert.equal(allowed, false)
      assert.equal(reply.statusCode, 403)
    })
  }
)

test(
  "requireRequestAction throws when the request carries no authenticated user",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const actorId = await insertActor(db, workspaceId)
      const guard = createRequireRequestAction(db)
      const reply = mockReply()
      await assert.rejects(
        guard(mockRequest({}), reply as any, "actor.invoke", actorId),
        /Authenticated user is missing/
      )
    })
  }
)
