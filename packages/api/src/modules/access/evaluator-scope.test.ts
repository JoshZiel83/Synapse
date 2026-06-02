import test from "node:test"
import assert from "node:assert/strict"
import { SUBJECT_KIND } from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDbAndClient } from "../../test/helpers/db.js"
import { checkPermission } from "./evaluator.js"
import { buildRuntimePrincipalContext } from "./subject-resolution.js"
import { insertAccessBindingReturningIdOn } from "./binding-storage.js"
import { upsertAccessSubject } from "./subject-registry.js"

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

async function newActor(db: Kysely<any>, workspaceId: string): Promise<string> {
  const row = await db
    .insertInto("actors")
    .values({
      workspace_id: workspaceId,
      name: `actor-${rid()}`,
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
      password_hash: "x",
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
  "checkPermission: workspace_member + scope=conversation grant visible only inside that conversation",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDbAndClient(async ({ db }) => {
      const wsId = await newWorkspace(db)
      const memberId = await newWorkspaceMember(db, wsId)
      const targetActorId = await newActor(db, wsId)
      const convA = await newConversation(db, wsId)
      const convB = await newConversation(db, wsId)

      // Write a `subject=workspace_member + scope=conversation` binding on
      // the target actor. The member should be able to "use" the actor only
      // when the runtime context places them inside conv A.
      await insertAccessBindingReturningIdOn(db, {
        workspaceId: wsId,
        resourceType: "actor",
        resourceId: targetActorId,
        target: {
          subject: {
            kind: SUBJECT_KIND.WORKSPACE_MEMBER,
            memberId,
          },
          scope: {
            kind: SUBJECT_KIND.CONVERSATION,
            conversationId: convA,
          },
        },
      })

      // workspace_member must be an active participant of both conversations
      // for buildRuntimePrincipalContext to surface the conv subject_id in
      // runtimeScopeSubjectIds.
      const memberSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId,
      })
      await addParticipant(db, convA, memberSubjectId)
      await addParticipant(db, convB, memberSubjectId)

      const inA = await buildRuntimePrincipalContext(db, {
        principal: {
          kind: SUBJECT_KIND.WORKSPACE_MEMBER,
          memberId,
        },
        workspaceId: wsId,
        conversationId: convA,
      })
      const inB = await buildRuntimePrincipalContext(db, {
        principal: {
          kind: SUBJECT_KIND.WORKSPACE_MEMBER,
          memberId,
        },
        workspaceId: wsId,
        conversationId: convB,
      })

      const visibleInA = await checkPermission(db, {
        resourceType: "actor",
        resourceId: targetActorId,
        permission: "view",
        subject: { type: "workspace_member", id: memberId },
        runtimeScopeSubjectIds: inA.runtimeScopeSubjectIds,
      })
      const visibleInB = await checkPermission(db, {
        resourceType: "actor",
        resourceId: targetActorId,
        permission: "view",
        subject: { type: "workspace_member", id: memberId },
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

      await insertAccessBindingReturningIdOn(db, {
        workspaceId: wsId,
        resourceType: "actor",
        resourceId: targetActorId,
        target: {
          subject: {
            kind: SUBJECT_KIND.WORKSPACE_MEMBER,
            memberId,
          },
          // no scope
        },
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
