import test from "node:test"
import assert from "node:assert/strict"
import { SUBJECT_KIND } from "@synapse/shared"
import { withTestDb, withTestDbAndClient } from "../../test/helpers/db.js"
import {
  augmentInsertedBindingRowWithTarget,
  buildResourceAccessBindingInsertValues,
  buildResourceAccessBindingInsertValuesOn,
  describeAccessGrants,
  findActiveBindingIdByResourceAndSubject,
  getAccessBindingRowById,
  hardDeleteBindingsForResource,
  hardDeleteBindingsForResourceOn,
  hasAnyBindingForResourceOn,
  insertAccessBindingReturningIdOn,
  insertAccessBindingReturningRowOn,
  listGrantsForResource,
  listResourceIdsForWorkspaceByBindingFilter,
  loadAccessBindingRowsForResource,
  loadAccessBindingRowsForResources,
  revokeGrant,
  revokeGrantsByIdsOn,
  updateGrantConversationTypeMaskOverride,
  updateGrantTargets,
} from "./binding-storage.js"
import { loadAccessSubject, upsertAccessSubject } from "./subject-registry.js"

test(
  "buildResourceAccessBindingInsertValues writes only subject_id (no legacy polymorphic columns)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const workspaceId = await insertWorkspace(db)

      const insert = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "installed_skill",
        resourceId: "00000000-0000-0000-0000-000000000001",
        target: {
          targetType: "workspace",
          subjectWorkspaceId: workspaceId,
          subjectActorId: null,
          subjectConversationId: null,
          subjectConversationActorContextId: null,
        },
      })

      assert.ok(insert.subject_id, "subject_id should be populated")
      assert.equal(insert.workspace_id, workspaceId)
      assert.equal(insert.resource_type, "installed_skill")
      assert.equal(insert.source, "manual")
      assert.equal(
        (insert as Record<string, unknown>).target_type,
        undefined,
        "legacy target_type column should not be in insert payload"
      )
      assert.equal(
        (insert as Record<string, unknown>).subject_workspace_id,
        undefined,
        "legacy subject_workspace_id column should not be in insert payload"
      )

      const ref = await loadAccessSubject(db, insert.subject_id as string)
      assert.deepEqual(ref, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
    })
  }
)

test(
  "buildResourceAccessBindingInsertValues reuses the same subject_id across multiple inserts for the same workspace target",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const workspaceId = await insertWorkspace(db)
      const target = {
        targetType: "workspace" as const,
        subjectWorkspaceId: workspaceId,
        subjectActorId: null,
        subjectConversationId: null,
        subjectConversationActorContextId: null,
      }

      const first = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "installed_skill",
        resourceId: "00000000-0000-0000-0000-000000000001",
        target,
      })
      const second = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "plugin_installation",
        resourceId: "00000000-0000-0000-0000-000000000002",
        target,
      })
      assert.equal(
        first.subject_id,
        second.subject_id,
        "second upsert for the same workspace subject must reuse the row"
      )
    })
  }
)

test(
  "buildResourceAccessBindingInsertValues with source=default_open",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const workspaceId = await insertWorkspace(db)
      const insert = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "installed_skill",
        resourceId: "00000000-0000-0000-0000-000000000003",
        target: {
          targetType: "workspace",
          subjectWorkspaceId: workspaceId,
          subjectActorId: null,
          subjectConversationId: null,
          subjectConversationActorContextId: null,
        },
        source: "default_open",
      })
      assert.equal(insert.source, "default_open")
    })
  }
)

async function insertWorkspace(
  db: import("kysely").Kysely<any>
): Promise<string> {
  const userId = await insertUser(db, "owner@example.test")
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

// P3 regression: listGrantsForResource was crashing with "Unsupported stored
// access target type: undefined" because its SELECT projected `subject_kind`
// from access_subjects but mapAccessBindingToGrant -> readAccessBindingTarget
// reads the legacy `target_type` enum. Now subject_kind is mapped to
// target_type inside listGrantsForResource so callers get a fully decoded
// AccessGrant.
test(
  "listGrantsForResource decodes the joined access_subjects row for an actor target",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db, "owner@example.test")
      const workspaceRow = await db
        .insertInto("workspaces")
        .values({
          owner_id: ownerId,
          slug: `ws-${Math.random().toString(36).slice(2, 10)}`,
          name: "test workspace",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const workspaceId = workspaceRow.id as string
      const grantedActorId = await insertActor(db, workspaceId)
      const targetActorId = await insertActor(db, workspaceId)

      const insert = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: targetActorId,
        target: {
          targetType: "actor",
          subjectWorkspaceId: null,
          subjectWorkspaceMemberId: null,
          subjectActorId: grantedActorId,
          subjectConversationId: null,
          subjectConversationActorContextId: null,
        },
      })
      await db.insertInto("resource_access_bindings").values(insert).execute()

      const grants = await listGrantsForResource(db, {
        resourceType: "actor",
        resourceId: targetActorId,
      })
      assert.equal(grants.length, 1)
      assert.equal(grants[0].target.type, "actor")
      assert.equal(grants[0].target.actorId, grantedActorId)
    })
  }
)

