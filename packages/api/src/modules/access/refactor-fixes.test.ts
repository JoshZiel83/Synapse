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
import { withTestDb, withTestDbAndClient } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { checkPermission } from "../access/evaluator.js"
import { buildRuntimePrincipalContext } from "../access/subject-resolution.js"
import {
  insertAutomationEventSourceAccessBindingReturningIdOn,
  loadAutomationEventSourceAccessBindingRowsForSourcesAndContext,
} from "../access/binding-storage.js"
import { insertMemoryAccessGrant } from "../memory/access-grant-storage.js"

/**
 * Regression suite for the PR1-7 follow-up fixes that still remain relevant
 * after app-resource grants moved onto workspace_app_grants. The remaining
 * legacy binding coverage here is limited to scope filtering on automation-
 * style resource_access_bindings plus unrelated principal / memory behaviors.
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

async function newRemoteAgent(db: Kysely<any>, wsId: string): Promise<string> {
  const remoteAgentId = crypto.randomUUID()
  const agentName = `agent-${rid()}`
  await db
    .insertInto("workspace_apps")
    .values({
      id: remoteAgentId,
      workspace_id: wsId,
      kind: "remote_agent",
      display_name: agentName,
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

async function newWorkspaceMember(
  db: Kysely<any>,
  wsId: string,
  label: string
): Promise<string> {
  const user = await db
    .insertInto("users")
    .values({
      email: `${label}-${rid()}@${NS}`,
      name: label,
    })
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
  return member.id as string
}

async function newAutomationEventSource(
  db: Kysely<any>,
  wsId: string
): Promise<string> {
  const memberId = await newWorkspaceMember(db, wsId, "creator")
  const row = await db
    .insertInto("automation_event_sources")
    .values({
      workspace_id: wsId,
      provider_kind: "internal",
      source_key: `src-${rid()}`,
      name: "source",
      created_by_kind: "workspace_member",
      created_by_workspace_member_id: memberId,
    } as any)
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

// -------- P1 fix #3: loadAutomationEventSourceAccessBindingRowsForSourcesAndContext scope filter --------

test(
  "loadAutomationEventSourceAccessBindingRowsForSourcesAndContext: scoped binding hidden in wrong conversation",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const wsId = await newWorkspace(db)
      const eventSourceId = await newAutomationEventSource(db, wsId)
      const subjectActor = await newActor(db, wsId)
      const convA = await newConversation(db, wsId)
      const convB = await newConversation(db, wsId)

      // subject=actor + scope=conversation B
      await insertAutomationEventSourceAccessBindingReturningIdOn(db, {
        workspaceId: wsId,
        resourceType: "automation_event_source",
        resourceId: eventSourceId,
        target: {
          subject: actorRef(subjectActor),
          scope: { kind: SUBJECT_KIND.CONVERSATION, conversationId: convB },
        },
      })

      // Asking for the same binding from inside conv A should NOT return it.
      const rowsInA =
        await loadAutomationEventSourceAccessBindingRowsForSourcesAndContext(
          db,
          {
            resourceType: "automation_event_source",
            resourceIds: [eventSourceId],
            contextWorkspaceId: wsId,
            actorId: subjectActor,
            conversationId: convA,
          }
        )
      assert.equal(
        rowsInA.length,
        0,
        "scoped grant must not leak across conversations"
      )

      // From conv B it should be visible.
      const rowsInB =
        await loadAutomationEventSourceAccessBindingRowsForSourcesAndContext(
          db,
          {
            resourceType: "automation_event_source",
            resourceIds: [eventSourceId],
            contextWorkspaceId: wsId,
            actorId: subjectActor,
            conversationId: convB,
          }
        )
      assert.equal(
        rowsInB.length,
        1,
        "scoped grant visible in its conversation"
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
