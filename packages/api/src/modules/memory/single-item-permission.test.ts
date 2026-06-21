import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { MEMORY_PERMISSION, SUBJECT_KIND, actorRef } from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { authorizePermission, type AccessSubject } from "../access/service.js"
import { buildRuntimePrincipalContext } from "../access/subject-resolution.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { insertMemoryAccessGrant } from "./access-grant-storage.js"

/**
 * Regression for round 3: a `memory.read/edit/delete` grant on item X must
 * make `authorizePermission(memory_item, X, read)` return true when called
 * with the grantee's runtime context — covering the GET/PUT/DELETE
 * /:memoryId REST routes that used to call `authorizePermission` without
 * a runtime context.
 */

const NS = "fixes3"

function rid(): string {
  return Math.random().toString(36).slice(2, 10)
}

async function newWorkspace(db: Kysely<any>): Promise<string> {
  const user = await db
    .insertInto("users")
    .values({
      email: `${rid()}@${NS}`,
      name: "owner",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({
      owner_id: user.id as string,
      slug: `ws-${rid()}`,
      name: `${NS} ws`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return ws.id as string
}

async function newActor(db: Kysely<any>, wsId: string): Promise<string> {
  const actorId = crypto.randomUUID()
  // workspace_resources.created_by_subject_id is NOT NULL; mint (idempotently —
  // one per workspace) a workspace-kind creator subject.
  const createdBySubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE,
    workspaceId: wsId,
  })
  await db
    .insertInto("workspace_resources")
    .values({
      id: actorId,
      workspace_id: wsId,
      kind: "actor",
      display_name: `${NS} actor`,
      status: "active",
      created_by_subject_id: createdBySubjectId,
    } as any)
    .execute()
  const row = await db
    .insertInto("actors")
    .values({
      id: actorId,
      role: "assistant",
      title: `${NS} actor`,
      current_version: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function newSpace(
  db: Kysely<any>,
  wsId: string,
  actorId: string
): Promise<string> {
  const ownerSubjectId = await upsertAccessSubject(db as any, {
    kind: SUBJECT_KIND.ACTOR,
    actorId,
  })
  const row = await db
    .insertInto("memory_spaces")
    .values({
      workspace_id: wsId,
      owner_subject_id: ownerSubjectId,
      namespace_key: "default",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function newItem(
  db: Kysely<any>,
  wsId: string,
  spaceId: string
): Promise<string> {
  const row = await db
    .insertInto("memory_items")
    .values({
      workspace_id: wsId,
      memory_space_id: spaceId,
      category: "fact",
      text_digest: "x",
      search_text: "x",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test(
  "authorizePermission(memory_item) with runtimeContext picks up item-level grant",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const owner = await newActor(db, wsId)
      const grantee = await newActor(db, wsId)
      const space = await newSpace(db, wsId, owner)
      const item = await newItem(db, wsId, space)

      await insertMemoryAccessGrant(db, {
        workspaceId: wsId,
        memorySpaceId: space,
        memoryItemId: item,
        subject: actorRef(grantee),
        permissions: [MEMORY_PERMISSION.READ],
      })

      const subject: AccessSubject = { type: "actor", id: grantee }

      // Without runtime context: 403 (the actor_private isolation kicks in,
      // explicit item-level grant is invisible to the evaluator overlay
      // because it has no runtimeSubjectIds to match against).
      const bareCheck = await authorizePermission(db, {
        subject,
        resourceType: "memory_item",
        resourceId: item,
        permission: "read",
      })
      assert.equal(
        bareCheck,
        false,
        "without runtime context the actor_private isolation must still deny"
      )

      // With runtime context (the REST routes now build this): the explicit
      // grant overlay accepts.
      const ctx = await buildRuntimePrincipalContext(db, {
        principal: actorRef(grantee),
        workspaceId: wsId,
      })
      const grantedCheck = await authorizePermission(db, {
        subject,
        resourceType: "memory_item",
        resourceId: item,
        permission: "read",
        runtimeSubjectIds: ctx.runtimeSubjectIds,
        runtimeScopeSubjectIds: ctx.runtimeScopeSubjectIds,
      })
      assert.equal(
        grantedCheck,
        true,
        "with runtime context the explicit item-level grant must accept"
      )
    })
  }
)

/**
 * P1 fix regression: `owner=workspace, scope=conversation C` memory must NOT
 * leak to a workspace member who is outside conversation C. Pre-fix the
 * workspace-owner branch in hasMemorySpaceOwnerImplicitPermission ignored
 * scope_subject_id and let anyone with workspace `view` read it.
 */
async function newConversation(db: Kysely<any>, wsId: string): Promise<string> {
  const row = await db
    .insertInto("conversations")
    .values({
      kind: "group",
      workspace_id: wsId,
      title: `${NS} conv`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function newWorkspaceMember(
  db: Kysely<any>,
  wsId: string
): Promise<string> {
  const user = await db
    .insertInto("users")
    .values({
      email: `${rid()}@${NS}`,
      name: "member",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const row = await db
    .insertInto("workspace_members")
    .values({
      workspace_id: wsId,
      user_id: user.id as string,
      trust_level: "member",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function newWorkspaceOwnedConversationScopedSpace(
  db: Kysely<any>,
  wsId: string,
  conversationId: string
): Promise<string> {
  const ownerSubjectId = await upsertAccessSubject(db as any, {
    kind: SUBJECT_KIND.WORKSPACE,
    workspaceId: wsId,
  })
  const scopeSubjectId = await upsertAccessSubject(db as any, {
    kind: SUBJECT_KIND.CONVERSATION,
    conversationId,
  })
  const row = await db
    .insertInto("memory_spaces")
    .values({
      workspace_id: wsId,
      owner_subject_id: ownerSubjectId,
      scope_subject_id: scopeSubjectId,
      namespace_key: "default",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test(
  "owner=workspace, scope=conversation C: workspace member outside C cannot read",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const conv = await newConversation(db, wsId)
      const outsider = await newWorkspaceMember(db, wsId)
      const space = await newWorkspaceOwnedConversationScopedSpace(
        db,
        wsId,
        conv
      )
      const item = await newItem(db, wsId, space)

      const subject: AccessSubject = { type: "workspace_member", id: outsider }
      // Build a runtime context that does NOT include the conversation
      // (outsider is not an active participant).
      const ctx = await buildRuntimePrincipalContext(db, {
        principal: {
          kind: SUBJECT_KIND.WORKSPACE_MEMBER,
          workspaceMemberId: outsider,
        },
        workspaceId: wsId,
        conversationId: conv,
      })

      const allowed = await authorizePermission(db, {
        subject,
        resourceType: "memory_item",
        resourceId: item,
        permission: "read",
        runtimeSubjectIds: ctx.runtimeSubjectIds,
        runtimeScopeSubjectIds: ctx.runtimeScopeSubjectIds,
      })
      assert.equal(
        allowed,
        false,
        "workspace member outside the scope conversation must NOT read scoped workspace-owned memory"
      )
    })
  }
)