test(
  "listGrantsForResource decodes a workspace_member target",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db, "owner@example.test")
      const memberUserId = await insertUser(db, "member@example.test")
      const workspaceRow = await db
        .insertInto("workspaces")
        .values({
          owner_id: ownerId,
          slug: `ws-${Math.random().toString(36).slice(2, 10)}`,
          name: "test workspace",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const workspaceId = workspaceRow.id as string
      const memberId = await insertWorkspaceMember(
        db,
        workspaceId,
        memberUserId
      )
      const targetActorId = await insertActor(db, workspaceId)

      const insert = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: targetActorId,
        target: {
          targetType: "workspace_member",
          subjectWorkspaceId: null,
          subjectWorkspaceMemberId: memberId,
          subjectActorId: null,
          subjectConversationId: null,
          subjectConversationActorContextId: null,
        },
      })
      await db.insertInto("resource_access_bindings").values(insert).execute()

      const grants = await listGrantsForResource(db, {
        resourceType: "actor",
        resourceId: targetActorId,
      })
      assert.equal(grants.length, 1)
      assert.equal(grants[0].target.type, "workspace_member")
      assert.equal(grants[0].target.workspaceMemberId, memberId)
    })
  }
)

// P3 regression: actor_in_conversation grants store a SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT
// in access_subjects. The decoded AccessGrantTarget requires actor_id AND
// conversation_id (see readAccessBindingTarget). listGrantsForResource has to
// LEFT JOIN conversation_actor_contexts and COALESCE those fields from the
// cac row — without that, the assertion at bindings.ts:340 throws
// "subject_actor_id is required for resolved actor_in_conversation".
test(
  "listGrantsForResource decodes an actor_in_conversation target via the cac join",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db, "owner@example.test")
      const workspaceRow = await db
        .insertInto("workspaces")
        .values({
          owner_id: ownerId,
          slug: `ws-${Math.random().toString(36).slice(2, 10)}`,
          name: "test workspace",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const workspaceId = workspaceRow.id as string
      const grantedActorId = await insertActor(db, workspaceId)
      const targetActorId = await insertActor(db, workspaceId)
      const conversationRow = await db
        .insertInto("conversations")
        .values({
          kind: "group",
          boundary: "internal",
          internal_workspace_id: workspaceId,
          title: "test conversation",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const conversationId = conversationRow.id as string
      const contextRow = await db
        .insertInto("conversation_actor_contexts")
        .values({
          conversation_id: conversationId,
          actor_id: grantedActorId,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const contextId = contextRow.id as string

      const insert = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: targetActorId,
        target: {
          targetType: "actor_in_conversation",
          subjectWorkspaceId: null,
          subjectWorkspaceMemberId: null,
          subjectActorId: grantedActorId,
          subjectConversationId: conversationId,
          subjectConversationActorContextId: contextId,
        },
      })
      await db.insertInto("resource_access_bindings").values(insert).execute()

      const grants = await listGrantsForResource(db, {
        resourceType: "actor",
        resourceId: targetActorId,
      })
      assert.equal(grants.length, 1)
      assert.equal(grants[0].target.type, "actor_in_conversation")
      assert.equal(grants[0].target.actorId, grantedActorId)
      assert.equal(grants[0].target.conversationId, conversationId)
    })
  }
)

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

