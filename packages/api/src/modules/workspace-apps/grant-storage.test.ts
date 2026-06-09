import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { CompiledQuery } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import {
  WORKSPACE_APP_GRANT_PERMISSION,
  WORKSPACE_APP_GRANT_REQUEST_STATUS,
  WORKSPACE_APP_GRANT_SOURCE,
  WORKSPACE_APP_GRANT_STATUS,
  WORKSPACE_APP_KIND,
  WORKSPACE_APP_STATUS,
  SUBJECT_KIND,
} from "@synapse/shared"
import { upsertAccessSubject } from "../access/subject-registry.js"
import {
  cancelWorkspaceAppGrantRequest,
  resolveWorkspaceAppGrantRequest,
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
      owner_id: ownerId,
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

async function insertSkillSnapshot(db: AnyDb) {
  const row = await db
    .insertInto("skill_snapshots")
    .values({
      name: "test skill",
      description: "test",
      content_hash: `hash-${crypto.randomUUID()}`,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertWorkspaceAppDetail(
  db: AnyDb,
  input: {
    appId: string
    workspaceId: string
    kind: (typeof WORKSPACE_APP_KIND)[keyof typeof WORKSPACE_APP_KIND]
  }
) {
  switch (input.kind) {
    case WORKSPACE_APP_KIND.ACTOR:
      await db
        .insertInto("actors")
        .values({
          id: input.appId,
          role: "assistant",
          title: "actor detail",
          current_version: 1,
        } as any)
        .execute()
      return
    case WORKSPACE_APP_KIND.INSTALLED_SKILL: {
      const snapshotId = await insertSkillSnapshot(db)
      await db
        .insertInto("installed_skills")
        .values({
          id: input.appId,
          current_snapshot_id: snapshotId,
          current_version: 1,
        } as any)
        .execute()
      return
    }
    case WORKSPACE_APP_KIND.PLUGIN_INSTALLATION: {
      const publisher = await db
        .insertInto("publishers")
        .values({
          slug: `pub-${crypto.randomUUID().slice(0, 8)}`,
          display_name: "test publisher",
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      const item = await db
        .insertInto("catalog_items")
        .values({
          publisher_id: publisher.id,
          item_kind: "plugin_package",
          slug: `plugin-${crypto.randomUUID().slice(0, 8)}`,
          display_name: "test plugin",
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      const version = await db
        .insertInto("catalog_versions")
        .values({
          catalog_item_id: item.id,
          version: "1.0.0",
          status: "active",
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      await db
        .insertInto("plugin_installations")
        .values({
          id: input.appId,
          catalog_item_id: item.id,
          catalog_version_id: version.id,
          attachment_scope_subject_id: null,
        } as any)
        .execute()
      return
    }
    default:
      throw new Error(
        `unsupported workspace app detail kind for test: ${input.kind}`
      )
  }
}

test(
  "workspace_apps rejects an owner_workspace_member_id from another workspace",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerA = await insertUser(db)
      const ownerB = await insertUser(db)
      const workspaceA = await insertWorkspace(db, ownerA)
      const workspaceB = await insertWorkspace(db, ownerB)
      const memberB = await insertWorkspaceMember(db, workspaceB, ownerB)

      await assert.rejects(
        () =>
          db
            .insertInto("workspace_apps")
            .values({
              id: crypto.randomUUID(),
              workspace_id: workspaceA,
              kind: WORKSPACE_APP_KIND.ACTOR,
              display_name: "bad owner",
              owner_workspace_member_id: memberB,
              status: WORKSPACE_APP_STATUS.ACTIVE,
            } as any)
            .execute(),
        /owner_workspace_member_id/i
      )
    })
  }
)

test(
  "workspace_apps requires exactly one matching detail row before transaction commit",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db)
      const workspaceId = await insertWorkspace(db, owner)

      await assert.rejects(
        () =>
          (async () => {
            await db
              .insertInto("workspace_apps")
              .values({
                id: crypto.randomUUID(),
                workspace_id: workspaceId,
                kind: WORKSPACE_APP_KIND.ACTOR,
                display_name: "missing detail",
                status: WORKSPACE_APP_STATUS.ACTIVE,
              } as any)
              .execute()
            await db.executeQuery(
              CompiledQuery.raw(
                "SET CONSTRAINTS workspace_apps_detail_consistency_root_chk IMMEDIATE"
              )
            )
          })(),
        /exactly one matching detail row/i
      )
    })
  }
)

test(
  "workspace_apps rejects a detail row whose table does not match workspace_apps.kind",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db)
      const workspaceId = await insertWorkspace(db, owner)
      const appId = crypto.randomUUID()

      await assert.rejects(
        () =>
          (async () => {
            await db
              .insertInto("workspace_apps")
              .values({
                id: appId,
                workspace_id: workspaceId,
                kind: WORKSPACE_APP_KIND.ACTOR,
                display_name: "wrong detail kind",
                status: WORKSPACE_APP_STATUS.ACTIVE,
              } as any)
              .execute()

            const snapshotId = await insertSkillSnapshot(db)
            await db
              .insertInto("installed_skills")
              .values({
                id: appId,
                current_snapshot_id: snapshotId,
                current_version: 1,
              } as any)
              .execute()
            await db.executeQuery(
              CompiledQuery.raw(
                "SET CONSTRAINTS workspace_apps_detail_consistency_root_chk IMMEDIATE"
              )
            )
          })(),
        /kind=actor is missing its actor detail row|exactly one matching detail row/i
      )
    })
  }
)

