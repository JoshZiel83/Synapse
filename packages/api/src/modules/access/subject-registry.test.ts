import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
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
  "upsertAccessSubject platform kind is a singleton",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const a = await upsertAccessSubject(db, { kind: SUBJECT_KIND.PLATFORM })
      const b = await upsertAccessSubject(db, { kind: SUBJECT_KIND.PLATFORM })
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
        .selectFrom("accessSubjects")
        .select(["id", "kind", "workspaceId"])
        .where("id", "in", [actorSubject, memberSubject])
        .execute()
      for (const row of enriched) {
        assert.equal(
          row.workspaceId,
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
        .selectFrom("accessSubjects")
        .select(["kind", "workspaceId", "remoteAgentId"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow()
      assert.equal(row.kind, "remote_agent")
      assert.equal(row.workspaceId, workspaceId)
      assert.equal(row.remoteAgentId, remoteAgentId)
    })
  }
)

test(
  "upsertAccessSubject for a conversation populates its workspace_id (every conversation is workspace-scoped)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db, "owner@example.test")
      const workspaceId = await insertWorkspace(db, userId)
      const convo = await insertConversation(db, {
        workspaceId,
      })

      const subjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: convo,
      })

      const row = await db
        .selectFrom("accessSubjects")
        .select(["workspaceId", "conversationId"])
        .where("id", "=", subjectId)
        .executeTakeFirstOrThrow()
      assert.equal(row.workspaceId, workspaceId)
      assert.equal(row.conversationId, convo)
    })
  }
)

// D2: the previous runtime-pair subject test is gone — the subject kind was
// dropped from both the TS union and the SQL ENUM, so there is no code path
// that resolves an owning workspace from joined runtime-pair state.

test(
  "upsertAccessSubject: user kind leaves workspace_id null; external carries its workspace",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db, "u@example.test")
      const workspaceId = await insertWorkspace(db, userId)
      const transportAddressId = await insertTransportAddress(db, workspaceId)
      const userSubject = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.USER,
        userId,
      })
      const externalSubject = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.EXTERNAL,
        workspaceId,
        transportAddressId,
      })
      const rows = await db
        .selectFrom("accessSubjects")
        .select(["id", "kind", "workspaceId", "transportAddressId"])
        .where("id", "in", [userSubject, externalSubject])
        .execute()
      for (const row of rows) {
        if (row.kind === "user") {
          assert.equal(row.workspaceId, null)
        } else {
          assert.equal(row.kind, "external")
          assert.equal(row.workspaceId, workspaceId)
          assert.equal(row.transportAddressId, transportAddressId)
        }
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

// D2: the missing runtime-pair FK test was removed — the kind is gone from the
// TS union and SQL ENUM, so this codepath no longer exists.

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
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db, "owner@example.test")
      const workspaceId = await insertWorkspace(db, userId)
      const first = await upsertAccessSubjectOn(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      const second = await upsertAccessSubjectOn(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      assert.equal(first, second)
    })
  }
)

test(
  "upsertAccessSubjectOn handles every kind (workspace_member, actor, remote_agent, conversation, user, external, platform)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db, "owner@example.test")
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const actorId = await insertActor(db, workspaceId)
      const remoteAgentId = await insertRemoteAgent(db, workspaceId)
      const conversationId = await insertConversation(db, { workspaceId })
      const transportAddressId = await insertTransportAddress(db, workspaceId)

      const wsId = await upsertAccessSubjectOn(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      const memId = await upsertAccessSubjectOn(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId,
      })
      const actId = await upsertAccessSubjectOn(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId,
      })
      const raId = await upsertAccessSubjectOn(db, {
        kind: SUBJECT_KIND.REMOTE_AGENT,
        remoteAgentId,
      })
      const convoId = await upsertAccessSubjectOn(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId,
      })
      const userSubjId = await upsertAccessSubjectOn(db, {
        kind: SUBJECT_KIND.USER,
        userId,
      })
      const extId = await upsertAccessSubjectOn(db, {
        kind: SUBJECT_KIND.EXTERNAL,
        workspaceId,
        transportAddressId,
      })
      const platformId = await upsertAccessSubjectOn(db, {
        kind: SUBJECT_KIND.PLATFORM,
      })

      const ids = new Set([
        wsId,
        memId,
        actId,
        raId,
        convoId,
        userSubjId,
        extId,
        platformId,
      ])
      assert.equal(ids.size, 8)
    })
  }
)

