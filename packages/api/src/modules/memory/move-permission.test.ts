import test from "node:test"
import assert from "node:assert/strict"
import { actorRef, workspaceMemberRef, type SubjectRef } from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { authorizePermission, type AccessSubject } from "../access/service.js"
import { buildRuntimePrincipalContext } from "../access/subject-resolution.js"
import { upsertAccessSubject } from "../access/subject-registry.js"

/**
 * Regression for the post-D4 round 5/6 move-endpoint fixes.
 *
 * Two attack/edge paths the route now closes:
 *
 *   1. **cleanup-only admin must not move private memory**
 *      A workspace admin holding `memory_admin` gets `delete` on
 *      private spaces via the cleanup adminManageOverride and `write`
 *      on workspace-owned target spaces via the workspace
 *      manage_memories branch. Before the round-6 fix the move
 *      endpoint authorized purely on (source delete + target write) —
 *      composing those two admin paths let admin relocate
 *      actor_private memory to workspace_shared and read it from the
 *      response. The fix adds source `read` as a prerequisite. This
 *      test exercises the evaluator gate that the controller's
 *      `requireMemoryPermission(memoryId, "read")` would consult.
 *
 *   2. **post-move read denied → response without contents**
 *      When the principal can write into the target but cannot read
 *      it (e.g. workspace_member curating their own user_private
 *      memory into another actor's private space as a curator), the
 *      move succeeds but the response must NOT leak the moved item's
 *      contents. The service-level move helper performs the relocation
 *      and the controller's post-move read check decides response
 *      shape — this test asserts the underlying authorize-by-runtime
 *      semantics the controller relies on (target read denied for the
 *      caller even though target write succeeded).
 */

const NS = "move-perm"

function rid(): string {
  return Math.random().toString(36).slice(2, 10)
}

async function newWorkspace(
  db: Kysely<any>
): Promise<{ wsId: string; ownerUserId: string }> {
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
  return { wsId: ws.id as string, ownerUserId: user.id as string }
}

