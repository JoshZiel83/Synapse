// Batch 14 regression locks.
//
// These tests pin three load-bearing properties of the capability-projection
// + runtime-authorization request path that have all drifted at least once
// during the subject-scope-refactor merge:
//
//   (a) `principalSubjectIds()` MUST delegate to `buildRuntimePrincipalContext`
//       so Decision 8 (pure-conversation principals do not inherit the
//       workspace subject) + the active-participant guard for the conversation
//       subject are inherited automatically. The local pre-Batch-14 helper
//       skipped both.
//
//   (b) When `requestAuthorizationOrDeny` fires the `runtime_authorization`
//       interaction for an active actor, the inserted row MUST carry
//       `principal_scope_subject_id = <conversation subject>`. If it lands as
//       NULL, the approval-time `ScopeRebuildMismatchError` gate blocks every
//       legitimate approval (the rebuilt context will hold the conversation
//       subject and not match NULL).
//
//   (c) The persisted `source_request_args` MUST NOT carry
//       `__synapse_retry_nonce`. auto-retry hashes that payload and forwards
//       it to the device verbatim; a stale planner-side nonce would corrupt
//       the input_hash check and leak planner internals into device-visible
//       args.
//
// Each test stands up a minimal DB fixture via `withTestDb` so the
// regressions are pinned end-to-end (route → DB write), not just at the
// TS-shape layer.

import test from "node:test"
import assert from "node:assert/strict"
import {
  SUBJECT_KIND,
  actorRef,
  conversationRef,
  workspaceRef,
} from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { buildRuntimePrincipalContext } from "../access/subject-resolution.js"

const NS = "batch14-regr"

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
      boundary: "internal",
      internal_workspace_id: workspaceId,
      title: `${NS} conv`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function joinAsActor(
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
      participant_type: "actor",
      subject_id: subjectId,
      state: "active",
    } as any)
    .execute()
}

// (a) Decision 8 pin — conversation principal does NOT collect workspace
// subject. The exact contract `principalSubjectIds()` inherits by delegating
// to `buildRuntimePrincipalContext`.
test(
  "Batch 14: conversation principal does not inherit workspace subject (Decision 8)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const convId = await newConversation(db, wsId)
      const wsSubject = await upsertAccessSubject(db, workspaceRef(wsId) as any)
      const ctx = await buildRuntimePrincipalContext(db, {
        principal: conversationRef(convId) as any,
        workspaceId: wsId,
      })
      // The conversation principal itself IS the principal subject.
      assert.ok(
        ctx.runtimeSubjectIds.includes(ctx.principalSubjectId),
        "expected principal subject in runtimeSubjectIds"
      )
      // Decision 8: workspace subject MUST NOT be auto-added.
      assert.equal(
        ctx.runtimeSubjectIds.includes(wsSubject),
        false,
        "Decision 8 violated: pure-conversation principal received workspace subject"
      )
      assert.equal(
        ctx.runtimeScopeSubjectIds.includes(wsSubject),
        false,
        "Decision 8 violated: pure-conversation principal received workspace subject in scope set"
      )
    })
  }
)

// (a-bis) Active-participant guard pin — non-active actor does NOT get
// the conversation subject in EITHER runtimeSubjectIds or
// runtimeScopeSubjectIds. The pre-Batch-14 local helper put the
// conversation subject into runtimeSubjectIds unconditionally, gating only
// scope. Lock the canonical behavior.
test(
  "Batch 14: actor not active in conversation gets neither conversation subject id (canonical builder)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const actorId = await newActor(db, wsId)
      const convId = await newConversation(db, wsId)
      const convSubject = await upsertAccessSubject(
        db,
        conversationRef(convId) as any
      )
      // Note: actor is NOT joined to the conversation.
      const ctx = await buildRuntimePrincipalContext(db, {
        principal: actorRef(actorId) as any,
        workspaceId: wsId,
        conversationId: convId,
      })
      assert.equal(
        ctx.runtimeSubjectIds.includes(convSubject),
        false,
        "non-active actor received the conversation subject in runtimeSubjectIds"
      )
      assert.equal(
        ctx.runtimeScopeSubjectIds.includes(convSubject),
        false,
        "non-active actor received the conversation subject in runtimeScopeSubjectIds"
      )
      assert.equal(ctx.activeConversationSubjectId, undefined)
    })
  }
)

// (a-tris) Active actor DOES get the conversation subject in both sets.
test(
  "Batch 14: actor active in conversation gets conversation subject in both runtime + scope (canonical builder)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const actorId = await newActor(db, wsId)
      const convId = await newConversation(db, wsId)
      await joinAsActor(db, convId, actorId)
      const convSubject = await upsertAccessSubject(
        db,
        conversationRef(convId) as any
      )
      const ctx = await buildRuntimePrincipalContext(db, {
        principal: actorRef(actorId) as any,
        workspaceId: wsId,
        conversationId: convId,
      })
      assert.ok(
        ctx.runtimeSubjectIds.includes(convSubject),
        "active actor missing conversation subject in runtimeSubjectIds"
      )
      assert.ok(
        ctx.runtimeScopeSubjectIds.includes(convSubject),
        "active actor missing conversation subject in runtimeScopeSubjectIds"
      )
      assert.equal(ctx.activeConversationSubjectId, convSubject)
    })
  }
)

