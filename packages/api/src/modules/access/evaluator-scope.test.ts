import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { SUBJECT_KIND } from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDbAndClient } from "../../test/helpers/db.js"
import { checkPermission } from "./evaluator.js"
import { buildRuntimePrincipalContext } from "./subject-resolution.js"
import { upsertAccessSubject } from "./subject-registry.js"
import { insertWorkspaceResourceGrant } from "../workspace-resources/grant-storage.js"

/**
 * PR3 — scope-aware checkPermission. Verifies that:
 *   - A `subject=actor + scope=conversation` grant is visible to the actor
 *     while running inside that conversation,
 *   - And invisible while running in a different conversation,
 *   - And a `subject=actor` (scope NULL) grant is visible regardless of
 *     conversation context (the legacy filter still matches).
 */

const NS = "evaluator-scope"

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

// workspace_resources.created_by_subject_id is NOT NULL (owner→subject
// migration). Mint a workspace_member subject to serve as the creator.
async function newCreatorSubjectId(
  db: Kysely<any>,
  workspaceId: string
): Promise<string> {
  const memberId = await newWorkspaceMember(db, workspaceId)
  return upsertAccessSubject(db as any, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId,
  })
}

async function newActor(db: Kysely<any>, workspaceId: string): Promise<string> {
  const id = crypto.randomUUID()
  await db
    .insertInto("workspace_resources")
    .values({
      id,
      workspace_id: workspaceId,
      kind: "actor",
      display_name: `actor-${rid()}`,
      created_by_subject_id: await newCreatorSubjectId(db, workspaceId),
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("actors")
    .values({
      id,
      role: "assistant",
      title: `${NS} actor`,
      current_version: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function newWorkspaceMember(
  db: Kysely<any>,
  workspaceId: string
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
      workspace_id: workspaceId,
      user_id: user.id as string,
      trust_level: "member",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function newConversation(
  db: Kysely<any>,
  workspaceId: string
): Promise<string> {
  const row = await db
    .insertInto("conversations")
    .values({
      kind: "group",
      workspace_id: workspaceId,
      title: `${NS} conv`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function newInstalledSkill(
  db: Kysely<any>,
  workspaceId: string
): Promise<string> {
  const snapshot = await db
    .insertInto("skill_snapshots")
    .values({
      name: `${NS} skill`,
      description: "",
      content_hash: `hash-${rid()}`,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const skillId = crypto.randomUUID()
  await db
    .insertInto("workspace_resources")
    .values({
      id: skillId,
      workspace_id: workspaceId,
      kind: "installed_skill",
      display_name: `${NS} skill`,
      created_by_subject_id: await newCreatorSubjectId(db, workspaceId),
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("installed_skills")
    .values({
      id: skillId,
      current_snapshot_id: snapshot.id,
      current_version: 1,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function addParticipant(
  db: Kysely<any>,
  conversationId: string,
  subjectId: string
): Promise<void> {
  await db
    .insertInto("conversation_participants")
    .values({
      conversation_id: conversationId,
      subject_id: subjectId,
      state: "active",
    } as any)
    .execute()
}

test(
  "checkPermission: actor + scope=conversation skill grant is visible only inside that conversation",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const wsId = await newWorkspace(db)
      const actorId = await newActor(db, wsId)
      const skillId = await newInstalledSkill(db, wsId)
      const convA = await newConversation(db, wsId)
      const convB = await newConversation(db, wsId)

      // Current grant model: scoped grants live on capability apps and only
      // support subject=actor|remote_agent with scope=conversation. The actor
      // should be able to use the skill only when the runtime context places
      // them inside conv A.
      await insertWorkspaceResourceGrant(db, {
        workspaceId: wsId,
        workspaceResourceId: skillId,
        target: {
          subject: {
            kind: SUBJECT_KIND.ACTOR,
            actorId,
          },
          scope: {
            kind: SUBJECT_KIND.CONVERSATION,
            conversationId: convA,
          },
        },
        permissions: ["use"],
      })

      // The actor must be an active participant of both conversations
      // for buildRuntimePrincipalContext to surface the conv subject_id in
      // runtimeScopeSubjectIds.
      const actorSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId,
      })
      await addParticipant(db, convA, actorSubjectId)
      await addParticipant(db, convB, actorSubjectId)

      const inA = await buildRuntimePrincipalContext(db, {
        principal: {
          kind: SUBJECT_KIND.ACTOR,
          actorId,
        },
        workspaceId: wsId,
        conversationId: convA,
      })
      const inB = await buildRuntimePrincipalContext(db, {
        principal: {
          kind: SUBJECT_KIND.ACTOR,
          actorId,
        },
        workspaceId: wsId,
        conversationId: convB,
      })

      const visibleInA = await checkPermission(db, {
        resourceType: "installed_skill",
        resourceId: skillId,
        permission: "use",
        subject: { type: "actor", id: actorId },
        runtimeScopeSubjectIds: inA.runtimeScopeSubjectIds,
      })
      const visibleInB = await checkPermission(db, {
        resourceType: "installed_skill",
        resourceId: skillId,
        permission: "use",
        subject: { type: "actor", id: actorId },
        runtimeScopeSubjectIds: inB.runtimeScopeSubjectIds,
      })
      assert.equal(visibleInA, true, "scoped grant must apply in conv A")
      assert.equal(visibleInB, false, "scoped grant must NOT apply in conv B")
    })
  }
)

test(
  "checkPermission: legacy workspace_member (scope NULL) grant is visible without runtime context",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const wsId = await newWorkspace(db)
      const memberId = await newWorkspaceMember(db, wsId)
      const targetActorId = await newActor(db, wsId)

      await insertWorkspaceResourceGrant(db, {
        workspaceId: wsId,
        workspaceResourceId: targetActorId,
        target: {
          subject: {
            kind: SUBJECT_KIND.WORKSPACE_MEMBER,
            memberId,
          },
          // no scope
        },
        permissions: ["contact_visible"],
      })

      const visible = await checkPermission(db, {
        resourceType: "actor",
        resourceId: targetActorId,
        permission: "view",
        subject: { type: "workspace_member", id: memberId },
        // No runtimeScopeSubjectIds → legacy "scope IS NULL only" filter,
        // which matches this row (scope IS NULL).
      })
      assert.equal(visible, true)
    })
  }
)