async function newMember(
  db: Kysely<any>,
  wsId: string,
  opts?: { trustLevel?: "owner" | "admin" | "member" }
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
      trust_level: opts?.trustLevel ?? "member",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function grantActorAdmin(
  db: Kysely<any>,
  workspaceMemberId: string
): Promise<void> {
  await db
    .insertInto("workspace_access_bindings")
    .values({
      workspace_member_id: workspaceMemberId,
      access_key: "actor_admin",
    } as any)
    .execute()
}

async function grantMemoryAdmin(
  db: Kysely<any>,
  workspaceMemberId: string
): Promise<void> {
  await db
    .insertInto("workspace_access_bindings")
    .values({
      workspace_member_id: workspaceMemberId,
      access_key: "memory_admin",
    } as any)
    .execute()
}

async function newActor(db: Kysely<any>, wsId: string): Promise<string> {
  const row = await db
    .insertInto("actors")
    .values({
      workspace_id: wsId,
      name: `actor-${rid()}`,
      role: "assistant",
      title: `${NS} actor`,
      current_version: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function newPrivateSpace(
  db: Kysely<any>,
  wsId: string,
  owner: SubjectRef
): Promise<string> {
  const ownerSubjectId = await upsertAccessSubject(db as any, owner)
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
  "move: cleanup-only memory_admin cannot read actor_private memory (source-read gate)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { wsId } = await newWorkspace(db)
      // The actor whose memory we're trying to protect.
      const targetActor = await newActor(db, wsId)
      const actorSpace = await newPrivateSpace(db, wsId, actorRef(targetActor))
      const itemId = await newItem(db, wsId, actorSpace)

      // The would-be attacker: a workspace member with memory_admin
      // (cleanup) — NOT the actor, NOT the creator of the actor.
      const adminMember = await newMember(db, wsId)
      await grantMemoryAdmin(db, adminMember)

      const adminSubject: AccessSubject = {
        type: "workspace_member",
        id: adminMember,
      }
      const ctx = await buildRuntimePrincipalContext(db, {
        principal: workspaceMemberRef(adminMember),
        workspaceId: wsId,
      })

      // Admin DOES have delete (cleanup) on the source item — this is
      // the privilege that the round-6 fix recognized as insufficient
      // for move.
      const adminCanDelete = await authorizePermission(db, {
        subject: adminSubject,
        resourceType: "memory_item",
        resourceId: itemId,
        permission: "delete",
        runtimeSubjectIds: ctx.runtimeSubjectIds,
        runtimeScopeSubjectIds: ctx.runtimeScopeSubjectIds,
      })
      assert.equal(
        adminCanDelete,
        true,
        "memory_admin must retain cleanup-delete on actor_private items (DELETE endpoint still works)"
      )

      // ...but admin does NOT have read. The move endpoint now requires
      // source read FIRST — that's what blocks the "delete + write →
      // relocate + read" laundering chain.
      const adminCanRead = await authorizePermission(db, {
        subject: adminSubject,
        resourceType: "memory_item",
        resourceId: itemId,
        permission: "read",
        runtimeSubjectIds: ctx.runtimeSubjectIds,
        runtimeScopeSubjectIds: ctx.runtimeScopeSubjectIds,
      })
      assert.equal(
        adminCanRead,
        false,
        "memory_admin must NOT have read on actor_private memory — read isolation is the source-side gate"
      )
    })
  }
)

test(
  "move: target writable but not readable returns thin response (post-move read gate)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { wsId } = await newWorkspace(db)
      // Caller: a workspace member who is an `actor_admin` (the round-5
      // curation path requires admin / actor_admin / actor creator).
      // memory_admin alone is NOT the curation path — it only unlocks
      // cleanup manage/delete via adminManageOverride.
      const curator = await newMember(db, wsId)
      await grantActorAdmin(db, curator)

      // Source: caller's own workspace_member-owned space. Caller has
      // read + delete + write (owner-implicit).
      const sourceSpace = await newPrivateSpace(
        db,
        wsId,
        workspaceMemberRef(curator)
      )
      const sourceItemId = await newItem(db, wsId, sourceSpace)

      // Target: a different actor's actor_private space (already
      // existing here to avoid the controller's pre-resolve path —
      // we're asserting the authorize semantics the route relies on,
      // not exercising the move SQL).
      const targetActor = await newActor(db, wsId)
      const targetSpace = await newPrivateSpace(db, wsId, actorRef(targetActor))
      // Place a hypothetical item AT THE TARGET so we can ask "could
      // the caller read a member of this target after a move?" — same
      // shape as the post-move read check in the controller.
      const targetItemId = await newItem(db, wsId, targetSpace)

      const subject: AccessSubject = {
        type: "workspace_member",
        id: curator,
      }
      const ctx = await buildRuntimePrincipalContext(db, {
        principal: workspaceMemberRef(curator),
        workspaceId: wsId,
      })

      // Source side: caller can read + delete (owner). Move source-side
      // gate (round-6) requires both.
      const srcRead = await authorizePermission(db, {
        subject,
        resourceType: "memory_item",
        resourceId: sourceItemId,
        permission: "read",
        runtimeSubjectIds: ctx.runtimeSubjectIds,
        runtimeScopeSubjectIds: ctx.runtimeScopeSubjectIds,
      })
      const srcDelete = await authorizePermission(db, {
        subject,
        resourceType: "memory_item",
        resourceId: sourceItemId,
        permission: "delete",
        runtimeSubjectIds: ctx.runtimeSubjectIds,
        runtimeScopeSubjectIds: ctx.runtimeScopeSubjectIds,
      })
      assert.equal(
        srcRead,
        true,
        "owner reads their own workspace_member space"
      )
      assert.equal(
        srcDelete,
        true,
        "owner deletes their own workspace_member space"
      )

      // Target side: caller has write (via the round-5 curation path —
      // memory_admin can author seed content into an actor's private
      // space) but NOT read. moveMemoryToSpace's internal target-write
      // check would pass, BUT the controller's post-move read check
      // would then 200-with-thin-response.
      const targetWrite = await authorizePermission(db, {
        subject,
        resourceType: "memory_space",
        resourceId: targetSpace,
        permission: "write",
        runtimeSubjectIds: ctx.runtimeSubjectIds,
        runtimeScopeSubjectIds: ctx.runtimeScopeSubjectIds,
      })
      const targetRead = await authorizePermission(db, {
        subject,
        resourceType: "memory_item",
        resourceId: targetItemId,
        permission: "read",
        runtimeSubjectIds: ctx.runtimeSubjectIds,
        runtimeScopeSubjectIds: ctx.runtimeScopeSubjectIds,
      })
      assert.equal(
        targetWrite,
        true,
        "actor_admin gets write into actor_private via the round-5 canManage curation path"
      )
      assert.equal(
        targetRead,
        false,
        "actor_admin does NOT get read on actor_private — the post-move read gate flips the response to thin {id, spaceId, moved: true}"
      )
    })
  }
)
