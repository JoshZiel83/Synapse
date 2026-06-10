import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import {
  SUBJECT_KIND,
  actorRef,
  conversationRef,
  remoteAgentRef,
  subjectScopeLabel,
  workspaceRef,
} from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import {
  buildAutomationEventSourceAccessBindingInsertValues,
  loadAutomationEventSourceAccessBindingRowsForSources,
} from "../access/binding-storage.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import {
  normalizeAutomationEventSourceAccessBindingRow,
  readAutomationEventSourceAccessBindingTarget,
} from "../access/bindings.js"

/**
 * Round 9 review (P2) regression tests for the remote_agent label
 * collapse. The bug: `subjectScopeLabel` returns "remote_agent" for a
 * remote_agent subject, but the RuntimeBindingScope union didn't
 * include it; skills + mcp-plugins service-layer dedup paths defaulted
 * to "workspace" and then either misidentified the existing binding
 * (silent collapse against an unrelated workspace grant) or missed the
 * existing remote_agent row entirely and tried to insert a duplicate,
 * tripping the resource_access_bindings unique constraint.
 *
 * These tests directly exercise the parts that broke:
 *   1. subjectScopeLabel returns the correct composite labels.
 *   2. readAutomationEventSourceAccessBindingTarget round-trips a remote_agent target
 *      stored in resource_access_bindings.
 *   3. Two remote_agent bindings for the same resource but different
 *      remote agents are distinct rows (no collapse) — verifies the
 *      DB unique constraint isn't accidentally tripped and the dedup
 *      key must include remote_agent_id.
 */

