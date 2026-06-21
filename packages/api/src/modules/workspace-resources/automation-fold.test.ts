import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import {
  SUBJECT_KIND,
  WORKSPACE_RESOURCE_GRANT_PERMISSION,
  WORKSPACE_RESOURCE_GRANT_SOURCE,
  WORKSPACE_RESOURCE_GRANT_STATUS,
  WORKSPACE_RESOURCE_KIND,
} from "@synapse/shared"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { insertWorkspaceResourceGrant } from "./grant-storage.js"
import { listGrantedWorkspaceResources } from "./repo.js"
import { hasKindAdmin } from "./service.js"

/**
 * Regression coverage for the automation event-source fold into
 * workspace_resource_grants:
 *   - §6.5: an "open to all" automation source (workspace-subject use grant)
 *     must NOT leak into the cross-kind /workspace-resources/discover query.
 *   - §6.1: the scope-coupling DB trigger — scoped `use` on an
 *     automation_event_source requires an actor|remote_agent subject + a
 *     conversation scope; a workspace_member + conversation scope is rejected.
 */

type AnyDb = import("kysely").Kysely<any>

async function insertUser(db: AnyDb): Promise<string> {
  const row = await db
    .insertInto("users")
    .values({
      email: `u-${crypto.randomUUID()}@example.test`,
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
      ownerId,
      slug: `ws-${crypto.randomUUID().slice(0, 8)}`,
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
    .insertInto("workspaceMembers")
    .values({ workspaceId, userId, trustLevel: "member" })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function memberSubject(db: AnyDb, memberId: string): Promise<string> {
  return upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    workspaceMemberId: memberId,
  })
}

async function insertConversation(
  db: AnyDb,
  workspaceId: string
): Promise<string> {
  const row = await db
    .insertInto("conversations")
    .values({ kind: "group", workspaceId, title: "conv" })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertActor(db: AnyDb, workspaceId: string): Promise<string> {
  const id = crypto.randomUUID()
  const creator = await memberSubject(
    db,
    await insertWorkspaceMember(db, workspaceId, await insertUser(db))
  )
  await db
    .insertInto("workspaceResources")
    .values({
      id,
      workspaceId,
      kind: "actor",
      displayName: "actor",
      createdBySubjectId: creator,
      status: "active",
    } as any)
    .execute()
  await db
    .insertInto("actors")
    .values({ id, role: "assistant", title: "actor", currentVersion: 1 })
    .execute()
  return id
}

// Insert an automation_event_source (6th workspace_resources kind): root then
// detail in the same rolled-back transaction (detail-consistency trigger is
// DEFERRABLE INITIALLY DEFERRED).
async function insertEventSource(
  db: AnyDb,
  workspaceId: string,
  ownerMemberId: string
): Promise<string> {
  const id = crypto.randomUUID()
  const subjectId = await memberSubject(db, ownerMemberId)
  await db
    .insertInto("workspaceResources")
    .values({
      id,
      workspaceId,
      kind: "automation_event_source",
      displayName: "src",
      ownerSubjectId: subjectId,
      createdBySubjectId: subjectId,
      status: "active",
    } as any)
    .execute()
  await db
    .insertInto("automationEventSources")
    .values({
      id,
      workspaceId,
      providerKind: "internal",
      sourceKey: `src-${crypto.randomUUID().slice(0, 8)}`,
    } as any)
    .execute()
  return id
}

async function insertInstalledSkill(
  db: AnyDb,
  workspaceId: string,
  ownerMemberId: string
): Promise<string> {
  const snapshot = await db
    .insertInto("skillSnapshots")
    .values({
      name: "skill",
      description: "",
      contentHash: `h-${crypto.randomUUID()}`,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const id = crypto.randomUUID()
  const subjectId = await memberSubject(db, ownerMemberId)
  await db
    .insertInto("workspaceResources")
    .values({
      id,
      workspaceId,
      kind: "installed_skill",
      displayName: "skill",
      ownerSubjectId: subjectId,
      createdBySubjectId: subjectId,
      status: "active",
    } as any)
    .execute()
  await db
    .insertInto("installedSkills")
    .values({ id, currentSnapshotId: snapshot.id })
    .execute()
  return id
}

test(
  "§6.5 discover no-leak: a workspace-subject use grant on an automation source does NOT appear in listGrantedWorkspaceResources, but a skill grant does",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, ownerId)
      const ownerMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        ownerId
      )
      const guestMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        await insertUser(db)
      )

      const eventSourceId = await insertEventSource(
        db,
        workspaceId,
        ownerMemberId
      )
      const skillId = await insertInstalledSkill(db, workspaceId, ownerMemberId)

      // "Open to all" workspace-subject use grants on BOTH resources.
      const workspaceTarget = {
        subject: { kind: SUBJECT_KIND.WORKSPACE, workspaceId },
      }
      await insertWorkspaceResourceGrant(db, {
        workspaceId,
        workspaceResourceId: eventSourceId,
        target: workspaceTarget,
        permissions: [WORKSPACE_RESOURCE_GRANT_PERMISSION.USE],
        source: "manual",
      })
      await insertWorkspaceResourceGrant(db, {
        workspaceId,
        workspaceResourceId: skillId,
        target: workspaceTarget,
        permissions: [WORKSPACE_RESOURCE_GRANT_PERMISSION.USE],
        source: "manual",
      })

      const workspaceSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      const guestSubjectId = await memberSubject(db, guestMemberId)

      const discovered = await listGrantedWorkspaceResources(
        {
          workspaceId,
          claimSubjectIds: [workspaceSubjectId, guestSubjectId],
          conversationSubjectId: null,
        },
        db
      )
      const ids = discovered.map((row) => row.id)
      assert.ok(
        ids.includes(skillId),
        "the workspace-granted skill must surface in discover"
      )
      assert.ok(
        !ids.includes(eventSourceId),
        "the automation event source must NOT leak into discover"
      )
    })
  }
)

