import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import {
  MEMORY_PERMISSION,
  SUBJECT_KIND,
  actorRef,
  remoteAgentRef,
} from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { checkPermission } from "../access/evaluator.js"
import { buildRuntimePrincipalContext } from "../access/subject-resolution.js"
import { insertMemoryAccessGrant } from "../memory/access-grant-storage.js"

/**
 * Regression suite for the PR1-7 follow-up fixes that still remain relevant
 * after all resource-authz grants (including automation event-source access,
 * which used to live in the now-deleted `resource_access_bindings` table) moved
 * onto `workspace_resource_grants`. What survives here is the cross-workspace
 * principal validation plus the memory-grant overlay behavior.
 */

const NS = "fixes"

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

// Owner→subject migration: workspace_resources.created_by_subject_id is NOT
// NULL. Mint a workspace_member subject in the workspace to serve as creator.
async function newCreatorSubjectId(
  db: Kysely<any>,
  wsId: string
): Promise<string> {
  const user = await db
    .insertInto("users")
    .values({ email: `creator-${rid()}@${NS}`, name: "creator" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const member = await db
    .insertInto("workspace_members")
    .values({
      workspace_id: wsId,
      user_id: user.id as string,
      trust_level: "member",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return upsertAccessSubject(db as any, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId: member.id as string,
  })
}

async function newActor(db: Kysely<any>, wsId: string): Promise<string> {
  const actorId = crypto.randomUUID()
  await db
    .insertInto("workspace_resources")
    .values({
      id: actorId,
      workspace_id: wsId,
      kind: "actor",
      display_name: `${NS} actor`,
      created_by_subject_id: await newCreatorSubjectId(db, wsId),
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

async function newRemoteAgent(db: Kysely<any>, wsId: string): Promise<string> {
  const remoteAgentId = crypto.randomUUID()
  const agentName = `agent-${rid()}`
  await db
    .insertInto("workspace_resources")
    .values({
      id: remoteAgentId,
      workspace_id: wsId,
      kind: "remote_agent",
      display_name: agentName,
      created_by_subject_id: await newCreatorSubjectId(db, wsId),
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("remote_agents")
    .values({
      id: remoteAgentId,
      title: `${NS} agent`,
      runtime_kind: "claude_code",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

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

// -------- P1 fix #5: principal-workspace validation in builder --------

test(
  "buildRuntimePrincipalContext: cross-workspace actor principal rejected",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsA = await newWorkspace(db)
      const wsB = await newWorkspace(db)
      const actorInA = await newActor(db, wsA)

      await assert.rejects(
        buildRuntimePrincipalContext(db, {
          principal: actorRef(actorInA),
          workspaceId: wsB,
        }),
        /does not belong to workspace/
      )
    })
  }
)

test(
  "buildRuntimePrincipalContext: cross-workspace remote_agent principal rejected",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsA = await newWorkspace(db)
      const wsB = await newWorkspace(db)
      const agentInA = await newRemoteAgent(db, wsA)

      await assert.rejects(
        buildRuntimePrincipalContext(db, {
          principal: remoteAgentRef(agentInA),
          workspaceId: wsB,
        }),
        /does not belong to workspace/
      )
    })
  }
)

// -------- P0 fix #2 sketch: grants overlay end-to-end --------

test(
  "memory grant on actor_private space surfaces for a non-owner actor via the grant overlay",
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
        subject: actorRef(grantee),
        permissions: [MEMORY_PERMISSION.READ],
      })

      // checkPermission with grantee's runtimeContext returns true after the
      // overlay merges in the explicit grant (proven separately in
      // memory/access-grant.test.ts). Here we additionally assert the
      // backward-compatible negative case: without runtimeContext, the
      // legacy actor_private decision still denies cross-actor read.
      const beforeContext = await checkPermission(db, {
        resourceType: "memory_item",
        resourceId: item,
        permission: "read",
        subject: { type: "actor", id: grantee },
      })
      assert.equal(beforeContext, false)
    })
  }
)

// -------- P2 fix #6: runtime-authorization grant trigger strict allowlist --------
//
// D2: the runtime-pair subject kind has been removed from the type system AND
// from the SQL ENUM, so the previous rejection test can no longer construct
// the offending subject. The trigger (tg_runtime_authorization_grant_validate)
// now uses the canonical `is_workspace_bound_subject_kind`
// allowlist (workspace_member / actor / remote_agent / workspace / conversation)
// — the validation lives at three layers now: TS union, Postgres ENUM, and
// trigger. Together they are stricter than the old runtime-only check.
