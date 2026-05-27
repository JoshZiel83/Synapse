import test from "node:test"
import assert from "node:assert/strict"
import {
  remoteAgentRef,
  conversationRef,
  subjectScopeLabel,
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
import {
  targetSupportsConversationTypeOverride,
  validateConversationScopedAccessTarget,
} from "../access/policy.ts"

/**
 * Round 10 review (P3) regression for the remote_agent_in_conversation
 * service-level update paths.
 *
 * `updateInstalledSkillAccessGrant` and `updateInstalledSkill` both:
 *   1. Load the AccessBindingRow for the grant.
 *   2. Call `skillBindingToAccessTarget(row)` to recover the
 *      ScopedSubjectTarget shape.
 *   3. Pass that target into `assertGrantConversationTypeOverrideAllowed`
 *      / `validateConversationScopedAccessTarget`.
 *
 * Before the round-10 fix to skillBindingToAccessTarget (replacing the
 * 5-value legacy label switch with a direct `readAccessBindingTarget`
 * call), step 2 silently collapsed any remote_agent grant — including
 * `remote_agent + scope=conversation` — into a `{ subject: workspace }`
 * target. The downstream policy checks then ran against the wrong
 * shape: `targetSupportsConversationTypeOverride` returned true (it
 * treats workspace as override-eligible), and
 * `validateConversationScopedAccessTarget` saw no conversation scope
 * and bailed out, skipping both the conversation-type policy check
 * and the active-participant gate.
 *
 * The tests below run the same three-step pipeline directly — without
 * the surrounding service infrastructure that hard-wires the global
 * db pool — and assert the post-fix behavior:
 *
 *   1. The decoded target carries `subject=remote_agent +
 *      scope=conversation` (not collapsed to workspace).
 *   2. `targetSupportsConversationTypeOverride(decoded)` returns FALSE,
 *      so any update of `conversationTypeMaskOverride` is rejected
 *      by `assertGrantConversationTypeOverrideAllowed`.
 *   3. `validateConversationScopedAccessTarget(decoded)` runs the
 *      remote_agent active-participant gate — rejecting the update
 *      when the participant row is missing, accepting it when present.
 */

const NS = "skill-grant-update"

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

async function newInstalledSkill(
  db: Kysely<any>,
  wsId: string
): Promise<string> {
  const user = await db
    .insertInto("users")
    .values({
      email: `${rid()}@${NS}`,
      name: "creator",
      password_hash: "x",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const member = await db
    .insertInto("workspace_members")
    .values({
      workspace_id: wsId,
      user_id: user.id as string,
      trust_level: "admin",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const snapshot = await db
    .insertInto("skill_snapshots")
    .values({
      name: "test-skill",
      description: "",
      content_hash: `hash-${rid()}`,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const row = await db
    .insertInto("installed_skills")
    .values({
      workspace_id: wsId,
      slug: `s-${rid()}`,
      name: "skill",
      current_snapshot_id: snapshot.id as string,
      created_by_workspace_member_id: member.id as string,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test(
  "skillBindingToAccessTarget decodes remote_agent_in_conversation correctly (no collapse to workspace) — round-10 P2",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const remoteAgentId = await newRemoteAgent(db, wsId)
      const conversationId = await newConversation(db, wsId)
      const skillId = await newInstalledSkill(db, wsId)

      const bindingValues = await buildResourceAccessBindingInsertValues(db, {
        workspaceId: wsId,
        resourceType: "installed_skill",
        resourceId: skillId,
        target: {
          subject: remoteAgentRef(remoteAgentId),
          scope: conversationRef(conversationId),
        },
      })
      await db
        .insertInto("resource_access_bindings")
        .values(bindingValues)
        .execute()

      // Read the grant back the way the service does.
      const rows = await loadAccessBindingRowsForResources(db, {
        resourceType: "installed_skill",
        resourceIds: [skillId],
      })
      assert.equal(rows.length, 1)
      const target = readAccessBindingTarget(
        normalizeAccessBindingRow(rows[0] as any) as any
      )

      // Round-10 fix: the decoded target is the actual scoped shape,
      // not a workspace fallback.
      assert.equal(
        subjectScopeLabel(target as any),
        "remote_agent_in_conversation"
      )
      assert.equal(target.subject.kind, "remote_agent")
      assert.equal(target.scope?.kind, "conversation")

      // Direct consequence: conversation-type override is rejected
      // (this is the gate `assertGrantConversationTypeOverrideAllowed`
      // consults in updateInstalledSkillAccessGrant /
      // updatePluginInstallation).
      assert.equal(
        targetSupportsConversationTypeOverride(target as any),
        false,
        "remote_agent + scope=conversation must NOT support conversation-type override"
      )
    })
  }
)

test(
  "validateConversationScopedAccessTarget gates remote_agent_in_conversation by participant — round-10 P3",
  { timeout: 5 * 60_000 },
  async () => {
    // Verifies that after decoding the grant (the round-10 fix), the
    // policy validator fires its remote_agent active-participant check
    // — which is what the service-level update paths
    // (updateInstalledSkillAccessGrant + updateInstalledSkill) trigger.
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const remoteAgentId = await newRemoteAgent(db, wsId)
      const conversationId = await newConversation(db, wsId)
      const skillId = await newInstalledSkill(db, wsId)

      const bindingValues = await buildResourceAccessBindingInsertValues(db, {
        workspaceId: wsId,
        resourceType: "installed_skill",
        resourceId: skillId,
        target: {
          subject: remoteAgentRef(remoteAgentId),
          scope: conversationRef(conversationId),
        },
      })
      await db
        .insertInto("resource_access_bindings")
        .values(bindingValues)
        .execute()

      const rows = await loadAccessBindingRowsForResources(db, {
        resourceType: "installed_skill",
        resourceIds: [skillId],
      })
      const target = readAccessBindingTarget(
        normalizeAccessBindingRow(rows[0] as any) as any
      )

      // No participant row yet → validator rejects the (re-validated)
      // grant.
      await assert.rejects(
        validateConversationScopedAccessTarget({
          db,
          target: target as any,
          effectiveConversationTypeMask: 0b11111,
          buildError: (m) => new Error(m),
        }),
        /active participant/
      )

      // Add the participant → validator now accepts the same grant.
      const remoteAgentSubjectId = await upsertAccessSubject(db as any, {
        kind: "remote_agent" as any,
        remoteAgentId,
      })
      await db
        .insertInto("conversation_participants")
        .values({
          conversation_id: conversationId,
          participant_type: "remote_agent",
          subject_id: remoteAgentSubjectId,
          state: "active",
        } as any)
        .execute()
      const ok = await validateConversationScopedAccessTarget({
        db,
        target: target as any,
        effectiveConversationTypeMask: 0b11111,
        buildError: (m) => new Error(m),
      })
      assert.ok(ok)
    })
  }
)
