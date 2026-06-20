import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { SUBJECT_KIND, actorRef } from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "./subject-registry.js"
import {
  buildRuntimePrincipalContext,
  buildRuntimePrincipalContextOn,
  isSubjectActiveConversationParticipant,
} from "./subject-resolution.js"

/**
 * PR2 — RuntimePrincipalContext builder.
 *
 * Covers the contract from the refactor plan:
 *   - workspace subject_id is always included (subjects + scopeSubjects).
 *   - conversation subject_id is added only when the principal is an active
 *     participant of that conversation.
 *   - delegatedWorkspaceMemberId is honored only after validating workspace
 *     membership (cross-workspace delegation throws).
 *   - actor/remote_agent principals do NOT auto-pull in their
 *     created_by_workspace_member_id — that would leak user_private grants.
 */

const NS = "runtime-principal"

function rid(): string {
  return Math.random().toString(36).slice(2, 10)
}

async function newWorkspace(db: Kysely<any>): Promise<string> {
  const user = await db
    .insertInto("users")
    .values({
      email: `${rid()}@runtime-principal`,
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

async function newWorkspaceMember(
  db: Kysely<any>,
  workspaceId: string
): Promise<string> {
  const user = await db
    .insertInto("users")
    .values({
      email: `${rid()}@runtime-principal`,
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

async function creatorSubjectIdFor(
  db: Kysely<any>,
  workspaceId: string
): Promise<string> {
  const user = await db
    .insertInto("users")
    .values({
      email: `${rid()}@runtime-principal`,
      name: "creator",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const member = await db
    .insertInto("workspace_members")
    .values({
      workspace_id: workspaceId,
      user_id: user.id as string,
      trust_level: "member",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return upsertAccessSubject(db as any, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    workspaceMemberId: member.id as string,
  })
}

async function newActor(
  db: Kysely<any>,
  workspaceId: string,
  createdByMemberId?: string
): Promise<string> {
  const actorId = crypto.randomUUID()
  await db
    .insertInto("workspace_resources")
    .values({
      id: actorId,
      workspace_id: workspaceId,
      kind: "actor",
      display_name: `${NS} actor`,
      status: "active",
      created_by_subject_id: await creatorSubjectIdFor(db, workspaceId),
    } as any)
    .execute()
  const row = await db
    .insertInto("actors")
    .values({
      id: actorId,
      role: "assistant",
      title: `${NS} actor`,
      current_version: 1,
    } as any)
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

async function addActorParticipant(
  db: Kysely<any>,
  conversationId: string,
  actorId: string
): Promise<void> {
  const subjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.ACTOR,
    actorId,
  })
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
  "buildRuntimePrincipalContext: workspace subject always present in both lists",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const actorId = await newActor(db, wsId)
      const wsSubject = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId: wsId,
      })
      const ctx = await buildRuntimePrincipalContext(db, {
        principal: actorRef(actorId),
        workspaceId: wsId,
      })
      assert.ok(ctx.runtimeSubjectIds.includes(wsSubject))
      assert.ok(ctx.runtimeScopeSubjectIds.includes(wsSubject))
    })
  }
)

test(
  "buildRuntimePrincipalContext: conversation subject added only when principal is active participant",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const actorId = await newActor(db, wsId)
      const convId = await newConversation(db, wsId)
      const convSubject = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: convId,
      })

      const notActive = await buildRuntimePrincipalContext(db, {
        principal: actorRef(actorId),
        workspaceId: wsId,
        conversationId: convId,
      })
      assert.equal(notActive.runtimeSubjectIds.includes(convSubject), false)
      assert.equal(
        notActive.runtimeScopeSubjectIds.includes(convSubject),
        false
      )

      await addActorParticipant(db, convId, actorId)

      const active = await buildRuntimePrincipalContext(db, {
        principal: actorRef(actorId),
        workspaceId: wsId,
        conversationId: convId,
      })
      assert.ok(active.runtimeSubjectIds.includes(convSubject))
      assert.ok(active.runtimeScopeSubjectIds.includes(convSubject))
    })
  }
)

test(
  "buildRuntimePrincipalContext: actor principal does NOT auto-include created_by workspace_member subject",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const memberId = await newWorkspaceMember(db, wsId)
      const actorId = await newActor(db, wsId, memberId)
      const memberSubject = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        workspaceMemberId: memberId,
      })

      const ctx = await buildRuntimePrincipalContext(db, {
        principal: actorRef(actorId),
        workspaceId: wsId,
      })
      // SECURITY: actor inheriting the creator's workspace_member subject_id
      // would silently expose owner=workspace_member memory / grants.
      assert.equal(ctx.runtimeSubjectIds.includes(memberSubject), false)
    })
  }
)