test(
  "workspace_app_grants rejects contact_visible on a non-contact app kind",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db)
      const workspaceId = await insertWorkspace(db, owner)
      const memberId = await insertWorkspaceMember(db, workspaceId, owner)
      const appId = crypto.randomUUID()
      await db
        .insertInto("workspace_apps")
        .values({
          id: appId,
          workspace_id: workspaceId,
          kind: WORKSPACE_APP_KIND.INSTALLED_SKILL,
          display_name: "skill app",
          owner_workspace_member_id: memberId,
          status: WORKSPACE_APP_STATUS.ACTIVE,
        } as any)
        .execute()
      await insertWorkspaceAppDetail(db, {
        appId,
        workspaceId,
        kind: WORKSPACE_APP_KIND.INSTALLED_SKILL,
      })
      const memberSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId,
      })

      await assert.rejects(
        () =>
          db
            .insertInto("workspace_app_grants")
            .values({
              workspace_id: workspaceId,
              workspace_app_id: appId,
              subject_id: memberSubjectId,
              permissions: [WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE],
              status: WORKSPACE_APP_GRANT_STATUS.ACTIVE,
              source: WORKSPACE_APP_GRANT_SOURCE.MANUAL,
            } as any)
            .execute(),
        /contact_visible/i
      )
    })
  }
)

test(
  "workspace_app_grant_requests only allow self workspace_member contact-visible requests for actor/remote_agent apps",
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
      const appId = crypto.randomUUID()
      await db
        .insertInto("workspace_apps")
        .values({
          id: appId,
          workspace_id: workspaceId,
          kind: WORKSPACE_APP_KIND.ACTOR,
          display_name: "actor app",
          status: WORKSPACE_APP_STATUS.ACTIVE,
        } as any)
        .execute()
      await insertWorkspaceAppDetail(db, {
        appId,
        workspaceId,
        kind: WORKSPACE_APP_KIND.ACTOR,
      })
      const otherMemberSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: otherMemberId,
      })

      await assert.rejects(
        () =>
          db
            .insertInto("workspace_app_grant_requests")
            .values({
              workspace_id: workspaceId,
              workspace_app_id: appId,
              grantee_subject_id: otherMemberSubjectId,
              requested_permissions: [
                WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE,
              ],
              requester_workspace_member_id: requesterMemberId,
              status: WORKSPACE_APP_GRANT_REQUEST_STATUS.PENDING,
            } as any)
            .execute(),
        /requester must request on behalf of their own workspace_member subject/i
      )
    })
  }
)

test(
  "resolveWorkspaceAppGrantRequest rejects a request id routed through another workspace app",
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
      const appA = crypto.randomUUID()
      const appB = crypto.randomUUID()

      for (const appId of [appA, appB]) {
        await db
          .insertInto("workspace_apps")
          .values({
            id: appId,
            workspace_id: workspaceId,
            kind: WORKSPACE_APP_KIND.ACTOR,
            display_name: `actor-${appId.slice(0, 6)}`,
            owner_workspace_member_id: approverMemberId,
            status: WORKSPACE_APP_STATUS.ACTIVE,
          } as any)
          .execute()
        await insertWorkspaceAppDetail(db, {
          appId,
          workspaceId,
          kind: WORKSPACE_APP_KIND.ACTOR,
        })
      }

      const requesterSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: requesterMemberId,
      })
      const request = await db
        .insertInto("workspace_app_grant_requests")
        .values({
          workspace_id: workspaceId,
          workspace_app_id: appB,
          grantee_subject_id: requesterSubjectId,
          requested_permissions: [
            WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE,
          ],
          requester_workspace_member_id: requesterMemberId,
          status: WORKSPACE_APP_GRANT_REQUEST_STATUS.PENDING,
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()

      await assert.rejects(
        () =>
          resolveWorkspaceAppGrantRequest({
            workspaceId,
            workspaceAppId: appA,
            requestId: request.id as string,
            approverWorkspaceMemberId: approverMemberId,
            decision: "approve",
            executor: db as any,
          }),
        /does not belong to this app/i
      )
    })
  }
)

