import test from "node:test"
import assert from "node:assert/strict"
import { SUBJECT_KIND } from "@synapse/shared"
import { withTestDb, withTestDbAndClient } from "../../test/helpers/db.js"
import {
  findAccessSubjectId,
  findAccessSubjectIdOn,
  loadAccessSubject,
  loadAccessSubjectMany,
  upsertAccessSubject,
  upsertAccessSubjectOn,
} from "./subject-registry.js"

test(
  "upsertAccessSubject creates a row for a workspace subject and is idempotent",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const workspaceId = await insertWorkspace(db)

      const first = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      assert.equal(typeof first, "string")

      const second = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      assert.equal(second, first, "duplicate upsert must return the same id")
    })
  }
)

test(
  "upsertAccessSubject distinguishes subject kinds even for the same workspace",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const workspaceId = await insertWorkspace(db)
      const userId = await insertUser(db, "u1@example.test")
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)

      const wsSubject = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      const memberSubject = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId,
      })

      assert.notEqual(wsSubject, memberSubject)

      const loadedWs = await loadAccessSubject(db, wsSubject)
      assert.deepEqual(loadedWs, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      const loadedMember = await loadAccessSubject(db, memberSubject)
      assert.deepEqual(loadedMember, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId,
      })
    })
  }
)

test(
  "findAccessSubjectId returns null when no matching subject exists",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const workspaceId = await insertWorkspace(db)
      const result = await findAccessSubjectId(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      assert.equal(result, null)
    })
  }
)

test(
  "upsertAccessSubject system kind is a singleton",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const a = await upsertAccessSubject(db, { kind: SUBJECT_KIND.SYSTEM })
      const b = await upsertAccessSubject(db, { kind: SUBJECT_KIND.SYSTEM })
      assert.equal(a, b)
    })
  }
)

test(
  "upsertAccessSubject populates the auto-resolved workspace_id for actor / member / remote_agent kinds",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db, "u@example.test")
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const actorId = await insertActor(db, workspaceId)

      const actorSubject = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId,
      })
      const memberSubject = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId,
      })

      const rows = await loadAccessSubjectMany(db, [
        actorSubject,
        memberSubject,
      ])
      assert.equal(rows.size, 2)
      assert.deepEqual(rows.get(actorSubject), {
        kind: SUBJECT_KIND.ACTOR,
        actorId,
      })
      assert.deepEqual(rows.get(memberSubject), {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId,
      })

      const enriched = await db
        .selectFrom("access_subjects")
        .select(["id", "kind", "workspace_id"])
        .where("id", "in", [actorSubject, memberSubject])
        .execute()
      for (const row of enriched) {
        assert.equal(
          row.workspace_id,
          workspaceId,
          `${row.kind} subject must denormalize the owning workspace`
        )
      }
    })
  }
)

test(
  "loadAccessSubjectMany returns an empty map for an empty input",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const map = await loadAccessSubjectMany(db, [])
      assert.equal(map.size, 0)
    })
  }
)

test(
  "findAccessSubjectId returns the previously-upserted id for a known subject",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db, "u@example.test")
      const workspaceId = await insertWorkspace(db, userId)
      const created = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      const found = await findAccessSubjectId(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      assert.equal(found, created)
    })
  }
)

test(
  "upsertAccessSubject for a remote_agent stamps the owning workspace_id",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db, "owner@example.test")
      const workspaceId = await insertWorkspace(db, userId)
      const remoteAgentId = await insertRemoteAgent(db, workspaceId)
      const id = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.REMOTE_AGENT,
        remoteAgentId,
      })
      const row = await db
        .selectFrom("access_subjects")
        .select(["kind", "workspace_id", "remote_agent_id"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow()
      assert.equal(row.kind, "remote_agent")
      assert.equal(row.workspace_id, workspaceId)
      assert.equal(row.remote_agent_id, remoteAgentId)
    })
  }
)

test(
  "upsertAccessSubject for an internal conversation populates internal_workspace_id; external conversation leaves it null",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db, "owner@example.test")
      const workspaceId = await insertWorkspace(db, userId)
      const internalConvo = await insertConversation(db, {
        workspaceId,
      })
      const externalConvo = await insertConversation(db, {
        boundary: "external",
      })

      const internalSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: internalConvo,
      })
      const externalSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: externalConvo,
      })

      const internalRow = await db
        .selectFrom("access_subjects")
        .select(["workspace_id", "conversation_id"])
        .where("id", "=", internalSubjectId)
        .executeTakeFirstOrThrow()
      assert.equal(internalRow.workspace_id, workspaceId)
      assert.equal(internalRow.conversation_id, internalConvo)

      const externalRow = await db
        .selectFrom("access_subjects")
        .select(["workspace_id", "conversation_id"])
        .where("id", "=", externalSubjectId)
        .executeTakeFirstOrThrow()
      assert.equal(externalRow.workspace_id, null)
      assert.equal(externalRow.conversation_id, externalConvo)
    })
  }
)