// P2/P3 regression: two member-scoped bindings on the same resource for two
// DIFFERENT members must produce two distinct access_subjects rows AND two
// distinct binding rows. The dedupe bug at skills/service.ts:2749 (and the
// equivalent in mcp-plugins/service.ts) collapsed them both into
// {target_type=workspace_member, actor_id=null, conversation_id=null} and
// silently dropped the second member's binding.
test(
  "member-scoped bindings for different members on the same actor don't collapse",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db, "owner@example.test")
      const memberAUserId = await insertUser(db, "member-a@example.test")
      const memberBUserId = await insertUser(db, "member-b@example.test")
      const workspaceRow = await db
        .insertInto("workspaces")
        .values({
          owner_id: ownerId,
          slug: `ws-${Math.random().toString(36).slice(2, 10)}`,
          name: "test workspace",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const workspaceId = workspaceRow.id as string
      const memberA = await insertWorkspaceMember(
        db,
        workspaceId,
        memberAUserId
      )
      const memberB = await insertWorkspaceMember(
        db,
        workspaceId,
        memberBUserId
      )
      const actorId = await insertActor(db, workspaceId)

      for (const memberId of [memberA, memberB]) {
        const insert = await buildResourceAccessBindingInsertValues(db, {
          workspaceId,
          resourceType: "actor",
          resourceId: actorId,
          target: {
            targetType: "workspace_member",
            subjectWorkspaceId: null,
            subjectWorkspaceMemberId: memberId,
            subjectActorId: null,
            subjectConversationId: null,
            subjectConversationActorContextId: null,
          },
        })
        await db.insertInto("resource_access_bindings").values(insert).execute()
      }

      const rows = await db
        .selectFrom("resource_access_bindings as binding")
        .innerJoin("access_subjects as subj", "subj.id", "binding.subject_id")
        .select(["binding.id", "subj.kind", "subj.workspace_member_id"])
        .where("binding.actor_id", "=", actorId)
        .where("binding.status", "=", "active")
        .execute()

      assert.equal(rows.length, 2, "two member grants must produce two rows")
      const memberIds = rows.map((r) => r.workspace_member_id).sort()
      assert.deepEqual(memberIds, [memberA, memberB].sort())
    })
  }
)

test("augmentInsertedBindingRowWithTarget copies the target shape onto the raw row", () => {
  const augmented = augmentInsertedBindingRowWithTarget(
    { subject_id: "subj-1", extra: "passthrough" } as any,
    {
      targetType: "workspace_member",
      subjectWorkspaceId: null,
      subjectWorkspaceMemberId: "m-1",
      subjectActorId: null,
      subjectConversationId: null,
      subjectConversationActorContextId: null,
    }
  )
  assert.equal(augmented.target_type, "workspace_member")
  assert.equal(augmented.subject_workspace_member_id, "m-1")
  assert.equal(augmented.subject_actor_id, null)
  assert.equal((augmented as any).extra, "passthrough")
})

test(
  "revokeGrant flips status to revoked and is idempotent",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db, "owner@example.test")
      const workspaceRow = await db
        .insertInto("workspaces")
        .values({
          owner_id: ownerId,
          slug: `ws-${Math.random().toString(36).slice(2, 10)}`,
          name: "test workspace",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const workspaceId = workspaceRow.id as string
      const actorId = await insertActor(db, workspaceId)
      const values = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: {
          targetType: "workspace",
          subjectWorkspaceId: workspaceId,
          subjectWorkspaceMemberId: null,
          subjectActorId: null,
          subjectConversationId: null,
          subjectConversationActorContextId: null,
        },
      })
      const inserted = await db
        .insertInto("resource_access_bindings")
        .values(values)
        .returning("id")
        .executeTakeFirstOrThrow()

      const first = await revokeGrant(db, { bindingId: inserted.id as string })
      assert.equal(first, true)
      const second = await revokeGrant(db, { bindingId: inserted.id as string })
      assert.equal(second, false, "second revoke is a no-op")
      const row = await db
        .selectFrom("resource_access_bindings")
        .select(["status"])
        .where("id", "=", inserted.id as string)
        .executeTakeFirstOrThrow()
      assert.equal(row.status, "revoked")
    })
  }
)

