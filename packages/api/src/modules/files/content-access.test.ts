import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
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
    .values({ email: `${rid()}@${NS}`, name: "u" })
    .returning("id")
    .executeTakeFirstOrThrow()
  return u.id as string
}

async function newWorkspace(db: Kysely<any>, ownerId: string): Promise<string> {
  const ws = await db
    .insertInto("workspaces")
    .values({ ownerId: ownerId, slug: `ws-${rid()}`, name: `${NS} ws` })
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
    .insertInto("workspaceMembers")
    .values({
      workspaceId: wsId,
      userId: userId,
      trustLevel: "member",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return m.id as string
}

async function putContentBlob(db: Kysely<any>, sha: string): Promise<void> {
  await db
    .insertInto("contentBlobs")
    .values({ sha256: sha, sizeBytes: 3, backend: "local_cas" } as any)
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
        .insertInto("fileAssets")
        .values({
          workspaceId: ws,
          contentSha256: SHA_A,
          originalName: "x.png",
          mimeType: "image/png",
          contentKind: "image",
          sizeBytes: 3,
          sourceFamily: "user_upload",
          sourceSystem: "web",
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
        .insertInto("fileAssets")
        .values({
          workspaceId: ws,
          contentSha256: SHA_A,
          originalName: "x.png",
          mimeType: "image/png",
          contentKind: "image",
          sizeBytes: 3,
          sourceFamily: "user_upload",
          sourceSystem: "web",
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
            workspaceId: ws,
            kind: "direct",
            title: "t",
            createdByWorkspaceMemberId: memberId,
          } as any)
          .returning("id")
          .executeTakeFirstOrThrow()

        const subjId = await upsertAccessSubject(db as any, {
          kind: SUBJECT_KIND.WORKSPACE_MEMBER,
          workspaceMemberId: memberId,
        })
        await db
          .insertInto("conversationParticipants")
          .values({
            conversationId: conv.id,
            subjectId: subjId,
            roleKey: "member",
            state: "active",
          } as any)
          .execute()

        const item = await db
          .insertInto("conversationItems")
          .values({
            conversationId: conv.id,
            scope: "shared",
            surface: "visible",
            itemType: "message",
            subtype: "user_message",
            role: "user",
          } as any)
          .returning("id")
          .executeTakeFirstOrThrow()
        await db
          .insertInto("conversationItemParts")
          .values({
            itemId: item.id,
            ordinal: 0,
            partType: "file_ref",
            refSha256: SHA_B,
            refPath: "/conversation/x.png",
            mimeType: "image/png",
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
          workspaceId: ws,
          kind: "direct",
          title: "t",
          createdByWorkspaceMemberId: memberId,
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()

      const subjId = await upsertAccessSubject(db as any, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        workspaceMemberId: memberId,
      })
      await db
        .insertInto("conversationParticipants")
        .values({
          conversationId: conv.id,
          subjectId: subjId,
          roleKey: "member",
          state: "active",
        } as any)
        .execute()

      const item = await db
        .insertInto("conversationItems")
        .values({
          conversationId: conv.id,
          scope: "shared",
          surface: "visible",
          itemType: "message",
          subtype: "user_message",
          role: "user",
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      await db
        .insertInto("conversationItemParts")
        .values({
          itemId: item.id,
          ordinal: 0,
          partType: "file_ref",
          refSha256: SHA_B,
          refPath: "/conversation/x.png",
          mimeType: "image/png",
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
          .insertInto("workspaceMembers")
          .values({
            workspaceId: ws,
            userId: userB,
            trustLevel: "member",
          } as any)
          .execute()
        const memberBRow = await db
          .selectFrom("workspaceMembers")
          .select("id")
          .where("workspaceId", "=", ws)
          .where("userId", "=", userB)
          .executeTakeFirstOrThrow()
        const memberB = memberBRow.id as string
        await putContentBlob(db, SHA_B)

        const conv = await db
          .insertInto("conversations")
          .values({
            workspaceId: ws,
            kind: "group",
            title: "t",
            createdByWorkspaceMemberId: memberA,
          } as any)
          .returning("id")
          .executeTakeFirstOrThrow()

        const subjA = await upsertAccessSubject(db as any, {
          kind: SUBJECT_KIND.WORKSPACE_MEMBER,
          workspaceMemberId: memberA,
        })
        const subjB = await upsertAccessSubject(db as any, {
          kind: SUBJECT_KIND.WORKSPACE_MEMBER,
          workspaceMemberId: memberB,
        })
        const partA = await db
          .insertInto("conversationParticipants")
          .values({
            conversationId: conv.id,
            subjectId: subjA,
            roleKey: "member",
            state: "active",
          } as any)
          .returning("id")
          .executeTakeFirstOrThrow()
        await db
          .insertInto("conversationParticipants")
          .values({
            conversationId: conv.id,
            subjectId: subjB,
            roleKey: "member",
            state: "active",
          } as any)
          .execute()

        // A directed (audience-restricted) item authored by A, targeting A only.
        const item = await db
          .insertInto("conversationItems")
          .values({
            conversationId: conv.id,
            scope: "shared",
            surface: "visible",
            itemType: "message",
            subtype: "user_message",
            role: "user",
            authorParticipantId: partA.id,
          } as any)
          .returning("id")
          .executeTakeFirstOrThrow()
        await db
          .insertInto("conversationItemParts")
          .values({
            itemId: item.id,
            ordinal: 0,
            partType: "file_ref",
            refSha256: SHA_B,
            refPath: "/conversation/secret.png",
            mimeType: "image/png",
            name: "secret.png",
          } as any)
          .execute()
        await db
          .insertInto("conversationItemTargets")
          .values({
            itemId: item.id,
            targetParticipantId: partA.id,
            targetKind: "to",
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
    .values({ email: `${rid()}@mem`, name: "u" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({ ownerId: owner.id, slug: `ws-${rid()}`, name: "mem ws" })
    .returning("id")
    .executeTakeFirstOrThrow()
  // A workspace MEMBER who is not the memory owner.
  const memberUser = await db
    .insertInto("users")
    .values({ email: `${rid()}@mem`, name: "m" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const member = await db
    .insertInto("workspaceMembers")
    .values({
      workspaceId: ws.id,
      userId: memberUser.id,
      trustLevel: "member",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const memberSubjectId = await upsertAccessSubject(db as any, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    workspaceMemberId: member.id,
  })
  // The memory space is owned by an ACTOR (private to that actor).
  const actorRoot = await db
    .insertInto("workspaceResources")
    .values({
      id: crypto.randomUUID(),
      workspaceId: ws.id,
      kind: "actor",
      displayName: `a-${rid()}`,
      createdBySubjectId: memberSubjectId,
      status: "active",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const actor = await db
    .insertInto("actors")
    .values({
      id: actorRoot.id as string,
      role: "assistant",
      title: "t",
      currentVersion: 1,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const actorSubjectId = await upsertAccessSubject(db as any, {
    kind: SUBJECT_KIND.ACTOR,
    actorId: actor.id,
  })
  const space = await db
    .insertInto("memorySpaces")
    .values({
      workspaceId: ws.id,
      ownerSubjectId: actorSubjectId,
      namespaceKey: "default",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const item = await db
    .insertInto("memoryItems")
    .values({
      workspaceId: ws.id,
      memorySpaceId: space.id,
      category: "fact",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  await db
    .insertInto("contentBlobs")
    .values({ sha256: SHA_M, sizeBytes: 3, backend: "local_cas" } as any)
    .onConflict((oc: any) => oc.doNothing())
    .execute()
  await db
    .insertInto("memoryItemParts")
    .values({
      memoryItemId: item.id,
      ordinal: 0,
      partType: "file_ref",
      refSha256: SHA_M,
      mimeType: "image/png",
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
          .insertInto("memoryAccessGrants")
          .values({
            workspaceId: workspaceId,
            memorySpaceId: spaceId,
            subjectId: memberSubjectId,
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
          .insertInto("memoryAccessGrants")
          .values({
            workspaceId: workspaceId,
            memorySpaceId: spaceId,
            subjectId: memberSubjectId,
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

const SHA_FS = "f".repeat(64)

// A file_space + a snapshot whose MANIFEST sha IS the queried sha (so the
// reachability check hits the `snap.manifest_sha256 === sha` short-circuit and
// doesn't need a real CAS blob). Returns ids to attach a grant.
async function seedFileSpaceRef(
  db: Kysely<any>,
  opts: { ownerActor?: boolean } = {}
) {
  const owner = await db
    .insertInto("users")
    .values({ email: `${rid()}@fs`, name: "u" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({ ownerId: owner.id, slug: `ws-${rid()}`, name: "fs ws" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const memberUser = await db
    .insertInto("users")
    .values({ email: `${rid()}@fs`, name: "m" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const member = await db
    .insertInto("workspaceMembers")
    .values({
      workspaceId: ws.id,
      userId: memberUser.id,
      trustLevel: "member",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const memberSubjectId = await upsertAccessSubject(db as any, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    workspaceMemberId: member.id,
  })
  // The space is owned by an actor (so the member isn't owner-implicit).
  const actorRoot = await db
    .insertInto("workspaceResources")
    .values({
      id: crypto.randomUUID(),
      workspaceId: ws.id,
      kind: "actor",
      displayName: `a-${rid()}`,
      createdBySubjectId: memberSubjectId,
      status: "active",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const actor = await db
    .insertInto("actors")
    .values({
      id: actorRoot.id as string,
      role: "assistant",
      title: "t",
      currentVersion: 1,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const actorSubjectId = await upsertAccessSubject(db as any, {
    kind: SUBJECT_KIND.ACTOR,
    actorId: actor.id,
  })
  const space = await db
    .insertInto("fileSpaces")
    .values({
      workspaceId: ws.id,
      ownerSubjectId: actorSubjectId,
      namespaceKey: "default",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  // content_blob for the manifest sha + a snapshot whose manifest IS SHA_FS.
  await db
    .insertInto("contentBlobs")
    .values({ sha256: SHA_FS, sizeBytes: 1, backend: "local_cas" } as any)
    .onConflict((oc: any) => oc.doNothing())
    .execute()
  const snap = await db
    .insertInto("fileSnapshots")
    .values({
      workspaceId: ws.id,
      fileSpaceId: space.id,
      version: 1,
      manifestSha256: SHA_FS,
      reason: "manual",
      entryCount: 0,
      totalBytes: 0,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  await db
    .updateTable("fileSpaces")
    .set({ currentSnapshotId: snap.id } as any)
    .where("id", "=", space.id)
    .execute()
  void opts
  return {
    workspaceId: ws.id as string,
    memberUserId: memberUser.id as string,
    memberSubjectId,
    spaceId: space.id as string,
  }
}

test("contentAccessResolver file-space ACL", async (t) => {
  await t.test("(c) no grant → denied", async () => {
    await withTestDb(async (db) => {
      const { memberUserId } = await seedFileSpaceRef(db)
      assert.equal(
        await canUserAccessContent(SHA_FS, memberUserId, { dbh: db }),
        false
      )
    })
  })

  await t.test("(c) active read grant → allowed", async () => {
    await withTestDb(async (db) => {
      const { workspaceId, memberUserId, memberSubjectId, spaceId } =
        await seedFileSpaceRef(db)
      await db
        .insertInto("fileAccessGrants")
        .values({
          workspaceId: workspaceId,
          fileSpaceId: spaceId,
          subjectId: memberSubjectId,
          permissions: ["read"],
          status: "active",
        } as any)
        .execute()
      assert.equal(
        await canUserAccessContent(SHA_FS, memberUserId, { dbh: db }),
        true
      )
    })
  })

  await t.test(
    "(c) write-only grant does NOT confer read → denied",
    async () => {
      await withTestDb(async (db) => {
        const { workspaceId, memberUserId, memberSubjectId, spaceId } =
          await seedFileSpaceRef(db)
        await db
          .insertInto("fileAccessGrants")
          .values({
            workspaceId: workspaceId,
            fileSpaceId: spaceId,
            subjectId: memberSubjectId,
            permissions: ["write"],
            status: "active",
          } as any)
          .execute()
        assert.equal(
          await canUserAccessContent(SHA_FS, memberUserId, { dbh: db }),
          false
        )
      })
    }
  )

  await t.test("(c) admin grant confers read → allowed", async () => {
    await withTestDb(async (db) => {
      const { workspaceId, memberUserId, memberSubjectId, spaceId } =
        await seedFileSpaceRef(db)
      await db
        .insertInto("fileAccessGrants")
        .values({
          workspaceId: workspaceId,
          fileSpaceId: spaceId,
          subjectId: memberSubjectId,
          permissions: ["admin"],
          status: "active",
        } as any)
        .execute()
      assert.equal(
        await canUserAccessContent(SHA_FS, memberUserId, { dbh: db }),
        true
      )
    })
  })

  await t.test(
    "(c) grant scoped to a conversation the user is NOT in → denied",
    async () => {
      await withTestDb(async (db) => {
        const { workspaceId, memberUserId, memberSubjectId, spaceId } =
          await seedFileSpaceRef(db)
        // A conversation the member does NOT participate in → its subject is not
        // in the member's scope set, so a grant scoped to it must not apply.
        const otherConv = await db
          .insertInto("conversations")
          .values({
            workspaceId: workspaceId,
            kind: "direct",
            title: "x",
          } as any)
          .returning("id")
          .executeTakeFirstOrThrow()
        const otherConvSubject = await upsertAccessSubject(db as any, {
          kind: SUBJECT_KIND.CONVERSATION,
          conversationId: otherConv.id,
        })
        await db
          .insertInto("fileAccessGrants")
          .values({
            workspaceId: workspaceId,
            fileSpaceId: spaceId,
            subjectId: memberSubjectId,
            scopeSubjectId: otherConvSubject,
            permissions: ["read"],
            status: "active",
          } as any)
          .execute()
        assert.equal(
          await canUserAccessContent(SHA_FS, memberUserId, { dbh: db }),
          false
        )
      })
    }
  )
})

test("contentAccessResolver: library-global (workspace_id NULL) asset is readable by any authenticated user", async () => {
  await withTestDb(async (db) => {
    const stranger = await db
      .insertInto("users")
      .values({ email: `${rid()}@glob`, name: "s" })
      .returning("id")
      .executeTakeFirstOrThrow()
    const SHA_G = "1234".repeat(16)
    await db
      .insertInto("contentBlobs")
      .values({ sha256: SHA_G, sizeBytes: 3, backend: "local_cas" } as any)
      .onConflict((oc: any) => oc.doNothing())
      .execute()
    await db
      .insertInto("fileAssets")
      .values({
        workspaceId: null,
        contentSha256: SHA_G,
        originalName: "icon.png",
        mimeType: "image/png",
        contentKind: "image",
        sizeBytes: 3,
        sourceFamily: "package_import",
        sourceSystem: "catalog",
      } as any)
      .execute()
    assert.equal(
      await canUserAccessContent(SHA_G, stranger.id as string, { dbh: db }),
      true
    )
  })
})

// ── conversation-scope reproducer (review round-4 #3/#4) ──────────────────────
// A grant scoped to conversation A must NOT be usable from a request bound to
// conversation B, even when the user actively participates in BOTH. Mirrors the
// main runtime, which only adds the CURRENT active conversation to the scope set.

const SHA_CS = "c0ffee".repeat(10) + "abcd" // 64 hex chars

async function seedTwoConvUserWithFileSpace(db: Kysely<any>) {
  const owner = await db
    .insertInto("users")
    .values({ email: `${rid()}@cs`, name: "o" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({ ownerId: owner.id, slug: `ws-${rid()}`, name: "cs ws" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const memberUser = await db
    .insertInto("users")
    .values({ email: `${rid()}@cs`, name: "m" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const member = await db
    .insertInto("workspaceMembers")
    .values({
      workspaceId: ws.id,
      userId: memberUser.id,
      trustLevel: "member",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const memberSubjectId = await upsertAccessSubject(db as any, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    workspaceMemberId: member.id,
  })
  const memberConvSubject = await upsertAccessSubject(db as any, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    workspaceMemberId: member.id,
  })
  // Two conversations the member actively participates in.
  async function newConvWithMember() {
    const conv = await db
      .insertInto("conversations")
      .values({ workspaceId: ws.id, kind: "group", title: "t" } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    await db
      .insertInto("conversationParticipants")
      .values({
        conversationId: conv.id,
        subjectId: memberConvSubject,
        roleKey: "member",
        state: "active",
      } as any)
      .execute()
    const convSubject = await upsertAccessSubject(db as any, {
      kind: SUBJECT_KIND.CONVERSATION,
      conversationId: conv.id,
    })
    return { convId: conv.id as string, convSubject }
  }
  const convA = await newConvWithMember()
  const convB = await newConvWithMember()
  // An actor-owned file space + a snapshot whose manifest IS SHA_CS.
  const actorRoot = await db
    .insertInto("workspaceResources")
    .values({
      id: crypto.randomUUID(),
      workspaceId: ws.id,
      kind: "actor",
      displayName: `a-${rid()}`,
      createdBySubjectId: memberSubjectId,
      status: "active",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const actor = await db
    .insertInto("actors")
    .values({
      id: actorRoot.id as string,
      role: "assistant",
      title: "t",
      currentVersion: 1,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const actorSubjectId = await upsertAccessSubject(db as any, {
    kind: SUBJECT_KIND.ACTOR,
    actorId: actor.id,
  })
  const space = await db
    .insertInto("fileSpaces")
    .values({
      workspaceId: ws.id,
      ownerSubjectId: actorSubjectId,
      namespaceKey: "default",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  await db
    .insertInto("contentBlobs")
    .values({ sha256: SHA_CS, sizeBytes: 1, backend: "local_cas" } as any)
    .onConflict((oc: any) => oc.doNothing())
    .execute()
  const snap = await db
    .insertInto("fileSnapshots")
    .values({
      workspaceId: ws.id,
      fileSpaceId: space.id,
      version: 1,
      manifestSha256: SHA_CS,
      reason: "manual",
      entryCount: 0,
      totalBytes: 0,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  await db
    .updateTable("fileSpaces")
    .set({ currentSnapshotId: snap.id } as any)
    .where("id", "=", space.id)
    .execute()
  return {
    workspaceId: ws.id as string,
    memberUserId: memberUser.id as string,
    memberSubjectId,
    spaceId: space.id as string,
    convA,
    convB,
  }
}

test("contentAccessResolver: conv-A-scoped file grant is NOT usable from ?conv=B", async () => {
  await withTestDb(async (db) => {
    const s = await seedTwoConvUserWithFileSpace(db)
    // Grant scoped to conversation A.
    await db
      .insertInto("fileAccessGrants")
      .values({
        workspaceId: s.workspaceId,
        fileSpaceId: s.spaceId,
        subjectId: s.memberSubjectId,
        scopeSubjectId: s.convA.convSubject,
        permissions: ["read"],
        status: "active",
      } as any)
      .execute()

    // From conversation A → allowed.
    assert.equal(
      await canUserAccessContent(SHA_CS, s.memberUserId, {
        dbh: db,
        conversationId: s.convA.convId,
      }),
      true
    )
    // From conversation B (user IS a participant, but the grant is A-scoped) → denied.
    assert.equal(
      await canUserAccessContent(SHA_CS, s.memberUserId, {
        dbh: db,
        conversationId: s.convB.convId,
      }),
      false
    )
    // With no conversation context at all → A-scoped grant doesn't apply → denied.
    assert.equal(
      await canUserAccessContent(SHA_CS, s.memberUserId, { dbh: db }),
      false
    )
  })
})

test("contentAccessResolver: scope=A memory space is NOT owner-readable from ?conv=B", async () => {
  await withTestDb(async (db) => {
    // Member-owned memory space scoped to conversation A; the member reads from B.
    const ownerUser = await db
      .insertInto("users")
      .values({ email: `${rid()}@cm`, name: "o" })
      .returning("id")
      .executeTakeFirstOrThrow()
    const ws = await db
      .insertInto("workspaces")
      .values({ ownerId: ownerUser.id, slug: `ws-${rid()}`, name: "cm ws" })
      .returning("id")
      .executeTakeFirstOrThrow()
    const member = await db
      .insertInto("workspaceMembers")
      .values({
        workspaceId: ws.id,
        userId: ownerUser.id,
        trustLevel: "member",
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    const memberSubject = await upsertAccessSubject(db as any, {
      kind: SUBJECT_KIND.WORKSPACE_MEMBER,
      workspaceMemberId: member.id,
    })
    async function convWithMember() {
      const conv = await db
        .insertInto("conversations")
        .values({ workspaceId: ws.id, kind: "group", title: "t" } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      await db
        .insertInto("conversationParticipants")
        .values({
          conversationId: conv.id,
          subjectId: memberSubject,
          roleKey: "member",
          state: "active",
        } as any)
        .execute()
      const cs = await upsertAccessSubject(db as any, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: conv.id,
      })
      return { convId: conv.id as string, cs }
    }
    const convA = await convWithMember()
    const convB = await convWithMember()
    // member-owned space SCOPED to conv A.
    const space = await db
      .insertInto("memorySpaces")
      .values({
        workspaceId: ws.id,
        ownerSubjectId: memberSubject,
        scopeSubjectId: convA.cs,
        namespaceKey: "default",
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    const item = await db
      .insertInto("memoryItems")
      .values({
        workspaceId: ws.id,
        memorySpaceId: space.id,
        category: "fact",
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    await db
      .insertInto("contentBlobs")
      .values({ sha256: SHA_M, sizeBytes: 3, backend: "local_cas" } as any)
      .onConflict((oc: any) => oc.doNothing())
      .execute()
    await db
      .insertInto("memoryItemParts")
      .values({
        memoryItemId: item.id,
        ordinal: 0,
        partType: "file_ref",
        refSha256: SHA_M,
        mimeType: "image/png",
        name: "m.png",
      } as any)
      .execute()

    // From conv A → owner-implicit holds (owner + scope A in scope) → allowed.
    assert.equal(
      await canUserAccessContent(SHA_M, ownerUser.id as string, {
        dbh: db,
        conversationId: convA.convId,
      }),
      true
    )
    // From conv B → space scope A not in scope → owner-implicit must NOT apply.
    assert.equal(
      await canUserAccessContent(SHA_M, ownerUser.id as string, {
        dbh: db,
        conversationId: convB.convId,
      }),
      false
    )
  })
})

test("contentAccessResolver: context-archive ref is narrowed by ?conv=", async () => {
  await withTestDb(async (db) => {
    const SHA_AR = "ar".repeat(32)
    const user = await db
      .insertInto("users")
      .values({ email: `${rid()}@ar`, name: "u" })
      .returning("id")
      .executeTakeFirstOrThrow()
    const ws = await db
      .insertInto("workspaces")
      .values({ ownerId: user.id, slug: `ws-${rid()}`, name: "ar ws" })
      .returning("id")
      .executeTakeFirstOrThrow()
    const member = await db
      .insertInto("workspaceMembers")
      .values({
        workspaceId: ws.id,
        userId: user.id,
        trustLevel: "member",
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    const memberSubject = await upsertAccessSubject(db as any, {
      kind: SUBJECT_KIND.WORKSPACE_MEMBER,
      workspaceMemberId: member.id,
    })
    async function convWithMember() {
      const conv = await db
        .insertInto("conversations")
        .values({ workspaceId: ws.id, kind: "group", title: "t" } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      await db
        .insertInto("conversationParticipants")
        .values({
          conversationId: conv.id,
          subjectId: memberSubject,
          roleKey: "member",
          state: "active",
        } as any)
        .execute()
      return conv.id as string
    }
    const convA = await convWithMember()
    const convB = await convWithMember()
    // An archive in conversation A referencing SHA_AR.
    const point = await db
      .insertInto("contextArchivePoints")
      .values({
        conversationId: convA,
        chainScope: "shared",
        coversUntilSequence: 0,
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    const frame = await db
      .insertInto("contextArchiveFrames")
      .values({
        archivePointId: point.id,
        ordinal: 0,
        role: "assistant",
        frameType: "message",
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
    await db
      .insertInto("contentBlobs")
      .values({ sha256: SHA_AR, sizeBytes: 3, backend: "local_cas" } as any)
      .onConflict((oc: any) => oc.doNothing())
      .execute()
    await db
      .insertInto("contextArchiveFrameParts")
      .values({
        archiveFrameId: frame.id,
        ordinal: 0,
        partType: "file_ref",
        refSha256: SHA_AR,
        mimeType: "image/png",
        name: "a.png",
      } as any)
      .execute()

    // From conv A → allowed.
    assert.equal(
      await canUserAccessContent(SHA_AR, user.id as string, {
        dbh: db,
        conversationId: convA,
      }),
      true
    )
    // From conv B → the archive belongs to A, so ?conv=B must NOT authorize it.
    assert.equal(
      await canUserAccessContent(SHA_AR, user.id as string, {
        dbh: db,
        conversationId: convB,
      }),
      false
    )
    // No ?conv= context → falls back to active-participant (user is in A) → allowed.
    assert.equal(
      await canUserAccessContent(SHA_AR, user.id as string, { dbh: db }),
      true
    )
  })
})
