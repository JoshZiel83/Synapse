import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { CompiledQuery } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import {
  WORKSPACE_RESOURCE_GRANT_PERMISSION,
  WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS,
  WORKSPACE_RESOURCE_GRANT_SOURCE,
  WORKSPACE_RESOURCE_GRANT_STATUS,
  WORKSPACE_RESOURCE_KIND,
  WORKSPACE_RESOURCE_STATUS,
  SUBJECT_KIND,
} from "@synapse/shared"
import { upsertAccessSubject } from "../access/subject-registry.js"
import {
  cancelWorkspaceResourceGrantRequest,
  resolveWorkspaceResourceGrantRequest,
} from "./grant-storage.js"

type AnyDb = import("kysely").Kysely<any>

async function insertUser(db: AnyDb) {
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

async function insertWorkspace(db: AnyDb, ownerId: string) {
  const row = await db
    .insertInto("workspaces")
    .values({
      ownerId: ownerId,
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
) {
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

async function memberSubjectFor(db: AnyDb, memberId: string) {
  return upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId,
  })
}

// workspace_resources.created_by_subject_id is NOT NULL (owner→subject
// migration). Mint a member of the workspace and return its subject id so root
// inserts that don't otherwise need an owner still satisfy the creator FK.
async function creatorSubjectForWorkspace(db: AnyDb, workspaceId: string) {
  const memberId = await insertWorkspaceMember(
    db,
    workspaceId,
    await insertUser(db)
  )
  return memberSubjectFor(db, memberId)
}

async function insertSkillSnapshot(db: AnyDb) {
  const row = await db
    .insertInto("skillSnapshots")
    .values({
      name: "test skill",
      description: "test",
      contentHash: `hash-${crypto.randomUUID()}`,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertWorkspaceResourceDetail(
  db: AnyDb,
  input: {
    resourceId: string
    workspaceId: string
    kind: (typeof WORKSPACE_RESOURCE_KIND)[keyof typeof WORKSPACE_RESOURCE_KIND]
  }
) {
  switch (input.kind) {
    case WORKSPACE_RESOURCE_KIND.ACTOR:
      await db
        .insertInto("actors")
        .values({
          id: input.resourceId,
          role: "assistant",
          title: "actor detail",
          currentVersion: 1,
        } as any)
        .execute()
      return
    case WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL: {
      const snapshotId = await insertSkillSnapshot(db)
      await db
        .insertInto("installedSkills")
        .values({
          id: input.resourceId,
          currentSnapshotId: snapshotId,
          currentVersion: 1,
        } as any)
        .execute()
      return
    }
    case WORKSPACE_RESOURCE_KIND.PLUGIN_INSTALLATION: {
      const publisher = await db
        .insertInto("publishers")
        .values({
          slug: `pub-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "test publisher",
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      const item = await db
        .insertInto("catalogItems")
        .values({
          publisherId: publisher.id,
          itemKind: "plugin_package",
          slug: `plugin-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "test plugin",
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      const version = await db
        .insertInto("catalogVersions")
        .values({
          catalogItemId: item.id,
          version: "1.0.0",
          status: "active",
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      await db
        .insertInto("pluginInstallations")
        .values({
          id: input.resourceId,
          catalogItemId: item.id,
          catalogVersionId: version.id,
        } as any)
        .execute()
      return
    }
    default:
      throw new Error(
        `unsupported workspace resource detail kind for test: ${input.kind}`
      )
  }
}

test(
  "workspace_resources rejects an owner_subject_id from another workspace",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerA = await insertUser(db)
      const ownerB = await insertUser(db)
      const workspaceA = await insertWorkspace(db, ownerA)
      const workspaceB = await insertWorkspace(db, ownerB)
      const memberB = await insertWorkspaceMember(db, workspaceB, ownerB)
      // Owner is now an access_subjects FK; pointing a workspace-A resource at a
      // workspace-B member subject must be rejected by validate_workspace_resource_root's
      // owner workspace-consistency check.
      const ownerSubjectB = await memberSubjectFor(db, memberB)
      const creatorA = await creatorSubjectForWorkspace(db, workspaceA)

      await assert.rejects(
        () =>
          db
            .insertInto("workspaceResources")
            .values({
              id: crypto.randomUUID(),
              workspaceId: workspaceA,
              kind: WORKSPACE_RESOURCE_KIND.ACTOR,
              displayName: "bad owner",
              ownerSubjectId: ownerSubjectB,
              createdBySubjectId: creatorA,
              status: WORKSPACE_RESOURCE_STATUS.ACTIVE,
            } as any)
            .execute(),
        /owner_subject_id .* does not match resource workspace/i
      )
    })
  }
)

test(
  "workspace_resources requires exactly one matching detail row before transaction commit",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db)
      const workspaceId = await insertWorkspace(db, owner)
      const creator = await creatorSubjectForWorkspace(db, workspaceId)

      await assert.rejects(
        () =>
          (async () => {
            await db
              .insertInto("workspaceResources")
              .values({
                id: crypto.randomUUID(),
                workspaceId: workspaceId,
                kind: WORKSPACE_RESOURCE_KIND.ACTOR,
                displayName: "missing detail",
                createdBySubjectId: creator,
                status: WORKSPACE_RESOURCE_STATUS.ACTIVE,
              } as any)
              .execute()
            await db.executeQuery(
              CompiledQuery.raw(
                "SET CONSTRAINTS workspace_resources_detail_consistency_root_chk IMMEDIATE"
              )
            )
          })(),
        /exactly one matching detail row/i
      )
    })
  }
)

test(
  "workspace_resources rejects a detail row whose table does not match workspace_resources.kind",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db)
      const workspaceId = await insertWorkspace(db, owner)
      const resourceId = crypto.randomUUID()
      const creator = await creatorSubjectForWorkspace(db, workspaceId)

      await assert.rejects(
        () =>
          (async () => {
            await db
              .insertInto("workspaceResources")
              .values({
                id: resourceId,
                workspaceId: workspaceId,
                kind: WORKSPACE_RESOURCE_KIND.ACTOR,
                displayName: "wrong detail kind",
                createdBySubjectId: creator,
                status: WORKSPACE_RESOURCE_STATUS.ACTIVE,
              } as any)
              .execute()

            const snapshotId = await insertSkillSnapshot(db)
            await db
              .insertInto("installedSkills")
              .values({
                id: resourceId,
                currentSnapshotId: snapshotId,
                currentVersion: 1,
              } as any)
              .execute()
            await db.executeQuery(
              CompiledQuery.raw(
                "SET CONSTRAINTS workspace_resources_detail_consistency_root_chk IMMEDIATE"
              )
            )
          })(),
        /kind=actor is missing its actor detail row|exactly one matching detail row/i
      )
    })
  }
)

