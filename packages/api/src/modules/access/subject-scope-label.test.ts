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
      await db.insertInto("resource_access_bindings").values(unscoped).execute()

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
      await db.insertInto("resource_access_bindings").values(scoped).execute()

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
      await db.insertInto("resource_access_bindings").values(aValues).execute()
      // Must NOT collide with the prior insert.
      await db.insertInto("resource_access_bindings").values(bValues).execute()

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
        .selectFrom("resource_access_bindings")
        .select(["id", "subject_id"])
        .where("automation_event_source_id", "=", eventSourceId)
        .where("status", "=", "active")
        .execute()
      const subjectIds = rows.map((r) => r.subject_id as string).sort()
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
        .insertInto("resource_access_bindings")
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
        .insertInto("resource_access_bindings")
        .values(scopedValues)
        .execute()

      const rows = await db
        .selectFrom("resource_access_bindings as binding")
        .leftJoin(
          "access_subjects as scope_subj",
          "scope_subj.id",
          "binding.scope_subject_id"
        )
        .select([
          "binding.id as id",
          "binding.scope_subject_id as scope_subject_id",
          "scope_subj.conversation_id as scope_conversation_id",
        ])
        .where("binding.automation_event_source_id", "=", eventSourceId)
        .where("binding.status", "=", "active")
        .execute()
      assert.equal(rows.length, 2, "both unscoped and scoped rows must exist")
      const scopes = rows
        .map((r) => r.scope_conversation_id ?? null)
        .sort((a, b) => (a ?? "").localeCompare(b ?? ""))
      assert.deepEqual(
        scopes,
        [null, convId].sort((a, b) => (a ?? "").localeCompare(b ?? ""))
      )
    })
  }
)