const NS = "scope-label"

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
      ownerId: user.id as string,
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
    .insertInto("workspaceApps")
    .values({
      id: actorId,
      workspaceId: wsId,
      kind: "actor",
      displayName: `${NS} actor`,
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("actors")
    .values({
      id: actorId,
      role: "assistant",
      title: `${NS} actor`,
      currentVersion: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function newRemoteAgent(db: Kysely<any>, wsId: string): Promise<string> {
  const remoteAgentId = crypto.randomUUID()
  const agentName = `agent-${rid()}`
  await db
    .insertInto("workspaceApps")
    .values({
      id: remoteAgentId,
      workspaceId: wsId,
      kind: "remote_agent",
      displayName: agentName,
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("remoteAgents")
    .values({
      id: remoteAgentId,
      title: `${NS} agent`,
      runtimeKind: "claude_code",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function newConversation(db: Kysely<any>, wsId: string): Promise<string> {
  const row = await db
    .insertInto("conversations")
    .values({
      kind: "group",
      workspaceId: wsId,
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
    .insertInto("workspaceMembers")
    .values({
      workspaceId: wsId,
      userId: user.id as string,
      trustLevel: "member",
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
    .insertInto("automationEventSources")
    .values({
      workspaceId: wsId,
      providerKind: "internal",
      sourceKey: `src-${rid()}`,
      name: "source",
      createdByKind: "workspace_member",
      createdByWorkspaceMemberId: memberId,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test("subjectScopeLabel emits subject kind independent of scope", () => {
  assert.equal(
    subjectScopeLabel({ subject: remoteAgentRef("ra-1") }),
    "remote_agent"
  )
  assert.equal(
    subjectScopeLabel({
      subject: remoteAgentRef("ra-1"),
      scope: conversationRef("c-1"),
    }),
    "remote_agent"
  )
  // Existing labels still emit their canonical form.
  assert.equal(subjectScopeLabel({ subject: actorRef("a-1") }), "actor")
  assert.equal(
    subjectScopeLabel({
      subject: actorRef("a-1"),
      scope: conversationRef("c-1"),
    }),
    "actor"
  )
  assert.equal(subjectScopeLabel({ subject: workspaceRef("w-1") }), "workspace")
})

test(
  "readAutomationEventSourceAccessBindingTarget round-trips remote_agent bindings",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const remoteAgentId = await newRemoteAgent(db, wsId)
      const eventSourceId = await newAutomationEventSource(db, wsId)

      // Unscoped remote_agent grant.
      const unscoped =
        await buildAutomationEventSourceAccessBindingInsertValues(db, {
          workspaceId: wsId,
          resourceType: "automation_event_source",
          resourceId: eventSourceId,
          target: { subject: remoteAgentRef(remoteAgentId) },
        })
      await db.insertInto("resourceAccessBindings").values(unscoped).execute()

      // Scoped remote_agent grant.
      const convId = await newConversation(db, wsId)
      const scoped = await buildAutomationEventSourceAccessBindingInsertValues(
        db,
        {
          workspaceId: wsId,
          resourceType: "automation_event_source",
          resourceId: eventSourceId,
          target: {
            subject: remoteAgentRef(remoteAgentId),
            scope: conversationRef(convId),
          },
        }
      )
      await db.insertInto("resourceAccessBindings").values(scoped).execute()

      const rows = await loadAutomationEventSourceAccessBindingRowsForSources(
        db,
        {
          resourceType: "automation_event_source",
          resourceIds: [eventSourceId],
        }
      )
      const decoded = rows.map((row) =>
        readAutomationEventSourceAccessBindingTarget(
          normalizeAutomationEventSourceAccessBindingRow(row as any) as any
        )
      )
      const labels = decoded.map((t) => subjectScopeLabel(t as any)).sort()
      assert.deepEqual(labels, ["remote_agent", "remote_agent"])
      assert.equal(
        decoded.filter((target) => target.scope?.kind === "conversation")
          .length,
        1
      )
      assert.equal(decoded.filter((target) => !target.scope).length, 1)
    })
  }
)

test(
  "two remote_agent bindings for different agents on the same resource don't collide",
  { timeout: 5 * 60_000 },
  async () => {
    // The resource_access_bindings unique index includes subject_id +
    // scope_subject_id (see schema.sql), so two distinct remote_agent
    // subject_ids must produce two distinct active rows. This test
    // locks in that contract — the service-layer dedup paths
    // (skills/service.ts, mcp-plugins/service.ts) must include
    // remote_agent_id in their dedup key to match.
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const remoteAgentA = await newRemoteAgent(db, wsId)
      const remoteAgentB = await newRemoteAgent(db, wsId)
      const eventSourceId = await newAutomationEventSource(db, wsId)

      const aValues = await buildAutomationEventSourceAccessBindingInsertValues(
        db,
        {
          workspaceId: wsId,
          resourceType: "automation_event_source",
          resourceId: eventSourceId,
          target: { subject: remoteAgentRef(remoteAgentA) },
        }
      )
      const bValues = await buildAutomationEventSourceAccessBindingInsertValues(
        db,
        {
          workspaceId: wsId,
          resourceType: "automation_event_source",
          resourceId: eventSourceId,
          target: { subject: remoteAgentRef(remoteAgentB) },
        }
      )
      await db.insertInto("resourceAccessBindings").values(aValues).execute()
      // Must NOT collide with the prior insert.
      await db.insertInto("resourceAccessBindings").values(bValues).execute()

      const subjA = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.REMOTE_AGENT,
        remoteAgentId: remoteAgentA,
      })
      const subjB = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.REMOTE_AGENT,
        remoteAgentId: remoteAgentB,
      })
      assert.notEqual(
        subjA,
        subjB,
        "distinct remote agents → distinct subject_ids"
      )

      const rows = await db
        .selectFrom("resourceAccessBindings")
        .select(["id", "subjectId"])
        .where("automationEventSourceId", "=", eventSourceId)
        .where("status", "=", "active")
        .execute()
      const subjectIds = rows.map((r) => r.subjectId as string).sort()
      assert.deepEqual(
        subjectIds,
        [subjA, subjB].sort(),
        "both remote_agent grants must persist as distinct rows"
      )
    })
  }
)

test(
  "ensureSkillBinding scoped-after-unscoped: a scoped grant must NOT collapse onto an existing unscoped one",
  { timeout: 5 * 60_000 },
  async () => {
    // Round-9 review service-level regression: when an unscoped (actor,
    // null) binding already exists and we add (actor, scope=conv), the
    // INSERT must succeed (a distinct row). This test inserts directly
    // via buildAutomationEventSourceAccessBindingInsertValues — the production
    // ensureSkillBinding in skills/service.ts gates the insert behind
    // findActiveAutomationEventSourceAccessBindingIdBySubject(scopeSubjectId) which
    // round-8 and round-9 fixed; this end-to-end test makes sure the
    // unique index respects the (subject, scope) pair.
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const grantedActor = await newActor(db, wsId)
      const eventSourceId = await newAutomationEventSource(db, wsId)
      const convId = await newConversation(db, wsId)

      const unscopedValues =
        await buildAutomationEventSourceAccessBindingInsertValues(db, {
          workspaceId: wsId,
          resourceType: "automation_event_source",
          resourceId: eventSourceId,
          target: { subject: actorRef(grantedActor) },
        })
      await db
        .insertInto("resourceAccessBindings")
        .values(unscopedValues)
        .execute()

      const scopedValues =
        await buildAutomationEventSourceAccessBindingInsertValues(db, {
          workspaceId: wsId,
          resourceType: "automation_event_source",
          resourceId: eventSourceId,
          target: {
            subject: actorRef(grantedActor),
            scope: conversationRef(convId),
          },
        })
      // Pre-round-8 fix this insert would have either silently
      // collapsed via the dedup query OR (without the dedup) succeeded
      // — depending on the path. With the unique index correctly
      // including scope_subject_id this insert must persist a distinct
      // row.
      await db
        .insertInto("resourceAccessBindings")
        .values(scopedValues)
        .execute()

      const rows = await db
        .selectFrom("resourceAccessBindings as binding")
        .leftJoin(
          "accessSubjects as scope_subj",
          "scope_subj.id",
          "binding.scopeSubjectId"
        )
        .select([
          "binding.id as id",
          "binding.scopeSubjectId as scopeSubjectId",
          "scope_subj.conversationId as scopeConversationId",
        ])
        .where("binding.automationEventSourceId", "=", eventSourceId)
        .where("binding.status", "=", "active")
        .execute()
      assert.equal(rows.length, 2, "both unscoped and scoped rows must exist")
      const scopes = rows
        .map((r) => r.scopeConversationId ?? null)
        .sort((a, b) => (a ?? "").localeCompare(b ?? ""))
      assert.deepEqual(
        scopes,
        [null, convId].sort((a, b) => (a ?? "").localeCompare(b ?? ""))
      )
    })
  }
)