test(
  "workspace_resource_grants rejects contact_visible on a non-contact resource kind",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db)
      const workspaceId = await insertWorkspace(db, owner)
      const memberId = await insertWorkspaceMember(db, workspaceId, owner)
      const resourceId = crypto.randomUUID()
      const memberSubject = await memberSubjectFor(db, memberId)
      await db
        .insertInto("workspaceResources")
        .values({
          id: resourceId,
          workspaceId: workspaceId,
          kind: WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL,
          displayName: "skill app",
          ownerSubjectId: memberSubject,
          createdBySubjectId: memberSubject,
          status: WORKSPACE_RESOURCE_STATUS.ACTIVE,
        } as any)
        .execute()
      await insertWorkspaceResourceDetail(db, {
        resourceId,
        workspaceId,
        kind: WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL,
      })
      const memberSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId,
      })

      await assert.rejects(
        () =>
          db
            .insertInto("workspaceResourceGrants")
            .values({
              workspaceId: workspaceId,
              workspaceResourceId: resourceId,
              subjectId: memberSubjectId,
              permissions: [
                WORKSPACE_RESOURCE_GRANT_PERMISSION.CONTACT_VISIBLE,
              ],
              status: WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE,
              source: WORKSPACE_RESOURCE_GRANT_SOURCE.MANUAL,
            } as any)
            .execute(),
        /contact_visible/i
      )
    })
  }
)

test(
  "workspace_resource_grant_requests only allow self workspace_member contact-visible requests for actor/remote_agent apps",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db)
      const workspaceId = await insertWorkspace(db, owner)
      const requesterUser = await insertUser(db)
      const requesterMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        requesterUser
      )
      const otherUser = await insertUser(db)
      const otherMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        otherUser
      )
      const resourceId = crypto.randomUUID()
      await db
        .insertInto("workspaceResources")
        .values({
          id: resourceId,
          workspaceId: workspaceId,
          kind: WORKSPACE_RESOURCE_KIND.ACTOR,
          displayName: "actor app",
          createdBySubjectId: await memberSubjectFor(db, requesterMemberId),
          status: WORKSPACE_RESOURCE_STATUS.ACTIVE,
        } as any)
        .execute()
      await insertWorkspaceResourceDetail(db, {
        resourceId,
        workspaceId,
        kind: WORKSPACE_RESOURCE_KIND.ACTOR,
      })
      const otherMemberSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: otherMemberId,
      })

      await assert.rejects(
        () =>
          db
            .insertInto("workspaceResourceGrantRequests")
            .values({
              workspaceId: workspaceId,
              workspaceResourceId: resourceId,
              granteeSubjectId: otherMemberSubjectId,
              requestedPermissions: [
                WORKSPACE_RESOURCE_GRANT_PERMISSION.CONTACT_VISIBLE,
              ],
              requesterWorkspaceMemberId: requesterMemberId,
              status: WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS.PENDING,
            } as any)
            .execute(),
        /requester must request on behalf of their own workspace_member subject/i
      )
    })
  }
)

