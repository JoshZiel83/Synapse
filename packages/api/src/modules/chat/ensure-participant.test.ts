import test from "node:test"
import assert from "node:assert/strict"
import { withTestDbAndClient } from "../../test/helpers/db.js"

type AnyDb = import("kysely").Kysely<any>

async function insertUser(db: AnyDb): Promise<string> {
  const row = await db
    .insertInto("users")
    .values({
      email: `u-${Math.random().toString(36).slice(2, 10)}@example.test`,
      name: "test user",
      password_hash: "unused-hash",
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
  const row = await db
    .insertInto("actors")
    .values({
      workspace_id: workspaceId,
      name: "test actor",
      role: "assistant",
      title: "test",
      current_version: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertConversation(
  db: AnyDb,
  workspaceId: string
): Promise<string> {
  const row = await db
    .insertInto("conversations")
    .values({
      kind: "group",
      boundary: "internal",
      internal_workspace_id: workspaceId,
      title: "test conversation",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test(
  "ensureConversationParticipant inserts then updates without writing dropped polymorphic columns",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const actorId = await insertActor(db, workspaceId)
      const conversationId = await insertConversation(db, workspaceId)

      const { ensureConversationParticipant } = await import("./service.js")

      const first = await ensureConversationParticipant({
        conversationId,
        participantKind: "actor",
        actorId,
        roleKey: "member",
        displayName: "first display",
        queryable: client,
      })
      assert.ok(first)
      const firstId = (first as { id: string }).id
      assert.ok(firstId)

      // Hit the existing-participant UPDATE branch.
      const again = await ensureConversationParticipant({
        conversationId,
        participantKind: "actor",
        actorId,
        roleKey: "owner",
        displayName: "second display",
        metadata: { rejoined: true },
        queryable: client,
      })
      assert.ok(again)
      const againId = (again as { id: string }).id
      assert.equal(againId, firstId)

      const row = await db
        .selectFrom("conversation_participants")
        .selectAll()
        .where("id", "=", firstId)
        .executeTakeFirstOrThrow()
      assert.equal(row.role_key, "owner")
      assert.equal(row.display_name, "second display")
      assert.equal(row.state, "active")
      assert.ok(row.subject_id)
    })
  }
)

test(
  "ensureConversationParticipant (workspace_member) idempotent re-call updates state without touching dropped columns",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const conversationId = await insertConversation(db, workspaceId)

      const { ensureConversationParticipant } = await import("./service.js")

      const first = await ensureConversationParticipant({
        conversationId,
        participantKind: "workspace_member",
        workspaceMemberId: memberId,
        roleKey: "member",
        queryable: client,
      })
      const firstId = (first as { id: string }).id

      // Soft-leave the participant directly so we can verify the UPDATE
      // reactivates it (the COALESCE in the UPDATE keeps display_name etc).
      await db
        .updateTable("conversation_participants")
        .set({ state: "left" })
        .where("id", "=", firstId)
        .execute()

      const again = await ensureConversationParticipant({
        conversationId,
        participantKind: "workspace_member",
        workspaceMemberId: memberId,
        queryable: client,
      })
      const againId = (again as { id: string }).id
      assert.equal(againId, firstId)

      const row = await db
        .selectFrom("conversation_participants")
        .selectAll()
        .where("id", "=", firstId)
        .executeTakeFirstOrThrow()
      assert.equal(row.state, "active")
      assert.equal(row.left_at, null)
    })
  }
)