test(
  "updateGrantTargets repoints a binding at a new subject",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db, "owner@example.test")
      const guestUserId = await insertUser(db, "guest@example.test")
      const workspaceRow = await db
        .insertInto("workspaces")
        .values({
          owner_id: ownerId,
          slug: `ws-${Math.random().toString(36).slice(2, 10)}`,
          name: "test workspace",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const workspaceId = workspaceRow.id as string
      const guestMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        guestUserId
      )
      const actorId = await insertActor(db, workspaceId)
      const initial = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: {
          targetType: "workspace",
          subjectWorkspaceId: workspaceId,
          subjectWorkspaceMemberId: null,
          subjectActorId: null,
          subjectConversationId: null,
          subjectConversationActorContextId: null,
        },
      })
      const inserted = await db
        .insertInto("resource_access_bindings")
        .values(initial)
        .returning("id")
        .executeTakeFirstOrThrow()

      await updateGrantTargets(db, {
        bindingId: inserted.id as string,
        newTarget: {
          targetType: "workspace_member",
          subjectWorkspaceId: null,
          subjectWorkspaceMemberId: guestMemberId,
          subjectActorId: null,
          subjectConversationId: null,
          subjectConversationActorContextId: null,
        },
      })

      const row = await db
        .selectFrom("resource_access_bindings")
        .select("subject_id")
        .where("id", "=", inserted.id as string)
        .executeTakeFirstOrThrow()
      const ref = await loadAccessSubject(db, row.subject_id as string)
      assert.deepEqual(ref, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: guestMemberId,
      })
    })
  }
)

test(
  "describeAccessGrants returns the active grants plus a counter",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db, "owner@example.test")
      const workspaceRow = await db
        .insertInto("workspaces")
        .values({
          owner_id: ownerId,
          slug: `ws-${Math.random().toString(36).slice(2, 10)}`,
          name: "test workspace",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const workspaceId = workspaceRow.id as string
      const actorId = await insertActor(db, workspaceId)
      const values = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: {
          targetType: "workspace",
          subjectWorkspaceId: workspaceId,
          subjectWorkspaceMemberId: null,
          subjectActorId: null,
          subjectConversationId: null,
          subjectConversationActorContextId: null,
        },
      })
      await db.insertInto("resource_access_bindings").values(values).execute()
      const result = await describeAccessGrants(db, {
        resourceType: "actor",
        resourceId: actorId,
      })
      assert.equal(result.activeCount, 1)
      assert.equal(result.grants.length, 1)
    })
  }
)

test(
  "loadAccessBindingRowsForResources returns [] for empty resourceIds",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const rows = await loadAccessBindingRowsForResources(db, {
        resourceType: "actor",
        resourceIds: [],
      })
      assert.deepEqual(rows, [])
    })
  }
)

test(
  "loadAccessBindingRowsForResources returns matching bindings for a single resource",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const values = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: workspaceTargetShape(workspaceId),
      })
      await db.insertInto("resource_access_bindings").values(values).execute()
      const rows = await loadAccessBindingRowsForResources(db, {
        resourceType: "actor",
        resourceIds: [actorId],
      })
      assert.equal(rows.length, 1)
      assert.equal(rows[0].resource_id, actorId)
      assert.equal(rows[0].target_type, "workspace")
    })
  }
)

test(
  "loadAccessBindingRowsForResources groups multi-resource bindings and honors workspaceId + includeRevoked",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const otherWorkspaceId = await insertWorkspaceWithOwner(db)
      const actor1 = await insertActor(db, workspaceId)
      const actor2 = await insertActor(db, workspaceId)
      const actorOther = await insertActor(db, otherWorkspaceId)
      for (const [wsId, aId] of [
        [workspaceId, actor1],
        [workspaceId, actor2],
        [otherWorkspaceId, actorOther],
      ] as const) {
        const values = await buildResourceAccessBindingInsertValues(db, {
          workspaceId: wsId,
          resourceType: "actor",
          resourceId: aId,
          target: workspaceTargetShape(wsId),
        })
        await db.insertInto("resource_access_bindings").values(values).execute()
      }
      const inserted = await db
        .selectFrom("resource_access_bindings")
        .select("id")
        .where("actor_id", "=", actor1)
        .executeTakeFirstOrThrow()
      await revokeGrant(db, { bindingId: inserted.id as string })

      const activeOnly = await loadAccessBindingRowsForResources(db, {
        resourceType: "actor",
        resourceIds: [actor1, actor2, actorOther],
        workspaceId,
      })
      assert.equal(activeOnly.length, 1)
      assert.equal(activeOnly[0].resource_id, actor2)

      const includingRevoked = await loadAccessBindingRowsForResources(db, {
        resourceType: "actor",
        resourceIds: [actor1, actor2, actorOther],
        workspaceId,
        includeRevoked: true,
      })
      assert.equal(includingRevoked.length, 2)
      const ids = includingRevoked.map((row) => row.resource_id).sort()
      assert.deepEqual(ids, [actor1, actor2].sort())
    })
  }
)