// A trigger rejection aborts the surrounding Postgres transaction, so the
// reject case and the accept case live in separate withTestDb invocations.
test(
  "§6.1 scope-coupling: scoped use on an automation source REJECTS a workspace_member subject + conversation scope",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, ownerId)
      const ownerMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        ownerId
      )
      const eventSourceId = await insertEventSource(
        db,
        workspaceId,
        ownerMemberId
      )
      const conversationId = await insertConversation(db, workspaceId)
      const memberSubjectId = await memberSubject(db, ownerMemberId)
      const conversationScopeSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId,
      })

      await assert.rejects(
        () =>
          db
            .insertInto("workspaceResourceGrants")
            .values({
              workspaceId,
              workspaceResourceId: eventSourceId,
              subjectId: memberSubjectId,
              scopeSubjectId: conversationScopeSubjectId,
              permissions: [WORKSPACE_RESOURCE_GRANT_PERMISSION.USE],
              status: WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE,
              source: WORKSPACE_RESOURCE_GRANT_SOURCE.MANUAL,
            } as any)
            .execute(),
        /scoped use requires subject kind actor\|remote_agent and conversation scope/i
      )
    })
  }
)

test(
  "§6.1 scope-coupling: scoped use on an automation source ACCEPTS an actor subject + conversation scope",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, ownerId)
      const ownerMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        ownerId
      )
      const eventSourceId = await insertEventSource(
        db,
        workspaceId,
        ownerMemberId
      )
      const conversationId = await insertConversation(db, workspaceId)
      const actorId = await insertActor(db, workspaceId)
      const actorSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId,
      })
      const conversationScopeSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId,
      })

      const accepted = await db
        .insertInto("workspaceResourceGrants")
        .values({
          workspaceId,
          workspaceResourceId: eventSourceId,
          subjectId: actorSubjectId,
          scopeSubjectId: conversationScopeSubjectId,
          permissions: [WORKSPACE_RESOURCE_GRANT_PERMISSION.USE],
          status: WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE,
          source: WORKSPACE_RESOURCE_GRANT_SOURCE.MANUAL,
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      assert.ok(accepted.id)
    })
  }
)

test("§6.7 manage gate: the automation_admin kind-admin key authorizes manage over an (ownerless) automation_event_source; a non-holder is rejected", () => {
  // The kind-admin arm of requireManageWorkspaceResource: an ownerless source
  // (no owner_subject_id) is manageable by a holder of the kind's admin access
  // key. For automation_event_source that key is `automation_admin` (plan §6.7,
  // D2) — NOT a different kind's key.
  assert.equal(
    hasKindAdmin(
      { accessKeys: ["automation_admin"] },
      WORKSPACE_RESOURCE_KIND.AUTOMATION_EVENT_SOURCE
    ),
    true,
    "a holder of automation_admin can manage an ownerless automation source"
  )
  assert.equal(
    hasKindAdmin(
      { accessKeys: [] },
      WORKSPACE_RESOURCE_KIND.AUTOMATION_EVENT_SOURCE
    ),
    false,
    "a member with no kind-admin key cannot manage the source"
  )
  assert.equal(
    hasKindAdmin(
      { accessKeys: ["device_admin", "plugin_admin"] },
      WORKSPACE_RESOURCE_KIND.AUTOMATION_EVENT_SOURCE
    ),
    false,
    "holding a DIFFERENT kind's admin key does not authorize the automation source"
  )
})