test(
  "resolveWorkspaceResourceGrantRequest rejects a request id routed through another workspace resource",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db)
      const workspaceId = await insertWorkspace(db, owner)
      const approverMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        owner
      )
      const requesterUser = await insertUser(db)
      const requesterMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        requesterUser
      )
      const resourceA = crypto.randomUUID()
      const resourceB = crypto.randomUUID()
      const approverSubject = await memberSubjectFor(db, approverMemberId)

      for (const resourceId of [resourceA, resourceB]) {
        await db
          .insertInto("workspaceResources")
          .values({
            id: resourceId,
            workspaceId: workspaceId,
            kind: WORKSPACE_RESOURCE_KIND.ACTOR,
            displayName: `actor-${resourceId.slice(0, 6)}`,
            ownerSubjectId: approverSubject,
            createdBySubjectId: approverSubject,
            status: WORKSPACE_RESOURCE_STATUS.ACTIVE,
          } as any)
          .execute()
        await insertWorkspaceResourceDetail(db, {
          resourceId,
          workspaceId,
          kind: WORKSPACE_RESOURCE_KIND.ACTOR,
        })
      }

      const requesterSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: requesterMemberId,
      })
      const request = await db
        .insertInto("workspaceResourceGrantRequests")
        .values({
          workspaceId: workspaceId,
          workspaceResourceId: resourceB,
          granteeSubjectId: requesterSubjectId,
          requestedPermissions: [
            WORKSPACE_RESOURCE_GRANT_PERMISSION.CONTACT_VISIBLE,
          ],
          requesterWorkspaceMemberId: requesterMemberId,
          status: WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS.PENDING,
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()

      await assert.rejects(
        () =>
          resolveWorkspaceResourceGrantRequest({
            workspaceId,
            workspaceResourceId: resourceA,
            requestId: request.id as string,
            approverWorkspaceMemberId: approverMemberId,
            decision: "approve",
            executor: db as any,
          }),
        /does not belong to this workspace resource/i
      )
    })
  }
)

test(
  "resolveWorkspaceResourceGrantRequest merges contact_visible into an existing active grant",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db)
      const workspaceId = await insertWorkspace(db, owner)
      const approverMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        owner
      )
      const requesterUser = await insertUser(db)
      const requesterMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        requesterUser
      )
      const resourceId = crypto.randomUUID()
      const approverSubject = await memberSubjectFor(db, approverMemberId)
      await db
        .insertInto("workspaceResources")
        .values({
          id: resourceId,
          workspaceId: workspaceId,
          kind: WORKSPACE_RESOURCE_KIND.ACTOR,
          displayName: "actor app",
          ownerSubjectId: approverSubject,
          createdBySubjectId: approverSubject,
          status: WORKSPACE_RESOURCE_STATUS.ACTIVE,
        } as any)
        .execute()
      await insertWorkspaceResourceDetail(db, {
        resourceId,
        workspaceId,
        kind: WORKSPACE_RESOURCE_KIND.ACTOR,
      })

      const requesterSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: requesterMemberId,
      })

      await db
        .insertInto("workspaceResourceGrants")
        .values({
          workspaceId: workspaceId,
          workspaceResourceId: resourceId,
          subjectId: requesterSubjectId,
          permissions: [WORKSPACE_RESOURCE_GRANT_PERMISSION.MANAGE],
          status: WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE,
          source: WORKSPACE_RESOURCE_GRANT_SOURCE.MANUAL,
          createdByWorkspaceMemberId: approverMemberId,
        } as any)
        .execute()

      const request = await db
        .insertInto("workspaceResourceGrantRequests")
        .values({
          workspaceId: workspaceId,
          workspaceResourceId: resourceId,
          granteeSubjectId: requesterSubjectId,
          requestedPermissions: [
            WORKSPACE_RESOURCE_GRANT_PERMISSION.CONTACT_VISIBLE,
          ],
          requesterWorkspaceMemberId: requesterMemberId,
          status: WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS.PENDING,
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()

      await resolveWorkspaceResourceGrantRequest({
        workspaceId,
        workspaceResourceId: resourceId,
        requestId: request.id as string,
        approverWorkspaceMemberId: approverMemberId,
        decision: "approve",
        executor: db as any,
      })

      const grants = await db
        .selectFrom("workspaceResourceGrants")
        .select(["id", "permissions"])
        .where("workspaceResourceId", "=", resourceId)
        .where("subjectId", "=", requesterSubjectId)
        .where("status", "=", WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE)
        .execute()

      assert.equal(grants.length, 1)
      const permissions = Array.isArray(grants[0]?.permissions)
        ? grants[0]!.permissions
        : String(grants[0]?.permissions || "")
            .replace(/^\{|\}$/g, "")
            .split(",")
            .filter(Boolean)
      assert.deepEqual(permissions, [
        WORKSPACE_RESOURCE_GRANT_PERMISSION.MANAGE,
        WORKSPACE_RESOURCE_GRANT_PERMISSION.CONTACT_VISIBLE,
      ])
    })
  }
)