test(
  "loadAccessBindingRowsForResource is the single-id wrapper around loadAccessBindingRowsForResources",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const values = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: workspaceTargetShape(workspaceId),
      })
      await db.insertInto("resource_access_bindings").values(values).execute()
      const rows = await loadAccessBindingRowsForResource(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
      })
      assert.equal(rows.length, 1)
      assert.equal(rows[0].resource_id, actorId)
    })
  }
)

test(
  "hasAnyBindingForResourceOn returns false when there are no bindings and true once one is written",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const before = await hasAnyBindingForResourceOn(client, {
        resourceType: "actor",
        resourceId: actorId,
      })
      assert.equal(before, false)
      const values = await buildResourceAccessBindingInsertValuesOn(client, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: workspaceTargetShape(workspaceId),
      })
      await db.insertInto("resource_access_bindings").values(values).execute()
      const after = await hasAnyBindingForResourceOn(client, {
        resourceType: "actor",
        resourceId: actorId,
      })
      assert.equal(after, true)
    })
  }
)

test(
  "hasAnyBindingForResourceOn with activeOnly=true ignores revoked rows",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const values = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: workspaceTargetShape(workspaceId),
      })
      const inserted = await db
        .insertInto("resource_access_bindings")
        .values(values)
        .returning("id")
        .executeTakeFirstOrThrow()
      await revokeGrant(db, { bindingId: inserted.id as string })

      const anyBinding = await hasAnyBindingForResourceOn(client, {
        resourceType: "actor",
        resourceId: actorId,
      })
      assert.equal(anyBinding, true)

      const activeBinding = await hasAnyBindingForResourceOn(client, {
        resourceType: "actor",
        resourceId: actorId,
        activeOnly: true,
      })
      assert.equal(activeBinding, false)
    })
  }
)

test(
  "findActiveBindingIdByResourceAndSubject returns the binding id when active",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const values = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: workspaceTargetShape(workspaceId),
      })
      const inserted = await db
        .insertInto("resource_access_bindings")
        .values(values)
        .returning("id")
        .executeTakeFirstOrThrow()
      const subjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })

      const found = await findActiveBindingIdByResourceAndSubject(client, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        subjectId,
      })
      assert.equal(found, inserted.id)
    })
  }
)

test(
  "findActiveBindingIdByResourceAndSubject returns null when the binding is revoked or missing",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const subjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      const nothing = await findActiveBindingIdByResourceAndSubject(client, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        subjectId,
      })
      assert.equal(nothing, null)
    })
  }
)

test(
  "updateGrantConversationTypeMaskOverride writes the override and round-trips",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const values = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: workspaceTargetShape(workspaceId),
      })
      const inserted = await db
        .insertInto("resource_access_bindings")
        .values(values)
        .returning("id")
        .executeTakeFirstOrThrow()

      await updateGrantConversationTypeMaskOverride(db, {
        bindingId: inserted.id as string,
        workspaceId,
        conversationTypeMaskOverride: 7,
      })
      const after = await db
        .selectFrom("resource_access_bindings")
        .select("conversation_type_mask_override")
        .where("id", "=", inserted.id as string)
        .executeTakeFirstOrThrow()
      assert.equal(after.conversation_type_mask_override, 7)

      await updateGrantConversationTypeMaskOverride(db, {
        bindingId: inserted.id as string,
        conversationTypeMaskOverride: null,
      })
      const cleared = await db
        .selectFrom("resource_access_bindings")
        .select("conversation_type_mask_override")
        .where("id", "=", inserted.id as string)
        .executeTakeFirstOrThrow()
      assert.equal(cleared.conversation_type_mask_override, null)
    })
  }
)