test(
  "resolveWorkspaceAppGrantRequest merges contact_visible into an existing active grant",
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
      const appId = crypto.randomUUID()
      await db
        .insertInto("workspace_apps")
        .values({
          id: appId,
          workspace_id: workspaceId,
          kind: WORKSPACE_APP_KIND.ACTOR,
          display_name: "actor app",
          owner_workspace_member_id: approverMemberId,
          status: WORKSPACE_APP_STATUS.ACTIVE,
        } as any)
        .execute()
      await insertWorkspaceAppDetail(db, {
        appId,
        workspaceId,
        kind: WORKSPACE_APP_KIND.ACTOR,
      })

      const requesterSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: requesterMemberId,
      })

      await db
        .insertInto("workspace_app_grants")
        .values({
          workspace_id: workspaceId,
          workspace_app_id: appId,
          subject_id: requesterSubjectId,
          permissions: [WORKSPACE_APP_GRANT_PERMISSION.MANAGE],
          status: WORKSPACE_APP_GRANT_STATUS.ACTIVE,
          source: WORKSPACE_APP_GRANT_SOURCE.MANUAL,
          created_by_workspace_member_id: approverMemberId,
        } as any)
        .execute()

      const request = await db
        .insertInto("workspace_app_grant_requests")
        .values({
          workspace_id: workspaceId,
          workspace_app_id: appId,
          grantee_subject_id: requesterSubjectId,
          requested_permissions: [
            WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE,
          ],
          requester_workspace_member_id: requesterMemberId,
          status: WORKSPACE_APP_GRANT_REQUEST_STATUS.PENDING,
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()

      await resolveWorkspaceAppGrantRequest({
        workspaceId,
        workspaceAppId: appId,
        requestId: request.id as string,
        approverWorkspaceMemberId: approverMemberId,
        decision: "approve",
        executor: db as any,
      })

      const grants = await db
        .selectFrom("workspace_app_grants")
        .select(["id", "permissions"])
        .where("workspace_app_id", "=", appId)
        .where("subject_id", "=", requesterSubjectId)
        .where("status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
        .execute()

      assert.equal(grants.length, 1)
      const permissions = Array.isArray(grants[0]?.permissions)
        ? grants[0]!.permissions
        : String(grants[0]?.permissions || "")
            .replace(/^\{|\}$/g, "")
            .split(",")
            .filter(Boolean)
      assert.deepEqual(permissions, [
        WORKSPACE_APP_GRANT_PERMISSION.MANAGE,
        WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE,
      ])
    })
  }
)

test(
  "cancelWorkspaceAppGrantRequest scopes the request id to the same workspace app",
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
      const appA = crypto.randomUUID()
      const appB = crypto.randomUUID()

      for (const appId of [appA, appB]) {
        await db
          .insertInto("workspace_apps")
          .values({
            id: appId,
            workspace_id: workspaceId,
            kind: WORKSPACE_APP_KIND.ACTOR,
            display_name: `actor-${appId.slice(0, 6)}`,
            owner_workspace_member_id: requesterMemberId,
            status: WORKSPACE_APP_STATUS.ACTIVE,
          } as any)
          .execute()
        await insertWorkspaceAppDetail(db, {
          appId,
          workspaceId,
          kind: WORKSPACE_APP_KIND.ACTOR,
        })
      }

      const requesterSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: requesterMemberId,
      })
      const request = await db
        .insertInto("workspace_app_grant_requests")
        .values({
          workspace_id: workspaceId,
          workspace_app_id: appB,
          grantee_subject_id: requesterSubjectId,
          requested_permissions: [
            WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE,
          ],
          requester_workspace_member_id: requesterMemberId,
          status: WORKSPACE_APP_GRANT_REQUEST_STATUS.PENDING,
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()

      const cancelled = await cancelWorkspaceAppGrantRequest(db as any, {
        workspaceId,
        workspaceAppId: appA,
        requestId: request.id as string,
        requesterWorkspaceMemberId: requesterMemberId,
      })

      assert.equal(cancelled, false)

      const row = await db
        .selectFrom("workspace_app_grant_requests")
        .select("status")
        .where("id", "=", request.id as string)
        .executeTakeFirstOrThrow()
      assert.equal(row.status, WORKSPACE_APP_GRANT_REQUEST_STATUS.PENDING)
    })
  }
)

test(
  "plugin_connections rejects a workspace_id that does not match its installation's workspace_app root",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerA = await insertUser(db)
      const ownerB = await insertUser(db)
      const workspaceA = await insertWorkspace(db, ownerA)
      const workspaceB = await insertWorkspace(db, ownerB)
      const appId = crypto.randomUUID()

      await db
        .insertInto("workspace_apps")
        .values({
          id: appId,
          workspace_id: workspaceA,
          kind: WORKSPACE_APP_KIND.PLUGIN_INSTALLATION,
          display_name: "plugin app",
          status: WORKSPACE_APP_STATUS.ACTIVE,
        } as any)
        .execute()
      await insertWorkspaceAppDetail(db, {
        appId,
        workspaceId: workspaceA,
        kind: WORKSPACE_APP_KIND.PLUGIN_INSTALLATION,
      })

      await assert.rejects(
        () =>
          (async () => {
            await db
              .insertInto("plugin_connections")
              .values({
                installation_id: appId,
                workspace_id: workspaceB,
                binding_key: "default",
                driver: "oauth2",
              } as any)
              .execute()
            await db.executeQuery(
              CompiledQuery.raw(
                "SET CONSTRAINTS fk_plugin_connections_workspace_app_root IMMEDIATE"
              )
            )
          })(),
        /workspace_app_root|workspace_apps|foreign key/i
      )
    })
  }
)
