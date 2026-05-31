import test from "node:test"
import assert from "node:assert/strict"
import { SUBJECT_KIND } from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { canUserAccessContent } from "./content-access.js"

/**
 * contentAccessResolver — GET /api/v1/content/:sha256 authorization. A sha is
 * not an authorization token; access is granted iff the caller can reach the
 * bytes through some legitimate reference. These tests cover the two paths that
 * are live without the sandbox runtime:
 *   (a) message-ref — a file_ref part in a conversation the user participates in
 *   (d) asset       — an entity asset in the user's workspace
 * plus the negative case (a non-member is denied).
 */

const NS = "cax"
const SHA_A = "a".repeat(64)
const SHA_B = "b".repeat(64)

function rid(): string {
  return Math.random().toString(36).slice(2, 10)
}

async function newUser(db: Kysely<any>): Promise<string> {
  const u = await db
    .insertInto("users")
    .values({ email: `${rid()}@${NS}`, name: "u", password_hash: "x" })
    .returning("id")
    .executeTakeFirstOrThrow()
  return u.id as string
}

async function newWorkspace(db: Kysely<any>, ownerId: string): Promise<string> {
  const ws = await db
    .insertInto("workspaces")
    .values({ owner_id: ownerId, slug: `ws-${rid()}`, name: `${NS} ws` })
    .returning("id")
    .executeTakeFirstOrThrow()
  return ws.id as string
}