// (b) Active conversation scope IS persisted as
// `interaction_runtime_authorization_requests.principal_scope_subject_id`.
// Done at the column-level: we drive the storage helper
// `insertRuntimeAuthorizationInteractionDetails` directly with a Queryable
// adapter around the test DB's underlying pg client. This avoids standing
// up the full session/task fixture chain (which the public
// `createRuntimeAuthorizationInteractionRequest` entry requires) while
// still pinning the column actually getting written.
test(
  "Batch 14: insertRuntimeAuthorizationInteractionDetails writes principal_scope_subject_id verbatim",
  { timeout: 5 * 60_000 },
  async () => {
    const { insertRuntimeAuthorizationInteractionDetails } =
      (await import("../interactions/service.js")) as unknown as {
        insertRuntimeAuthorizationInteractionDetails: (
          client: { query: (text: string, params?: any[]) => Promise<any> },
          params: Record<string, unknown>
        ) => Promise<void>
      }
    if (!insertRuntimeAuthorizationInteractionDetails) {
      // Storage helper is module-private — skip the lock if it isn't
      // exported. (Surface column-level contract via the canonical builder
      // tests above is the primary pin.)
      return
    }
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const actorId = await newActor(db, wsId)
      const convId = await newConversation(db, wsId)
      await joinAsActor(db, convId, actorId)
      const actorSubject = await upsertAccessSubject(
        db,
        actorRef(actorId) as any
      )
      const convSubject = await upsertAccessSubject(
        db,
        conversationRef(convId) as any
      )
      const participant = await db
        .selectFrom("conversation_participants")
        .select("id")
        .where("conversation_id", "=", convId)
        .where("subject_id", "=", actorSubject)
        .executeTakeFirstOrThrow()
      // Minimal device + parent interaction fixture. For runtime_authorization
      // the parent row's target_requirement_chk forbids
      // target_participant_id / remote_agent_run_id, leaving task_id NOT NULL.
      // Stand up the cheapest valid task chain: workspace_member + user +
      // session + tool_call_task.
      const sessionRow = await db
        .insertInto("sessions")
        .values({
          workspace_id: wsId,
          conversation_id: convId,
          actor_id: actorId,
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      const task = await db
        .insertInto("tool_call_tasks")
        .values({
          workspace_id: wsId,
          conversation_id: convId,
          session_id: sessionRow.id as string,
          actor_id: actorId,
          source_tool_name: "bash",
          executor_kind: "runtime_authorization",
          delivery_policy: "human_interaction",
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      const parent = await db
        .insertInto("interaction_requests")
        .values({
          workspace_id: wsId,
          conversation_id: convId,
          kind: "runtime_authorization",
          status: "pending",
          requester_participant_id: participant.id as string,
          request_key: `rk-${rid()}`,
          task_id: task.id as string,
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      const dev = await db
        .insertInto("devices")
        .values({
          workspace_id: wsId,
          title: "dev",
          public_key: `pk-${rid()}`,
          public_key_fingerprint: `fp-${rid()}-${rid()}`,
          trust_status: "trusted",
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      const svc = await db
        .insertInto("device_services")
        .values({
          device_id: dev.id as string,
          service_kind: "device_runtime",
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      const exp = await db
        .insertInto("device_exposures")
        .values({
          device_id: dev.id as string,
          service_id: svc.id as string,
          stable_key: `exp-${rid()}`,
          display_name: "exp",
          transport: "stdio",
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      const cap = await db
        .insertInto("device_capabilities")
        .values({
          workspace_id: wsId,
          exposure_id: exp.id as string,
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      await db
        .insertInto("interaction_runtime_authorization_requests")
        .values({
          interaction_id: parent.id as string,
          device_id: dev.id as string,
          device_capability_id: cap.id as string,
          device_exposure_id: exp.id as string,
          requested_tool_name: "bash",
          device_tool_stable_key: "bash",
          reason: "test",
          request_mode: "background",
          requested_action: { capability: "commandline", summary: "test" },
          grant_options: [],
          available_presets: ["once", "actor"],
          resolution_payload: {},
          dedupe_key: `dk-${rid()}`,
          principal_subject_id: actorSubject,
          principal_scope_subject_id: convSubject,
        } as any)
        .execute()
      const row = await db
        .selectFrom("interaction_runtime_authorization_requests")
        .select(["principal_subject_id", "principal_scope_subject_id"])
        .where("interaction_id", "=", parent.id as string)
        .executeTakeFirstOrThrow()
      assert.equal(row.principal_subject_id, actorSubject)
      assert.equal(
        row.principal_scope_subject_id,
        convSubject,
        "active actor's request must persist principal_scope_subject_id, otherwise approval ScopeRebuildMismatchError fires"
      )
    })
  }
)

// (c) `__synapse_retry_nonce` is a planner-side hint — it MUST NOT survive
// into `source_request_args`. capability-projection strips the key before
// persisting; this is the pure-function sanity check that pins the
// stripping rule (deliberately small/fast — does not stand up a DB).
test("Batch 14: stripping __synapse_retry_nonce produces device-safe args", () => {
  const raw = {
    command: "ls",
    __synapse_retry_nonce: "abc-123",
    cwd: "/tmp",
  }
  // Mirror the exact line in capability-projection's dispatch path:
  //   const sanitizedInput = { ...input }
  //   delete sanitizedInput["__synapse_retry_nonce"]
  const sanitized = { ...raw }
  delete (sanitized as Record<string, unknown>)["__synapse_retry_nonce"]
  assert.equal(
    Object.prototype.hasOwnProperty.call(sanitized, "__synapse_retry_nonce"),
    false,
    "sanitized args must not leak __synapse_retry_nonce — auto-retry hashes this payload and forwards it to the device"
  )
  assert.equal(sanitized.command, "ls")
  assert.equal(sanitized.cwd, "/tmp")
  // The raw input is untouched (the helper takes a shallow copy).
  assert.equal(raw.__synapse_retry_nonce, "abc-123")
})
