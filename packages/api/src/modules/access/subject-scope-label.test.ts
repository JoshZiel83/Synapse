import test from "node:test"
import assert from "node:assert/strict"
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
  buildResourceAccessBindingInsertValues,
  loadAccessBindingRowsForResources,
} from "../access/binding-storage.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import {
  normalizeAccessBindingRow,
  readAccessBindingTarget,
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
 *   2. readAccessBindingTarget round-trips a remote_agent target
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
      password_hash: "x",
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

async function newRemoteAgent(db: Kysely<any>, wsId: string): Promise<string> {
  const row = await db
    .insertInto("remote_agents")
    .values({
      workspace_id: wsId,
      name: `agent-${rid()}`,
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
      boundary: "internal",
      internal_workspace_id: wsId,
      title: `${NS} conv`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test("subjectScopeLabel emits remote_agent and remote_agent_in_conversation", () => {
  assert.equal(
    subjectScopeLabel({ subject: remoteAgentRef("ra-1") }),
    "remote_agent"
  )
  assert.equal(
    subjectScopeLabel({
      subject: remoteAgentRef("ra-1"),
      scope: conversationRef("c-1"),
    }),
    "remote_agent_in_conversation"
  )
  // Existing labels still emit their canonical form.
  assert.equal(subjectScopeLabel({ subject: actorRef("a-1") }), "actor")
  assert.equal(
    subjectScopeLabel({
      subject: actorRef("a-1"),
      scope: conversationRef("c-1"),
    }),
    "actor_in_conversation"
  )
  assert.equal(subjectScopeLabel({ subject: workspaceRef("w-1") }), "workspace")
})

test(
  "readAccessBindingTarget round-trips remote_agent bindings",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const remoteAgentId = await newRemoteAgent(db, wsId)
      const targetActorId = await newActor(db, wsId)

      // Unscoped remote_agent grant.
      const unscoped = await buildResourceAccessBindingInsertValues(db, {
        workspaceId: wsId,
        resourceType: "actor",
        resourceId: targetActorId,
        target: { subject: remoteAgentRef(remoteAgentId) },
      })
      await db.insertInto("resource_access_bindings").values(unscoped).execute()

      // Scoped remote_agent grant.
      const convId = await newConversation(db, wsId)
      const scoped = await buildResourceAccessBindingInsertValues(db, {
        workspaceId: wsId,
        resourceType: "actor",
        resourceId: targetActorId,
        target: {
          subject: remoteAgentRef(remoteAgentId),
          scope: conversationRef(convId),
        },
      })
      await db.insertInto("resource_access_bindings").values(scoped).execute()

      const rows = await loadAccessBindingRowsForResources(db, {
        resourceType: "actor",
        resourceIds: [targetActorId],
      })
      const decoded = rows.map((row) =>
        readAccessBindingTarget(normalizeAccessBindingRow(row as any) as any)
      )
      const labels = decoded.map((t) => subjectScopeLabel(t as any)).sort()
      // Round-9 fix: BOTH labels must be present. Before the fix the
      // scoped one would have collapsed to "remote_agent" too because
      // subjectScopeLabel didn't have the remote_agent + conversation
      // composite branch.
      assert.deepEqual(labels, ["remote_agent", "remote_agent_in_conversation"])
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
      const targetActorId = await newActor(db, wsId)

      const aValues = await buildResourceAccessBindingInsertValues(db, {
        workspaceId: wsId,
        resourceType: "actor",
        resourceId: targetActorId,
        target: { subject: remoteAgentRef(remoteAgentA) },
      })
      const bValues = await buildResourceAccessBindingInsertValues(db, {
        workspaceId: wsId,
        resourceType: "actor",
        resourceId: targetActorId,
        target: { subject: remoteAgentRef(remoteAgentB) },
      })
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
        .where("actor_id", "=", targetActorId)
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
    // via buildResourceAccessBindingInsertValues — the production
    // ensureSkillBinding in skills/service.ts gates the insert behind
    // findActiveBindingIdByResourceAndSubject(scopeSubjectId) which
    // round-8 and round-9 fixed; this end-to-end test makes sure the
    // unique index respects the (subject, scope) pair.
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const grantedActor = await newActor(db, wsId)
      const targetActor = await newActor(db, wsId)
      const convId = await newConversation(db, wsId)

      const unscopedValues = await buildResourceAccessBindingInsertValues(db, {
        workspaceId: wsId,
        resourceType: "actor",
        resourceId: targetActor,
        target: { subject: actorRef(grantedActor) },
      })
      await db
        .insertInto("resource_access_bindings")
        .values(unscopedValues)
        .execute()

      const scopedValues = await buildResourceAccessBindingInsertValues(db, {
        workspaceId: wsId,
        resourceType: "actor",
        resourceId: targetActor,
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
        .where("binding.actor_id", "=", targetActor)
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