async function addMember(
  db: Kysely<any>,
  wsId: string,
  userId: string
): Promise<string> {
  const m = await db
    .insertInto("workspace_members")
    .values({
      workspace_id: wsId,
      user_id: userId,
      trust_level: "member",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return m.id as string
}

async function putContentBlob(db: Kysely<any>, sha: string): Promise<void> {
  await db
    .insertInto("content_blobs")
    .values({ sha256: sha, size_bytes: 3, backend: "local_cas" } as any)
    .onConflict((oc: any) => oc.doNothing())
    .execute()
}

test("contentAccessResolver", async (t) => {
  await t.test("(d) asset in user's workspace → allowed", async () => {
    await withTestDb(async (db) => {
      const owner = await newUser(db)
      const ws = await newWorkspace(db, owner)
      await putContentBlob(db, SHA_A)
      await db
        .insertInto("file_assets")
        .values({
          workspace_id: ws,
          content_sha256: SHA_A,
          original_name: "x.png",
          mime_type: "image/png",
          content_kind: "image",
          size_bytes: 3,
          source_family: "user_upload",
          source_system: "web",
        } as any)
        .execute()

      const allowed = await canUserAccessContent(SHA_A, owner, { dbh: db })
      assert.equal(allowed, true)
    })
  })

  await t.test("(d) asset, non-member user → denied", async () => {
    await withTestDb(async (db) => {
      const owner = await newUser(db)
      const stranger = await newUser(db)
      const ws = await newWorkspace(db, owner)
      await putContentBlob(db, SHA_A)
      await db
        .insertInto("file_assets")
        .values({
          workspace_id: ws,
          content_sha256: SHA_A,
          original_name: "x.png",
          mime_type: "image/png",
          content_kind: "image",
          size_bytes: 3,
          source_family: "user_upload",
          source_system: "web",
        } as any)
        .execute()

      const allowed = await canUserAccessContent(SHA_A, stranger, { dbh: db })
      assert.equal(allowed, false)
    })
  })

  await t.test(
    "(a) message-ref: active participant of the conversation → allowed",
    async () => {
      await withTestDb(async (db) => {
        const owner = await newUser(db)
        const ws = await newWorkspace(db, owner)
        const memberId = await addMember(db, ws, owner)
        await putContentBlob(db, SHA_B)

        const conv = await db
          .insertInto("conversations")
          .values({
            workspace_id: ws,
            kind: "direct",
            title: "t",
            created_by_workspace_member_id: memberId,
          } as any)
          .returning("id")
          .executeTakeFirstOrThrow()

        const subjId = await upsertAccessSubject(db as any, {
          kind: SUBJECT_KIND.WORKSPACE_MEMBER,
          memberId,
        })
        await db
          .insertInto("conversation_participants")
          .values({
            conversation_id: conv.id,
            subject_id: subjId,
            role_key: "member",
            state: "active",
          } as any)
          .execute()

        const item = await db
          .insertInto("conversation_items")
          .values({
            conversation_id: conv.id,
            scope: "shared",
            surface: "visible",
            item_type: "message",
            subtype: "user_message",
            role: "user",
          } as any)
          .returning("id")
          .executeTakeFirstOrThrow()
        await db
          .insertInto("conversation_item_parts")
          .values({
            item_id: item.id,
            ordinal: 0,
            part_type: "file_ref",
            ref_sha256: SHA_B,
            ref_path: "/conversation/x.png",
            mime_type: "image/png",
            name: "x.png",
          } as any)
          .execute()

        const allowed = await canUserAccessContent(SHA_B, owner, { dbh: db })
        assert.equal(allowed, true)
      })
    }
  )

  await t.test("(a) message-ref: non-participant user → denied", async () => {
    await withTestDb(async (db) => {
      const owner = await newUser(db)
      const stranger = await newUser(db)
      const ws = await newWorkspace(db, owner)
      const memberId = await addMember(db, ws, owner)
      await putContentBlob(db, SHA_B)

      const conv = await db
        .insertInto("conversations")
        .values({
          workspace_id: ws,
          kind: "direct",
          title: "t",
          created_by_workspace_member_id: memberId,
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()

      const subjId = await upsertAccessSubject(db as any, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId,
      })
      await db
        .insertInto("conversation_participants")
        .values({
          conversation_id: conv.id,
          subject_id: subjId,
          role_key: "member",
          state: "active",
        } as any)
        .execute()

      const item = await db
        .insertInto("conversation_items")
        .values({
          conversation_id: conv.id,
          scope: "shared",
          surface: "visible",
          item_type: "message",
          subtype: "user_message",
          role: "user",
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      await db
        .insertInto("conversation_item_parts")
        .values({
          item_id: item.id,
          ordinal: 0,
          part_type: "file_ref",
          ref_sha256: SHA_B,
          ref_path: "/conversation/x.png",
          mime_type: "image/png",
          name: "x.png",
        } as any)
        .execute()

      // stranger is not a member nor participant → no reference is reachable.
      const allowed = await canUserAccessContent(SHA_B, stranger, { dbh: db })
      assert.equal(allowed, false)
    })
  })

  await t.test(
    "(a) message-ref: directed message denies a non-targeted participant",
    async () => {
      await withTestDb(async (db) => {
        const userA = await newUser(db) // author + target
        const userB = await newUser(db) // participant but NOT targeted
        const ws = await newWorkspace(db, userA)
        const memberA = await addMember(db, ws, userA)
        // memberB: a second workspace member + active participant.
        await db
          .insertInto("workspace_members")
          .values({
            workspace_id: ws,
            user_id: userB,
            trust_level: "member",
          } as any)
          .execute()
        const memberBRow = await db
          .selectFrom("workspace_members")
          .select("id")
          .where("workspace_id", "=", ws)
          .where("user_id", "=", userB)
          .executeTakeFirstOrThrow()
        const memberB = memberBRow.id as string
        await putContentBlob(db, SHA_B)

        const conv = await db
          .insertInto("conversations")
          .values({
            workspace_id: ws,
            kind: "group",
            title: "t",
            created_by_workspace_member_id: memberA,
          } as any)
          .returning("id")
          .executeTakeFirstOrThrow()

        const subjA = await upsertAccessSubject(db as any, {
          kind: SUBJECT_KIND.WORKSPACE_MEMBER,
          memberId: memberA,
        })
        const subjB = await upsertAccessSubject(db as any, {
          kind: SUBJECT_KIND.WORKSPACE_MEMBER,
          memberId: memberB,
        })
        const partA = await db
          .insertInto("conversation_participants")
          .values({
            conversation_id: conv.id,
            subject_id: subjA,
            role_key: "member",
            state: "active",
          } as any)
          .returning("id")
          .executeTakeFirstOrThrow()
        await db
          .insertInto("conversation_participants")
          .values({
            conversation_id: conv.id,
            subject_id: subjB,
            role_key: "member",
            state: "active",
          } as any)
          .execute()

        // A directed (audience-restricted) item authored by A, targeting A only.
        const item = await db
          .insertInto("conversation_items")
          .values({
            conversation_id: conv.id,
            scope: "shared",
            surface: "visible",
            item_type: "message",
            subtype: "user_message",
            role: "user",
            author_participant_id: partA.id,
          } as any)
          .returning("id")
          .executeTakeFirstOrThrow()
        await db
          .insertInto("conversation_item_parts")
          .values({
            item_id: item.id,
            ordinal: 0,
            part_type: "file_ref",
            ref_sha256: SHA_B,
            ref_path: "/conversation/secret.png",
            mime_type: "image/png",
            name: "secret.png",
          } as any)
          .execute()
        await db
          .insertInto("conversation_item_targets")
          .values({
            item_id: item.id,
            target_participant_id: partA.id,
            target_kind: "to",
          } as any)
          .execute()

        // A (author + target) can read; B (participant but not targeted) cannot.
        assert.equal(
          await canUserAccessContent(SHA_B, userA, { dbh: db }),
          true
        )
        assert.equal(
          await canUserAccessContent(SHA_B, userB, { dbh: db }),
          false
        )
      })
    }
  )
})

const SHA_M = "e".repeat(64)

// Helper: an actor-owned (private) memory space with one item part referencing
// SHA_M. Returns the ids needed to grant access.
async function seedPrivateMemoryRef(db: Kysely<any>) {
  const owner = await db
    .insertInto("users")
    .values({ email: `${rid()}@mem`, name: "u", password_hash: "x" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({ owner_id: owner.id, slug: `ws-${rid()}`, name: "mem ws" })
    .returning("id")
    .executeTakeFirstOrThrow()
  // A workspace MEMBER who is not the memory owner.
  const memberUser = await db
    .insertInto("users")
    .values({ email: `${rid()}@mem`, name: "m", password_hash: "x" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const member = await db
    .insertInto("workspace_members")
    .values({
      workspace_id: ws.id,
      user_id: memberUser.id,
      trust_level: "member",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const memberSubjectId = await upsertAccessSubject(db as any, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId: member.id,
  })
  // The memory space is owned by an ACTOR (private to that actor).
  const actor = await db
    .insertInto("actors")
    .values({
      workspace_id: ws.id,
      name: `a-${rid()}`,
      role: "assistant",
      title: "t",
      current_version: 1,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const actorSubjectId = await upsertAccessSubject(db as any, {
    kind: SUBJECT_KIND.ACTOR,
    actorId: actor.id,
  })
  const space = await db
    .insertInto("memory_spaces")
    .values({
      workspace_id: ws.id,
      owner_subject_id: actorSubjectId,
      namespace_key: "default",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const item = await db
    .insertInto("memory_items")
    .values({
      workspace_id: ws.id,
      memory_space_id: space.id,
      category: "fact",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  await db
    .insertInto("content_blobs")
    .values({ sha256: SHA_M, size_bytes: 3, backend: "local_cas" } as any)
    .onConflict((oc: any) => oc.doNothing())
    .execute()
  await db
    .insertInto("memory_item_parts")
    .values({
      memory_item_id: item.id,
      ordinal: 0,
      part_type: "file_ref",
      ref_sha256: SHA_M,
      mime_type: "image/png",
      name: "m.png",
    } as any)
    .execute()
  return {
    workspaceId: ws.id as string,
    memberUserId: memberUser.id as string,
    memberSubjectId,
    spaceId: space.id as string,
  }
}

test("contentAccessResolver memory ACL", async (t) => {
  await t.test(
    "(b) private actor memory: a workspace member without a grant is DENIED",
    async () => {
      await withTestDb(async (db) => {
        const { memberUserId } = await seedPrivateMemoryRef(db)
        // Member is in the workspace but does NOT own the actor space and has no
        // grant → must be denied (the pre-fix bug allowed this).
        assert.equal(
          await canUserAccessContent(SHA_M, memberUserId, { dbh: db }),
          false
        )
      })
    }
  )

  await t.test(
    "(b) private actor memory: an active read grant to the member ALLOWS",
    async () => {
      await withTestDb(async (db) => {
        const { workspaceId, memberUserId, memberSubjectId, spaceId } =
          await seedPrivateMemoryRef(db)
        await db
          .insertInto("memory_access_grants")
          .values({
            workspace_id: workspaceId,
            memory_space_id: spaceId,
            subject_id: memberSubjectId,
            permissions: ["read"],
            status: "active",
          } as any)
          .execute()
        assert.equal(
          await canUserAccessContent(SHA_M, memberUserId, { dbh: db }),
          true
        )
      })
    }
  )

  await t.test(
    "(b) private actor memory: a revoked grant does NOT allow",
    async () => {
      await withTestDb(async (db) => {
        const { workspaceId, memberUserId, memberSubjectId, spaceId } =
          await seedPrivateMemoryRef(db)
        await db
          .insertInto("memory_access_grants")
          .values({
            workspace_id: workspaceId,
            memory_space_id: spaceId,
            subject_id: memberSubjectId,
            permissions: ["read"],
            status: "revoked",
          } as any)
          .execute()
        assert.equal(
          await canUserAccessContent(SHA_M, memberUserId, { dbh: db }),
          false
        )
      })
    }
  )
})