test(
  "upsertAccessSubject for a conversation_actor_context resolves the owning workspace from the joined conversation",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db, "owner@example.test")
      const workspaceId = await insertWorkspace(db, userId)
      const actorId = await insertActor(db, workspaceId)
      const conversationId = await insertConversation(db, { workspaceId })
      const contextRow = await db
        .insertInto("conversation_actor_contexts")
        .values({
          conversation_id: conversationId,
          actor_id: actorId,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const id = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT,
        contextId: contextRow.id as string,
      })
      const row = await db
        .selectFrom("access_subjects")
        .select(["kind", "workspace_id", "conversation_actor_context_id"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow()
      assert.equal(row.kind, "conversation_actor_context")
      assert.equal(row.workspace_id, workspaceId)
      assert.equal(row.conversation_actor_context_id, contextRow.id)
    })
  }
)

test(
  "upsertAccessSubject for user and external kinds leaves workspace_id null",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db, "u@example.test")
      const userSubject = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.USER,
        userId,
      })
      const externalSubject = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.EXTERNAL,
        externalIdentityKey: `ext-${Math.random().toString(36).slice(2, 8)}`,
      })
      const rows = await db
        .selectFrom("access_subjects")
        .select(["id", "kind", "workspace_id"])
        .where("id", "in", [userSubject, externalSubject])
        .execute()
      for (const row of rows) {
        assert.equal(row.workspace_id, null)
      }
    })
  }
)

test(
  "upsertAccessSubject throws a descriptive error for a missing actor FK",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      await assert.rejects(
        () =>
          upsertAccessSubject(db, {
            kind: SUBJECT_KIND.ACTOR,
            actorId: "00000000-0000-0000-0000-000000000000",
          }),
        /actors\(/
      )
    })
  }
)

test(
  "upsertAccessSubject throws for a missing workspace_member FK",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      await assert.rejects(
        () =>
          upsertAccessSubject(db, {
            kind: SUBJECT_KIND.WORKSPACE_MEMBER,
            memberId: "00000000-0000-0000-0000-000000000000",
          }),
        /workspace_members\(/
      )
    })
  }
)

test(
  "upsertAccessSubject throws for a missing remote_agent FK",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      await assert.rejects(
        () =>
          upsertAccessSubject(db, {
            kind: SUBJECT_KIND.REMOTE_AGENT,
            remoteAgentId: "00000000-0000-0000-0000-000000000000",
          }),
        /remote_agents\(/
      )
    })
  }
)

test(
  "upsertAccessSubject throws for a missing conversation FK",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      await assert.rejects(
        () =>
          upsertAccessSubject(db, {
            kind: SUBJECT_KIND.CONVERSATION,
            conversationId: "00000000-0000-0000-0000-000000000000",
          }),
        /conversations\(/
      )
    })
  }
)

test(
  "upsertAccessSubject throws for a missing conversation_actor_context FK",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      await assert.rejects(
        () =>
          upsertAccessSubject(db, {
            kind: SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT,
            contextId: "00000000-0000-0000-0000-000000000000",
          }),
        /conversation_actor_contexts\(/
      )
    })
  }
)

test(
  "loadAccessSubject returns null for a non-existent subject id",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ref = await loadAccessSubject(
        db,
        "00000000-0000-0000-0000-000000000000"
      )
      assert.equal(ref, null)
    })
  }
)

test(
  "upsertAccessSubjectOn (queryable variant) creates a workspace subject and is idempotent across racing calls",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const userId = await insertUser(db, "owner@example.test")
      const workspaceId = await insertWorkspace(db, userId)
      const first = await upsertAccessSubjectOn(client, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      const second = await upsertAccessSubjectOn(client, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      assert.equal(first, second)
    })
  }
)

