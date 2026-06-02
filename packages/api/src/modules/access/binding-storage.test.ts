import test from "node:test"
import assert from "node:assert/strict"
import {
  SUBJECT_KIND,
  actorRef,
  conversationRef,
  workspaceMemberRef,
  workspaceRef,
} from "@synapse/shared"
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
        target: { subject: workspaceRef(workspaceId) },
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
      const target = { subject: workspaceRef(workspaceId) }

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
        target: { subject: workspaceRef(workspaceId) },
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

test(
  "listGrantsForResource decodes the joined access_subjects row for an actor target",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const grantedActorId = await insertActor(db, workspaceId)
      const targetActorId = await insertActor(db, workspaceId)

      const insert = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: targetActorId,
        target: { subject: actorRef(grantedActorId) },
      })
      await db.insertInto("resource_access_bindings").values(insert).execute()

      const grants = await listGrantsForResource(db, {
        resourceType: "actor",
        resourceId: targetActorId,
      })
      assert.equal(grants.length, 1)
      assert.equal(grants[0].target.subject.kind, "actor")
      assert.equal(
        (grants[0].target.subject as { actorId: string }).actorId,
        grantedActorId
      )
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
        target: { subject: workspaceMemberRef(memberId) },
      })
      await db.insertInto("resource_access_bindings").values(insert).execute()

      const grants = await listGrantsForResource(db, {
        resourceType: "actor",
        resourceId: targetActorId,
      })
      assert.equal(grants.length, 1)
      assert.equal(grants[0].target.subject.kind, "workspace_member")
      assert.equal(
        (grants[0].target.subject as { memberId: string }).memberId,
        memberId
      )
    })
  }
)

