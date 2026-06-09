import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { withTestDb } from "../../test/helpers/db.js"
import {
  authorizeAction,
  authorizePermission,
  resolveWorkspaceAccessSubject,
  userSubject,
  workspaceMemberSubject,
} from "./service.js"
import {
  grantApprovedContactVisibility,
  setRequiresContactApproval,
} from "./contact-approval.js"

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

async function insertActor(db: AnyDb, workspaceId: string): Promise<string> {
  const actorId = crypto.randomUUID()
  await db
    .insertInto("workspace_apps")
    .values({
      id: actorId,
      workspace_id: workspaceId,
      kind: "actor",
      display_name: "test actor",
      status: "active",
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

test(
  "resolveWorkspaceAccessSubject returns a workspace_member subject when the user belongs to the workspace",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const subject = await resolveWorkspaceAccessSubject(
        db,
        workspaceId,
        userId
      )
      assert.deepEqual(subject, { type: "workspace_member", id: memberId })
    })
  }
)

test(
  "resolveWorkspaceAccessSubject falls back to user subject when no member row exists",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const otherUserId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, otherUserId)
      const subject = await resolveWorkspaceAccessSubject(
        db,
        workspaceId,
        userId
      )
      assert.deepEqual(subject, { type: "user", id: userId })
    })
  }
)

test(
  "authorizeAction(actor.invoke) returns false for a non-owner member with no grant, true after approved contact visibility",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      // Owner user creates the workspace + actor; a separate guest user is
      // added as a regular workspace member (no admin/owner RBAC).
      const ownerId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, ownerId)
      const guestUserId = await insertUser(db)
      const memberId = await insertWorkspaceMember(db, workspaceId, guestUserId)
      const actorId = await insertActor(db, workspaceId)

      const subject = workspaceMemberSubject(memberId)
      const before = await authorizeAction(db, {
        subject,
        action: "actor.invoke",
        resourceId: actorId,
      })
      assert.equal(before, false)

      await grantApprovedContactVisibility(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        grantedToMemberId: memberId,
      })

      const after = await authorizeAction(db, {
        subject,
        action: "actor.invoke",
        resourceId: actorId,
      })
      assert.equal(after, true)
    })
  }
)

test(
  "authorizePermission bypasses the action spec and consults the evaluator directly",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, ownerId)
      const guestUserId = await insertUser(db)
      const memberId = await insertWorkspaceMember(db, workspaceId, guestUserId)
      const actorId = await insertActor(db, workspaceId)
      await setRequiresContactApproval(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        requiresContactApproval: false,
      })

      const allowed = await authorizePermission(db, {
        subject: workspaceMemberSubject(memberId),
        resourceType: "actor",
        resourceId: actorId,
        permission: "invoke",
      })
      assert.equal(allowed, true)
    })
  }
)

test(
  "authorizeAction returns false for a user-subject that isn't a workspace member",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const actorId = await insertActor(db, workspaceId)
      const allowed = await authorizeAction(db, {
        subject: userSubject(userId),
        action: "actor.invoke",
        resourceId: actorId,
      })
      assert.equal(allowed, false)
    })
  }
)