test(
  "upsertAccessSubjectOn throws when the underlying entity FK is missing",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      await assert.rejects(
        () =>
          upsertAccessSubjectOn(db, {
            kind: SUBJECT_KIND.ACTOR,
            actorId: "00000000-0000-0000-0000-000000000000",
          }),
        /actors\(/
      )
      await assert.rejects(
        () =>
          upsertAccessSubjectOn(db, {
            kind: SUBJECT_KIND.WORKSPACE_MEMBER,
            memberId: "00000000-0000-0000-0000-000000000000",
          }),
        /workspace_members\(/
      )
      await assert.rejects(
        () =>
          upsertAccessSubjectOn(db, {
            kind: SUBJECT_KIND.REMOTE_AGENT,
            remoteAgentId: "00000000-0000-0000-0000-000000000000",
          }),
        /remote_agents\(/
      )
      await assert.rejects(
        () =>
          upsertAccessSubjectOn(db, {
            kind: SUBJECT_KIND.CONVERSATION,
            conversationId: "00000000-0000-0000-0000-000000000000",
          }),
        /conversations\(/
      )
    })
  }
)

test(
  "findAccessSubjectIdOn returns the existing id and null when missing",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const userId = await insertUser(db, "owner@example.test")
      const workspaceId = await insertWorkspace(db, userId)
      const created = await upsertAccessSubjectOn(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      const found = await findAccessSubjectIdOn(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      assert.equal(found, created)
      const missing = await findAccessSubjectIdOn(db, {
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
  const remoteAgentId = crypto.randomUUID()
  await db
    .insertInto("workspaceApps")
    .values({
      id: remoteAgentId,
      workspaceId: workspaceId,
      kind: "remote_agent",
      displayName: "test agent",
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("remoteAgents")
    .values({
      id: remoteAgentId,
      title: "test",
      runtimeKind: "claude_code",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertConversation(
  db: import("kysely").Kysely<any>,
  params: { workspaceId?: string } = {}
): Promise<string> {
  const row = await db
    .insertInto("conversations")
    .values({
      kind: "group",
      workspaceId: params.workspaceId,
      title: "test conversation",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertTransportAddress(
  db: import("kysely").Kysely<any>,
  workspaceId: string
): Promise<string> {
  const account = await db
    .insertInto("transportAccounts")
    .values({
      workspaceId: workspaceId,
      transportKind: "qq",
      accountKey: `acct-${Math.random().toString(36).slice(2, 8)}`,
      displayName: "Test account",
      connectionMode: "webhook",
      ownerScope: "workspace",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const addr = await db
    .insertInto("transportAddresses")
    .values({
      workspaceId: workspaceId,
      transportAccountId: account.id as string,
      transportKind: "qq",
      addressType: "user",
      externalId: `ext-${Math.random().toString(36).slice(2, 8)}`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return addr.id as string
}

async function insertActor(
  db: import("kysely").Kysely<any>,
  workspaceId: string
): Promise<string> {
  const actorId = crypto.randomUUID()
  await db
    .insertInto("workspaceApps")
    .values({
      id: actorId,
      workspaceId: workspaceId,
      kind: "actor",
      displayName: "test actor",
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("actors")
    .values({
      id: actorId,
      role: "assistant",
      title: "test",
      currentVersion: 1,
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
      ownerId: userId,
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
    .insertInto("workspaceMembers")
    .values({
      workspaceId: workspaceId,
      userId: userId,
      trustLevel: "member",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}