test(
  "revokeGrantsByIdsOn revokes active bindings and is a no-op for already-revoked rows",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actor1 = await insertActor(db, workspaceId)
      const actor2 = await insertActor(db, workspaceId)
      const ids: string[] = []
      for (const a of [actor1, actor2]) {
        const values = await buildResourceAccessBindingInsertValues(db, {
          workspaceId,
          resourceType: "actor",
          resourceId: a,
          target: workspaceTargetShape(workspaceId),
        })
        const inserted = await db
          .insertInto("resource_access_bindings")
          .values(values)
          .returning("id")
          .executeTakeFirstOrThrow()
        ids.push(inserted.id as string)
      }
      await revokeGrantsByIdsOn(client, ids)
      const rows = await db
        .selectFrom("resource_access_bindings")
        .select(["id", "status"])
        .where("id", "in", ids)
        .execute()
      assert.equal(rows.length, 2)
      for (const r of rows) assert.equal(r.status, "revoked")

      await revokeGrantsByIdsOn(client, ids)
      const stillRevoked = await db
        .selectFrom("resource_access_bindings")
        .select("status")
        .where("id", "in", ids)
        .execute()
      for (const r of stillRevoked) assert.equal(r.status, "revoked")

      await revokeGrantsByIdsOn(client, [])
    })
  }
)

test(
  "hardDeleteBindingsForResourceOn removes every binding tied to a resource",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const values = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: workspaceTargetShape(workspaceId),
      })
      await db.insertInto("resource_access_bindings").values(values).execute()
      const before = await db
        .selectFrom("resource_access_bindings")
        .select("id")
        .where("actor_id", "=", actorId)
        .execute()
      assert.equal(before.length, 1)

      await hardDeleteBindingsForResourceOn(client, {
        resourceType: "actor",
        resourceId: actorId,
      })
      const after = await db
        .selectFrom("resource_access_bindings")
        .select("id")
        .where("actor_id", "=", actorId)
        .execute()
      assert.equal(after.length, 0)
    })
  }
)

test(
  "hardDeleteBindingsForResource (kysely flavour) hard-deletes bindings for the resource",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      await db
        .insertInto("resource_access_bindings")
        .values(
          await buildResourceAccessBindingInsertValues(db, {
            workspaceId,
            resourceType: "actor",
            resourceId: actorId,
            target: {
              targetType: "workspace",
              subjectWorkspaceId: workspaceId,
              subjectActorId: null,
              subjectConversationId: null,
              subjectConversationActorContextId: null,
            },
          })
        )
        .execute()
      await hardDeleteBindingsForResource(db, {
        resourceType: "actor",
        resourceId: actorId,
      })
      const remaining = await loadAccessBindingRowsForResources(db, {
        resourceType: "actor",
        resourceIds: [actorId],
        includeRevoked: true,
      })
      assert.equal(remaining.length, 0)
    })
  }
)

test(
  "listResourceIdsForWorkspaceByBindingFilter returns matching resource ids by workspace + subject filter",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorIdA = await insertActor(db, workspaceId)
      const actorIdB = await insertActor(db, workspaceId)
      const subjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      await db
        .insertInto("resource_access_bindings")
        .values(
          await buildResourceAccessBindingInsertValues(db, {
            workspaceId,
            resourceType: "actor",
            resourceId: actorIdA,
            target: {
              targetType: "workspace",
              subjectWorkspaceId: workspaceId,
              subjectActorId: null,
              subjectConversationId: null,
              subjectConversationActorContextId: null,
            },
          })
        )
        .execute()
      const all = await listResourceIdsForWorkspaceByBindingFilter(db, {
        workspaceId,
        resourceType: "actor",
      })
      assert.ok(all.includes(actorIdA))
      assert.ok(!all.includes(actorIdB))

      const filteredBySubject =
        await listResourceIdsForWorkspaceByBindingFilter(db, {
          workspaceId,
          resourceType: "actor",
          subjectId,
        })
      assert.deepEqual(filteredBySubject, [actorIdA])

      const noMatch = await listResourceIdsForWorkspaceByBindingFilter(db, {
        workspaceId,
        resourceType: "actor",
        subjectId: "00000000-0000-0000-0000-000000000000",
      })
      assert.deepEqual(noMatch, [])
    })
  }
)

