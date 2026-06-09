import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import {
  conversationRef,
  remoteAgentRef,
  subjectScopeLabel,
  workspaceMemberRef,
} from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { validateConversationScopedAccessTarget } from "../access/policy.js"
import {
  buildSkillAccessRow,
  matchesScopeTarget,
  type SkillScopeTarget,
} from "./service.js"

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
  const remoteAgentId = crypto.randomUUID()
  await db
    .insertInto("workspace_apps")
    .values({
      id: remoteAgentId,
      workspace_id: wsId,
      kind: "remote_agent",
      display_name: `${NS} agent`,
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

test(
  "remote_agent + conversation targets stay scoped and fail conversation-type override eligibility",
  { timeout: 5 * 60_000 },
  async () => {
    const target = {
      subject: remoteAgentRef("ra-1"),
      scope: conversationRef("conv-1"),
    }

    assert.equal(subjectScopeLabel(target), "remote_agent")

    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const remoteAgentId = await newRemoteAgent(db, wsId)
      const conversationId = await newConversation(db, wsId)

      const scopedTarget = {
        subject: remoteAgentRef(remoteAgentId),
        scope: conversationRef(conversationId),
      }

      await assert.rejects(
        validateConversationScopedAccessTarget({
          db,
          target: scopedTarget,
          effectiveConversationTypeMask: 0b1111,
          buildError: (message) => new Error(message),
        }),
        /active participant/
      )

      const remoteAgentSubjectId = await upsertAccessSubject(db as any, {
        kind: "remote_agent" as any,
        remoteAgentId,
      })
      await db
        .insertInto("conversation_participants")
        .values({
          conversation_id: conversationId,
          subject_id: remoteAgentSubjectId,
          state: "active",
        } as any)
        .execute()

      const ok = await validateConversationScopedAccessTarget({
        db,
        target: scopedTarget,
        effectiveConversationTypeMask: 0b1111,
        buildError: (message) => new Error(message),
      })
      assert.ok(ok)
    })
  }
)

test(
  "buildSkillAccessRow + matchesScopeTarget discriminate workspace_member grants",
  { timeout: 5 * 60_000 },
  async () => {
    const rowA = buildSkillAccessRow({
      id: "grant-a",
      workspace_id: "ws-1",
      resource_type: "installed_skill",
      resource_id: "skill-1",
      installed_skill_id: "skill-1",
      plugin_installation_id: null,
      automation_event_source_id: null,
      actor_id: null,
      remote_agent_id: null,
      relation: "use_workspace_member",
      subject_id: "subject-a",
      scope_subject_id: null,
      subject_kind: "workspace_member",
      subject_workspace_id_via_join: "ws-1",
      subject_workspace_member_id_via_join: "member-a",
      conversation_type_mask_override: null,
      status: "active",
      source: "manual",
      created_by_workspace_member_id: null,
      reason: null,
      created_at: new Date().toISOString(),
      revoked_at: null,
    } as any)

    const rowB = buildSkillAccessRow({
      id: "grant-b",
      workspace_id: "ws-1",
      resource_type: "installed_skill",
      resource_id: "skill-1",
      installed_skill_id: "skill-1",
      plugin_installation_id: null,
      automation_event_source_id: null,
      actor_id: null,
      remote_agent_id: null,
      relation: "use_workspace_member",
      subject_id: "subject-b",
      scope_subject_id: null,
      subject_kind: "workspace_member",
      subject_workspace_id_via_join: "ws-1",
      subject_workspace_member_id_via_join: "member-b",
      conversation_type_mask_override: null,
      status: "active",
      source: "manual",
      created_by_workspace_member_id: null,
      reason: null,
      created_at: new Date().toISOString(),
      revoked_at: null,
    } as any)

    const filterA: SkillScopeTarget = {
      bindScope: "workspace_member",
      useScope: "workspace_member",
      actorId: null,
      remoteAgentId: null,
      workspaceMemberId: "member-a",
      conversationId: null,
    }
    const filterB: SkillScopeTarget = {
      ...filterA,
      workspaceMemberId: "member-b",
    }

    assert.equal(matchesScopeTarget(rowA, filterA), true)
    assert.equal(matchesScopeTarget(rowB, filterA), false)
    assert.equal(matchesScopeTarget(rowA, filterB), false)
    assert.equal(matchesScopeTarget(rowB, filterB), true)
  }
)