test(
  "upsertAccessSubjectOn handles every kind (workspace_member, actor, remote_agent, conversation, cac, user, external, system)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const userId = await insertUser(db, "owner@example.test")
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const actorId = await insertActor(db, workspaceId)
      const remoteAgentId = await insertRemoteAgent(db, workspaceId)
      const conversationId = await insertConversation(db, { workspaceId })
      const contextRow = await db
        .insertInto("conversation_actor_contexts")
        .values({ conversation_id: conversationId, actor_id: actorId })
        .returning("id")
        .executeTakeFirstOrThrow()

      const wsId = await upsertAccessSubjectOn(client, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      const memId = await upsertAccessSubjectOn(client, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId,
      })
      const actId = await upsertAccessSubjectOn(client, {
        kind: SUBJECT_KIND.ACTOR,
        actorId,
      })
      const raId = await upsertAccessSubjectOn(client, {
        kind: SUBJECT_KIND.REMOTE_AGENT,
        remoteAgentId,
      })
      const convoId = await upsertAccessSubjectOn(client, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId,
      })
      const cacId = await upsertAccessSubjectOn(client, {
        kind: SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT,
        contextId: contextRow.id as string,
      })
      const userSubjId = await upsertAccessSubjectOn(client, {
        kind: SUBJECT_KIND.USER,
        userId,
      })
      const extId = await upsertAccessSubjectOn(client, {
        kind: SUBJECT_KIND.EXTERNAL,
        externalIdentityKey: `ext-${Math.random().toString(36).slice(2, 8)}`,
      })
      const sysId = await upsertAccessSubjectOn(client, {
        kind: SUBJECT_KIND.SYSTEM,
      })

      const ids = new Set([
        wsId,
        memId,
        actId,
        raId,
        convoId,
        cacId,
        userSubjId,
        extId,
        sysId,
      ])
      assert.equal(ids.size, 9)
    })
  }
)

test(
  "upsertAccessSubjectOn throws when the underlying entity FK is missing",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ client }) => {
      await assert.rejects(
        () =>
          upsertAccessSubjectOn(client, {
            kind: SUBJECT_KIND.ACTOR,
            actorId: "00000000-0000-0000-0000-000000000000",
          }),
        /actors\(/
      )
      await assert.rejects(
        () =>
          upsertAccessSubjectOn(client, {
            kind: SUBJECT_KIND.WORKSPACE_MEMBER,
            memberId: "00000000-0000-0000-0000-000000000000",
          }),
        /workspace_members\(/
      )
      await assert.rejects(
        () =>
          upsertAccessSubjectOn(client, {
            kind: SUBJECT_KIND.REMOTE_AGENT,
            remoteAgentId: "00000000-0000-0000-0000-000000000000",
          }),
        /remote_agents\(/
      )
      await assert.rejects(
        () =>
          upsertAccessSubjectOn(client, {
            kind: SUBJECT_KIND.CONVERSATION,
            conversationId: "00000000-0000-0000-0000-000000000000",
          }),
        /conversations\(/
      )
      await assert.rejects(
        () =>
          upsertAccessSubjectOn(client, {
            kind: SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT,
            contextId: "00000000-0000-0000-0000-000000000000",
          }),
        /conversation_actor_contexts\(/
      )
    })
  }
)

test(
  "findAccessSubjectIdOn returns the existing id and null when missing",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const userId = await insertUser(db, "owner@example.test")
      const workspaceId = await insertWorkspace(db, userId)
      const created = await upsertAccessSubjectOn(client, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      const found = await findAccessSubjectIdOn(client, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      assert.equal(found, created)
      const missing = await findAccessSubjectIdOn(client, {
        kind: SUBJECT_KIND.USER,
        userId: "00000000-0000-0000-0000-000000000000",
      })
      assert.equal(missing, null)
    })
  }
)

async function insertRemoteAgent(
  db: import("kysely").Kysely<any>,
  workspaceId: string
): Promise<string> {
  const row = await db
    .insertInto("remote_agents")
    .values({
      workspace_id: workspaceId,
      name: "test agent",
      title: "test",
      runtime_kind: "claude_code",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertConversation(
  db: import("kysely").Kysely<any>,
  params: { workspaceId?: string; boundary?: "internal" | "external" } = {}
): Promise<string> {
  const boundary = params.boundary ?? "internal"
  const row = await db
    .insertInto("conversations")
    .values({
      kind: "group",
      boundary,
      internal_workspace_id:
        boundary === "internal" ? params.workspaceId : null,
      title: "test conversation",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertActor(
  db: import("kysely").Kysely<any>,
  workspaceId: string
): Promise<string> {
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

async function insertWorkspace(
  db: import("kysely").Kysely<any>,
  precomputedOwnerId?: string
): Promise<string> {
  const userId =
    precomputedOwnerId ?? (await insertUser(db, "owner@example.test"))
  const row = await db
    .insertInto("workspaces")
    .values({
      owner_id: userId,
      slug: `ws-${Math.random().toString(36).slice(2, 10)}`,
      name: "test workspace",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertUser(
  db: import("kysely").Kysely<any>,
  email: string
): Promise<string> {
  const row = await db
    .insertInto("users")
    .values({
      email: `${Math.random().toString(36).slice(2, 8)}-${email}`,
      name: "test user",
      password_hash: "unused-hash",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertWorkspaceMember(
  db: import("kysely").Kysely<any>,
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