test(
  "getAccessBindingRowById returns a normalized row for the matching id, null for misses",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const values = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: workspaceTargetShape(workspaceId),
      })
      const inserted = await db
        .insertInto("resource_access_bindings")
        .values(values)
        .returning("id")
        .executeTakeFirstOrThrow()

      const matchAll = await getAccessBindingRowById(db, {
        bindingId: inserted.id as string,
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
      })
      assert.ok(matchAll)
      assert.equal(matchAll!.id, inserted.id)
      assert.equal(matchAll!.resource_id, actorId)
      assert.equal(matchAll!.target_type, "workspace")

      const matchByType = await getAccessBindingRowById(db, {
        bindingId: inserted.id as string,
        resourceType: "actor",
      })
      assert.ok(matchByType)

      const wrongWorkspace = await getAccessBindingRowById(db, {
        bindingId: inserted.id as string,
        workspaceId: "00000000-0000-0000-0000-000000000000",
        resourceType: "actor",
      })
      assert.equal(wrongWorkspace, null)

      const missing = await getAccessBindingRowById(db, {
        bindingId: "00000000-0000-0000-0000-000000000000",
        resourceType: "actor",
      })
      assert.equal(missing, null)
    })
  }
)

test(
  "listResourceIdsForWorkspaceByBindingFilter returns matching resource ids by workspace + subject filter",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorIdA = await insertActor(db, workspaceId)
      const actorIdB = await insertActor(db, workspaceId)
      const subjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      await db
        .insertInto("resource_access_bindings")
        .values(
          await buildResourceAccessBindingInsertValues(db, {
            workspaceId,
            resourceType: "actor",
            resourceId: actorIdA,
            target: {
              targetType: "workspace",
              subjectWorkspaceId: workspaceId,
              subjectActorId: null,
              subjectConversationId: null,
              subjectConversationActorContextId: null,
            },
          })
        )
        .execute()
      const all = await listResourceIdsForWorkspaceByBindingFilter(db, {
        workspaceId,
        resourceType: "actor",
      })
      assert.ok(all.includes(actorIdA))
      assert.ok(!all.includes(actorIdB))

      const filteredBySubject =
        await listResourceIdsForWorkspaceByBindingFilter(db, {
          workspaceId,
          resourceType: "actor",
          subjectId,
        })
      assert.deepEqual(filteredBySubject, [actorIdA])

      const noMatch = await listResourceIdsForWorkspaceByBindingFilter(db, {
        workspaceId,
        resourceType: "actor",
        subjectId: "00000000-0000-0000-0000-000000000000",
      })
      assert.deepEqual(noMatch, [])
    })
  }
)

async function insertWorkspaceWithOwner(
  db: import("kysely").Kysely<any>
): Promise<string> {
  const ownerId = await insertUser(db, "owner@example.test")
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

test(
  "insertAccessBindingReturningIdOn writes a binding and returns its id",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const id = await insertAccessBindingReturningIdOn(client, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: workspaceTargetShape(workspaceId),
        source: "manual",
        reason: "test",
      })
      assert.ok(id, "returned id should be non-empty")
      const persisted = await db
        .selectFrom("resource_access_bindings")
        .select(["id", "workspace_id", "actor_id", "subject_id", "source"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow()
      assert.equal(persisted.workspace_id, workspaceId)
      assert.equal(persisted.actor_id, actorId)
      assert.equal(persisted.source, "manual")
      assert.ok(persisted.subject_id, "subject_id must be populated")
    })
  }
)

test(
  "insertAccessBindingReturningRowOn returns a row with target_type + subject_* projections reconstructed",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db, client }) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const row = await insertAccessBindingReturningRowOn(client, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: workspaceTargetShape(workspaceId),
      })
      assert.equal(row.workspace_id, workspaceId)
      assert.equal(row.actor_id, actorId)
      assert.equal(row.target_type, "workspace")
      assert.equal(row.subject_workspace_id, workspaceId)
      assert.equal(row.subject_workspace_member_id, null)
      assert.equal(row.subject_actor_id, null)
      assert.equal(row.subject_conversation_id, null)
      assert.equal(row.subject_conversation_actor_context_id, null)
      assert.ok(row.subject_id, "subject_id must be populated")

      const persisted = await db
        .selectFrom("resource_access_bindings")
        .select("id")
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow()
      assert.equal(persisted.id, row.id)
    })
  }
)

function workspaceTargetShape(workspaceId: string) {
  return {
    targetType: "workspace" as const,
    subjectWorkspaceId: workspaceId,
    subjectWorkspaceMemberId: null,
    subjectActorId: null,
    subjectConversationId: null,
    subjectConversationActorContextId: null,
  }
}
