import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { MEMORY_PERMISSION, SUBJECT_KIND, actorRef } from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { buildRuntimePrincipalContext } from "../access/subject-resolution.js"
import {
  insertMemoryAccessGrant,
  listSpaceLevelGrantSpaceIds,
  memoryGrantMatches,
} from "./access-grant-storage.js"

/**
 * Regression suite for the second round of fixes on top of PR-fixes:
 *   - listSpaceLevelGrantSpaceIds does NOT include item-level grants
 *   - memoryGrantMatches space-only mode does NOT pick up item-level grants
 *   - buildRuntimePrincipalContext does NOT mint workspace subject for a
 *     platform-wide (`user`) principal
 *
 * The list/search/recall SQL widening (buildSearchFilters with
 * grantSpaceIds) is exercised indirectly: any item-only grant produces
 * no entry in listSpaceLevelGrantSpaceIds, so the SQL filter override
 * for granted spaces would not activate for item-level grants.
 */

const NS = "fixes2"

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
  await db
    .insertInto("workspace_apps")
    .values({
      id: actorId,
      workspace_id: wsId,
      kind: "actor",
      display_name: `${NS} actor`,
      status: "active",
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
  "listSpaceLevelGrantSpaceIds: returns space-level grants only — item grants excluded",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const ownerA = await newActor(db, wsId)
      const ownerB = await newActor(db, wsId)
      const grantee = await newActor(db, wsId)
      const spaceA = await newSpace(db, wsId, ownerA)
      const spaceB = await newSpace(db, wsId, ownerB)
      const itemB = await newItem(db, wsId, spaceB)

      // space-level grant on spaceA, item-level grant on itemB-in-spaceB.
      await insertMemoryAccessGrant(db, {
        workspaceId: wsId,
        memorySpaceId: spaceA,
        subject: actorRef(grantee),
        permissions: [MEMORY_PERMISSION.READ],
      })
      await insertMemoryAccessGrant(db, {
        workspaceId: wsId,
        memorySpaceId: spaceB,
        memoryItemId: itemB,
        subject: actorRef(grantee),
        permissions: [MEMORY_PERMISSION.READ],
      })

      const granteeSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: grantee,
      })

      const spaceIds = await listSpaceLevelGrantSpaceIds(db, {
        workspaceId: wsId,
        permission: MEMORY_PERMISSION.READ,
        runtimeSubjectIds: [granteeSubjectId],
        runtimeScopeSubjectIds: [],
      })
      assert.deepEqual(spaceIds.sort(), [spaceA].sort())
      assert.equal(
        spaceIds.includes(spaceB),
        false,
        "spaceB must NOT be in space-level result — only an item grant exists"
      )
    })
  }
)

test(
  "memoryGrantMatches(space-only): item-level grants are ignored even with matching item id",
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

      const granteeSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: grantee,
      })

      // space-only mode: item-level grant does NOT count
      const spaceOnly = await memoryGrantMatches(db, {
        memorySpaceId: space,
        permission: MEMORY_PERMISSION.READ,
        runtimeSubjectIds: [granteeSubjectId],
        runtimeScopeSubjectIds: [],
        mode: "space-only",
      })
      assert.equal(spaceOnly, false)

      // with-item mode at the matching item: item-level grant DOES count
      const withItem = await memoryGrantMatches(db, {
        memorySpaceId: space,
        memoryItemId: item,
        permission: MEMORY_PERMISSION.READ,
        runtimeSubjectIds: [granteeSubjectId],
        runtimeScopeSubjectIds: [],
        mode: "with-item",
      })
      assert.equal(withItem, true)
    })
  }
)

test(
  "buildRuntimePrincipalContext: user principal does NOT auto-mint workspace subject",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const userRow = await db
        .insertInto("users")
        .values({
          email: `u-${rid()}@${NS}`,
          name: "u",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const wsSubject = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId: wsId,
      })

      const ctx = await buildRuntimePrincipalContext(db, {
        principal: {
          kind: SUBJECT_KIND.USER,
          userId: userRow.id as string,
        },
        workspaceId: wsId,
      })
      assert.equal(
        ctx.runtimeSubjectIds.includes(wsSubject),
        false,
        "user principal must NOT pick up workspace subject — that would let any user match subject=workspace grants"
      )
      assert.equal(ctx.runtimeScopeSubjectIds.includes(wsSubject), false)
    })
  }
)