test(
  "buildRuntimePrincipalContext: same-workspace delegated member is included",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const memberId = await newWorkspaceMember(db, wsId)
      const actorId = await newActor(db, wsId)
      const memberSubject = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        workspaceMemberId: memberId,
      })

      const ctx = await buildRuntimePrincipalContext(db, {
        principal: actorRef(actorId),
        workspaceId: wsId,
        delegatedWorkspaceMemberId: memberId,
      })
      assert.ok(ctx.runtimeSubjectIds.includes(memberSubject))
    })
  }
)

test(
  "buildRuntimePrincipalContext: cross-workspace delegated member is rejected",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsA = await newWorkspace(db)
      const wsB = await newWorkspace(db)
      const memberInB = await newWorkspaceMember(db, wsB)
      const actorInA = await newActor(db, wsA)

      await assert.rejects(
        buildRuntimePrincipalContext(db, {
          principal: actorRef(actorInA),
          workspaceId: wsA,
          delegatedWorkspaceMemberId: memberInB,
        }),
        /belongs to workspace.*not/
      )
    })
  }
)

test(
  "isSubjectActiveConversationParticipant: generic over participant kind",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const convId = await newConversation(db, wsId)
      const actorId = await newActor(db, wsId)
      await addActorParticipant(db, convId, actorId)
      const actorSubject = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId,
      })

      assert.equal(
        await isSubjectActiveConversationParticipant(db, convId, actorSubject),
        true
      )

      // Non-participant — another actor in the same workspace.
      const otherActorId = await newActor(db, wsId)
      const otherActorSubject = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: otherActorId,
      })
      assert.equal(
        await isSubjectActiveConversationParticipant(
          db,
          convId,
          otherActorSubject
        ),
        false
      )
    })
  }
)

/**
 * 3b: buildRuntimePrincipalContextOn is the pg-form dual used by the approval
 * flow — it runs against the SAME open transaction/connection as the caller so
 * it must see writes made earlier on that handle, including ones not yet
 * committed. This was previously untested (only the Kysely form had coverage).
 * `withTestDb` already hands `db` to us as a transaction-scoped executor, so we
 * pass it straight in as the `Executor` and assert:
 *   1. a participant row INSERTed earlier on this handle is visible to the
 *      builder (the conversation subject shows up); and
 *   2. the result matches the Kysely-form builder on the same handle (parity —
 *      proves the shared core behaves identically through both wrappers).
 */
test(
  "buildRuntimePrincipalContextOn: sees a participant written earlier on the same transaction handle",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const actorId = await newActor(db, wsId)
      const convId = await newConversation(db, wsId)
      const convSubject = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: convId,
      })
      await addActorParticipant(db, convId, actorId)

      // `db` here is the test's open transaction handle — exactly the kind of
      // Executor the approval flow passes. The participant INSERT above lives
      // on the same handle and is uncommitted; the On builder must still see it.
      const onCtx = await buildRuntimePrincipalContextOn(db, {
        principal: actorRef(actorId),
        workspaceId: wsId,
        conversationId: convId,
      })
      assert.ok(
        onCtx.runtimeSubjectIds.includes(convSubject),
        "participant written on the same handle should make the conversation subject visible"
      )
      assert.equal(onCtx.activeConversationSubjectId, convSubject)

      // Parity with the Kysely form on the same handle.
      const kyselyCtx = await buildRuntimePrincipalContext(db, {
        principal: actorRef(actorId),
        workspaceId: wsId,
        conversationId: convId,
      })
      assert.equal(kyselyCtx.activeConversationSubjectId, convSubject)
      assert.deepEqual(
        [...onCtx.runtimeSubjectIds].sort(),
        [...kyselyCtx.runtimeSubjectIds].sort()
      )
      assert.deepEqual(
        [...onCtx.runtimeScopeSubjectIds].sort(),
        [...kyselyCtx.runtimeScopeSubjectIds].sort()
      )
    })
  }
)

/**
 * 3b: the `...On` form must enforce the SAME cross-workspace delegation guard
 * as the Kysely form (a member from another workspace is rejected). Confirms
 * the collapse onto buildRuntimePrincipalContextCore did not drop the invariant
 * on the pg-form path.
 */
test(
  "buildRuntimePrincipalContextOn: cross-workspace delegated member is rejected",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsA = await newWorkspace(db)
      const wsB = await newWorkspace(db)
      const memberInB = await newWorkspaceMember(db, wsB)
      const actorInA = await newActor(db, wsA)

      await assert.rejects(
        buildRuntimePrincipalContextOn(db, {
          principal: actorRef(actorInA),
          workspaceId: wsA,
          delegatedWorkspaceMemberId: memberInB,
        }),
        /belongs to workspace.*not/
      )
    })
  }
)