test(
  "listGrantsForResource decodes an actor + scope=conversation target",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const grantedActorId = await insertActor(db, workspaceId)
      const targetActorId = await insertActor(db, workspaceId)
      const conversationRow = await db
        .insertInto("conversations")
        .values({
          kind: "group",
          workspace_id: workspaceId,
          title: "test conversation",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const conversationId = conversationRow.id as string

      const insert = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: targetActorId,
        target: {
          subject: actorRef(grantedActorId),
          scope: conversationRef(conversationId),
        },
      })
      await db.insertInto("resource_access_bindings").values(insert).execute()

      const grants = await listGrantsForResource(db, {
        resourceType: "actor",
        resourceId: targetActorId,
      })
      assert.equal(grants.length, 1)
      assert.equal(grants[0].target.subject.kind, "actor")
      assert.equal(
        (grants[0].target.subject as { actorId: string }).actorId,
        grantedActorId
      )
      assert.equal(grants[0].target.scope?.kind, "conversation")
      assert.equal(
        (grants[0].target.scope as { conversationId: string }).conversationId,
        conversationId
      )
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
          target: { subject: workspaceMemberRef(memberId) },
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

test("augmentInsertedBindingRowWithTarget copies the subject shape onto the raw row", () => {
  const augmented = augmentInsertedBindingRowWithTarget(
    { subject_id: "subj-1", extra: "passthrough" } as any,
    { subject: workspaceMemberRef("m-1") }
  )
  assert.equal(augmented.subject_kind, "workspace_member")
  assert.equal(augmented.subject_workspace_member_id_via_join, "m-1")
  assert.equal(augmented.subject_actor_id_via_join, null)
  assert.equal((augmented as any).extra, "passthrough")
})

test(
  "revokeGrant flips status to revoked and is idempotent",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const values = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: { subject: workspaceRef(workspaceId) },
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
        target: { subject: workspaceRef(workspaceId) },
      })
      const inserted = await db
        .insertInto("resource_access_bindings")
        .values(initial)
        .returning("id")
        .executeTakeFirstOrThrow()

      await updateGrantTargets(db, {
        bindingId: inserted.id as string,
        newTarget: { subject: workspaceMemberRef(guestMemberId) },
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
  "updateGrantTargets rewrites scope_subject_id alongside subject_id",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      // P3 regression (post-D4 round 7 review): a grant moving from
      // scoped → unscoped, or from one conversation scope to another,
      // must NOT leave the prior scope_subject_id on the row. Earlier
      // updateGrantTargets only wrote subject_id, so the stale scope
      // followed the binding into its new identity — visibility looked
      // correct in tests that only exercised unscoped → unscoped (the
      // pre-fix test above) but leaked in the scoped variants.
      const workspaceId = await insertWorkspaceWithOwner(db)
      const grantedActorId = await insertActor(db, workspaceId)
      const targetActorId = await insertActor(db, workspaceId)
      const convA = (
        await db
          .insertInto("conversations")
          .values({
            kind: "group",
            workspace_id: workspaceId,
            title: "conv A",
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id as string
      const convB = (
        await db
          .insertInto("conversations")
          .values({
            kind: "group",
            workspace_id: workspaceId,
            title: "conv B",
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id as string

      // Insert with scope=convA.
      const initial = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: targetActorId,
        target: {
          subject: actorRef(grantedActorId),
          scope: conversationRef(convA),
        },
      })
      const inserted = await db
        .insertInto("resource_access_bindings")
        .values(initial)
        .returning("id")
        .executeTakeFirstOrThrow()

      // (1) Move to scope=convB. scope_subject_id must change.
      await updateGrantTargets(db, {
        bindingId: inserted.id as string,
        newTarget: {
          subject: actorRef(grantedActorId),
          scope: conversationRef(convB),
        },
      })
      const afterMoveScope = await db
        .selectFrom("resource_access_bindings as binding")
        .innerJoin(
          "access_subjects as scope_subj",
          "scope_subj.id",
          "binding.scope_subject_id"
        )
        .select("scope_subj.conversation_id as conversation_id")
        .where("binding.id", "=", inserted.id as string)
        .executeTakeFirstOrThrow()
      assert.equal(
        afterMoveScope.conversation_id,
        convB,
        "scope_subject_id must follow the new target's scope (convB)"
      )

      // (2) Move to unscoped. scope_subject_id must become NULL.
      await updateGrantTargets(db, {
        bindingId: inserted.id as string,
        newTarget: { subject: actorRef(grantedActorId) },
      })
      const afterUnscoped = await db
        .selectFrom("resource_access_bindings")
        .select("scope_subject_id")
        .where("id", "=", inserted.id as string)
        .executeTakeFirstOrThrow()
      assert.equal(
        afterUnscoped.scope_subject_id,
        null,
        "scope_subject_id must be cleared when the new target has no scope"
      )
    })
  }
)

test(
  "describeAccessGrants returns the active grants plus a counter",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const values = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: { subject: workspaceRef(workspaceId) },
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
        target: { subject: workspaceRef(workspaceId) },
      })
      await db.insertInto("resource_access_bindings").values(values).execute()
      const rows = await loadAccessBindingRowsForResources(db, {
        resourceType: "actor",
        resourceIds: [actorId],
      })
      assert.equal(rows.length, 1)
      assert.equal(rows[0].resource_id, actorId)
      assert.equal((rows[0] as any).subject_kind, "workspace")
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
          target: { subject: workspaceRef(wsId) },
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
        target: { subject: workspaceRef(workspaceId) },
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
    await withTestDbAndClient(async ({ db }) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const before = await hasAnyBindingForResourceOn(db, {
        resourceType: "actor",
        resourceId: actorId,
      })
      assert.equal(before, false)
      const values = await buildResourceAccessBindingInsertValuesOn(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: { subject: workspaceRef(workspaceId) },
      })
      await db.insertInto("resource_access_bindings").values(values).execute()
      const after = await hasAnyBindingForResourceOn(db, {
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
    await withTestDbAndClient(async ({ db }) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const values = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: { subject: workspaceRef(workspaceId) },
      })
      const inserted = await db
        .insertInto("resource_access_bindings")
        .values(values)
        .returning("id")
        .executeTakeFirstOrThrow()
      await revokeGrant(db, { bindingId: inserted.id as string })

      const anyBinding = await hasAnyBindingForResourceOn(db, {
        resourceType: "actor",
        resourceId: actorId,
      })
      assert.equal(anyBinding, true)

      const activeBinding = await hasAnyBindingForResourceOn(db, {
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
    await withTestDbAndClient(async ({ db }) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const values = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: { subject: workspaceRef(workspaceId) },
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

      const found = await findActiveBindingIdByResourceAndSubject(db, {
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
    await withTestDbAndClient(async ({ db }) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const subjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      const nothing = await findActiveBindingIdByResourceAndSubject(db, {
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
  "findActiveBindingIdByResourceAndSubject scoped bindings don't collide with unscoped — round-8 P2 regression",
  { timeout: 5 * 60_000 },
  async () => {
    // The pre-fix bug: when ensureSkillBinding for (actor + scope=conv)
    // ran while the conversation's access_subjects row didn't exist
    // yet, findAccessSubjectIdOn(scopeRef) returned null, and the
    // dedup query degraded to "scope_subject_id IS NOT DISTINCT FROM
    // NULL" — matching an existing UNSCOPED binding. Ensuring a scoped
    // binding then silently returned the old unscoped id and the new
    // scoped row never got inserted. This test directly asserts that
    // an unscoped binding is NOT returned when the caller searches for
    // a scoped one.
    await withTestDbAndClient(async ({ db }) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const grantedActorId = await insertActor(db, workspaceId)
      const targetActorId = await insertActor(db, workspaceId)
      const convId = (
        await db
          .insertInto("conversations")
          .values({
            kind: "group",
            workspace_id: workspaceId,
            title: "scope-vs-unscoped",
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id as string

      // Insert an UNSCOPED binding for actor → actor.
      const unscopedValues = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: targetActorId,
        target: { subject: actorRef(grantedActorId) },
      })
      const unscoped = await db
        .insertInto("resource_access_bindings")
        .values(unscopedValues)
        .returning("id")
        .executeTakeFirstOrThrow()

      const subjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: grantedActorId,
      })
      const scopeSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: convId,
      })

      // Look up the unscoped binding — should match.
      const foundUnscoped = await findActiveBindingIdByResourceAndSubject(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: targetActorId,
        subjectId,
        scopeSubjectId: null,
      })
      assert.equal(foundUnscoped, unscoped.id)

      // Look up the SCOPED binding — must NOT collapse onto the
      // unscoped one. Pre-fix this returned `unscoped.id`.
      const foundScoped = await findActiveBindingIdByResourceAndSubject(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: targetActorId,
        subjectId,
        scopeSubjectId,
      })
      assert.equal(
        foundScoped,
        null,
        "scope_subject_id must be matched exactly — unscoped binding must NOT satisfy a scoped lookup"
      )
    })
  }
)

test(
  "listResourceIdsForWorkspaceByBindingFilter scope filter excludes other-scope bindings — round-8 P2 regression",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const grantedActorId = await insertActor(db, workspaceId)
      // Use `actor` as the bindable resource — installed_skills has
      // many required columns we'd otherwise have to fabricate.
      const targetActorA = await insertActor(db, workspaceId)
      const targetActorB = await insertActor(db, workspaceId)
      const convA = (
        await db
          .insertInto("conversations")
          .values({
            kind: "group",
            workspace_id: workspaceId,
            title: "conv A",
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id as string
      const convB = (
        await db
          .insertInto("conversations")
          .values({
            kind: "group",
            workspace_id: workspaceId,
            title: "conv B",
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id as string

      // Two scoped bindings for the same actor subject, different
      // conversations — one for target actor A in conv A, one for
      // target actor B in conv B.
      const insertScoped = async (resourceId: string, convId: string) => {
        const values = await buildResourceAccessBindingInsertValues(db, {
          workspaceId,
          resourceType: "actor",
          resourceId,
          target: {
            subject: actorRef(grantedActorId),
            scope: conversationRef(convId),
          },
        })
        await db.insertInto("resource_access_bindings").values(values).execute()
      }
      await insertScoped(targetActorA, convA)
      await insertScoped(targetActorB, convB)

      const subjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: grantedActorId,
      })
      const convAScopeId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: convA,
      })

      // Asking for (granted actor in conv A) must return ONLY targetActorA
      // — the pre-fix listing also returned targetActorB (other-scope
      // bindings) because scope_subject_id wasn't part of the filter.
      const inA = await listResourceIdsForWorkspaceByBindingFilter(db, {
        workspaceId,
        resourceType: "actor",
        subjectId,
        scopeSubjectId: convAScopeId,
      })
      assert.deepEqual([...inA].sort(), [targetActorA].sort())

      // Sanity: unscoped lookup (scope filter omitted) still returns both.
      const all = await listResourceIdsForWorkspaceByBindingFilter(db, {
        workspaceId,
        resourceType: "actor",
        subjectId,
      })
      assert.deepEqual([...all].sort(), [targetActorA, targetActorB].sort())
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
        target: { subject: workspaceRef(workspaceId) },
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
    await withTestDbAndClient(async ({ db }) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actor1 = await insertActor(db, workspaceId)
      const actor2 = await insertActor(db, workspaceId)
      const ids: string[] = []
      for (const a of [actor1, actor2]) {
        const values = await buildResourceAccessBindingInsertValues(db, {
          workspaceId,
          resourceType: "actor",
          resourceId: a,
          target: { subject: workspaceRef(workspaceId) },
        })
        const inserted = await db
          .insertInto("resource_access_bindings")
          .values(values)
          .returning("id")
          .executeTakeFirstOrThrow()
        ids.push(inserted.id as string)
      }
      await revokeGrantsByIdsOn(db, ids)
      const rows = await db
        .selectFrom("resource_access_bindings")
        .select(["id", "status"])
        .where("id", "in", ids)
        .execute()
      assert.equal(rows.length, 2)
      for (const r of rows) assert.equal(r.status, "revoked")

      await revokeGrantsByIdsOn(db, ids)
      const stillRevoked = await db
        .selectFrom("resource_access_bindings")
        .select("status")
        .where("id", "in", ids)
        .execute()
      for (const r of stillRevoked) assert.equal(r.status, "revoked")

      await revokeGrantsByIdsOn(db, [])
    })
  }
)

test(
  "hardDeleteBindingsForResourceOn removes every binding tied to a resource",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const values = await buildResourceAccessBindingInsertValues(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: { subject: workspaceRef(workspaceId) },
      })
      await db.insertInto("resource_access_bindings").values(values).execute()
      const before = await db
        .selectFrom("resource_access_bindings")
        .select("id")
        .where("actor_id", "=", actorId)
        .execute()
      assert.equal(before.length, 1)

      await hardDeleteBindingsForResourceOn(db, {
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
            target: { subject: workspaceRef(workspaceId) },
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
            target: { subject: workspaceRef(workspaceId) },
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
        target: { subject: workspaceRef(workspaceId) },
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
      assert.equal((matchAll as any).subject_kind, "workspace")

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
    await withTestDbAndClient(async ({ db }) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const id = await insertAccessBindingReturningIdOn(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: { subject: workspaceRef(workspaceId) },
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
  "insertAccessBindingReturningRowOn returns a row with subject_kind + projections reconstructed",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const workspaceId = await insertWorkspaceWithOwner(db)
      const actorId = await insertActor(db, workspaceId)
      const row = await insertAccessBindingReturningRowOn(db, {
        workspaceId,
        resourceType: "actor",
        resourceId: actorId,
        target: { subject: workspaceRef(workspaceId) },
      })
      assert.equal(row.workspace_id, workspaceId)
      assert.equal(row.actor_id, actorId)
      assert.equal((row as any).subject_kind, "workspace")
      assert.equal((row as any).subject_workspace_id_via_join, workspaceId)
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