test(
  "cancelWorkspaceResourceGrantRequest scopes the request id to the same workspace resource",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db)
      const workspaceId = await insertWorkspace(db, owner)
      const requesterMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        owner
      )
      const resourceA = crypto.randomUUID()
      const resourceB = crypto.randomUUID()
      const requesterSubject = await memberSubjectFor(db, requesterMemberId)

      for (const resourceId of [resourceA, resourceB]) {
        await db
          .insertInto("workspaceResources")
          .values({
            id: resourceId,
            workspaceId: workspaceId,
            kind: WORKSPACE_RESOURCE_KIND.ACTOR,
            displayName: `actor-${resourceId.slice(0, 6)}`,
            ownerSubjectId: requesterSubject,
            createdBySubjectId: requesterSubject,
            status: WORKSPACE_RESOURCE_STATUS.ACTIVE,
          } as any)
          .execute()
        await insertWorkspaceResourceDetail(db, {
          resourceId,
          workspaceId,
          kind: WORKSPACE_RESOURCE_KIND.ACTOR,
        })
      }

      const requesterSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: requesterMemberId,
      })
      const request = await db
        .insertInto("workspaceResourceGrantRequests")
        .values({
          workspaceId: workspaceId,
          workspaceResourceId: resourceB,
          granteeSubjectId: requesterSubjectId,
          requestedPermissions: [
            WORKSPACE_RESOURCE_GRANT_PERMISSION.CONTACT_VISIBLE,
          ],
          requesterWorkspaceMemberId: requesterMemberId,
          status: WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS.PENDING,
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()

      const cancelled = await cancelWorkspaceResourceGrantRequest(db as any, {
        workspaceId,
        workspaceResourceId: resourceA,
        requestId: request.id as string,
        requesterWorkspaceMemberId: requesterMemberId,
      })

      assert.equal(cancelled, false)

      const row = await db
        .selectFrom("workspaceResourceGrantRequests")
        .select("status")
        .where("id", "=", request.id as string)
        .executeTakeFirstOrThrow()
      assert.equal(row.status, WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS.PENDING)
    })
  }
)

test(
  "plugin_connections rejects a workspace_id that does not match its installation's workspace_resource root",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerA = await insertUser(db)
      const ownerB = await insertUser(db)
      const workspaceA = await insertWorkspace(db, ownerA)
      const workspaceB = await insertWorkspace(db, ownerB)
      const resourceId = crypto.randomUUID()

      await db
        .insertInto("workspaceResources")
        .values({
          id: resourceId,
          workspaceId: workspaceA,
          kind: WORKSPACE_RESOURCE_KIND.PLUGIN_INSTALLATION,
          displayName: "plugin app",
          createdBySubjectId: await creatorSubjectForWorkspace(db, workspaceA),
          status: WORKSPACE_RESOURCE_STATUS.ACTIVE,
        } as any)
        .execute()
      await insertWorkspaceResourceDetail(db, {
        resourceId,
        workspaceId: workspaceA,
        kind: WORKSPACE_RESOURCE_KIND.PLUGIN_INSTALLATION,
      })

      await assert.rejects(
        () =>
          (async () => {
            await db
              .insertInto("pluginConnections")
              .values({
                installationId: resourceId,
                workspaceId: workspaceB,
                bindingKey: "default",
                driver: "oauth2",
              } as any)
              .execute()
            await db.executeQuery(
              CompiledQuery.raw(
                "SET CONSTRAINTS fk_plugin_connections_workspace_resource_root IMMEDIATE"
              )
            )
          })(),
        /workspace_resource_root|workspace_resources|foreign key/i
      )
    })
  }
)
