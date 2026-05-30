// Batch 14 regression locks — production-path edition.
//
// Previous version of this file tested `buildRuntimePrincipalContext`
// directly (the canonical builder that `principalSubjectIds` delegates to)
// and reimplemented the `__synapse_retry_nonce` strip step. Both were
// shallow — if the production helpers got reverted to a local
// implementation that violated Decision 8 or stopped stripping the nonce,
// those tests would still pass.
//
// This rewrite locks the actual production exports:
//
//   - `principalSubjectIds()`                    — exported from service.ts.
//     Three subtests cover the contracts the local pre-Batch-14 helper
//     violated: Decision 8 (conversation principal !=> workspace subject),
//     active-participant guard on conversation-subject membership in
//     runtimeSubjectIds (not just scope), active-participant grant.
//
//   - `buildRuntimeAuthorizationRequestParams()` — exported from service.ts.
//     One subtest with `input !== sanitizedInput` and a non-null
//     `principalScopeSubjectId` verifies both fields round-trip into the
//     params struct (catches the two service.ts:724/773-style reverts).
//
//   - `stripPlannerNonce()`                      — exported from service.ts.
//     Used at both the dispatcher's input_hash computation and the
//     persisted sourceRequestArgs path. The unit test pins the contract.
//
//   - A static-text inspection over `service.ts` catches the third revert
//     site (dispatch-level wiring at line ~558 that passes
//     `principalScopeSubjectId: device.subjects.activeConversationSubjectId`
//     to the helper). The dispatcher is a closure so it isn't directly
//     unit-testable; the text check is the targeted lock for that line.

import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import {
  SUBJECT_KIND,
  actorRef,
  conversationRef,
  workspaceRef,
} from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import {
  principalSubjectIds,
  buildRuntimeAuthorizationRequestParams,
  stripPlannerNonce,
  type DevicePrincipal,
  type ProjectToolsInput,
} from "./service.js"

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
      subject_id: subjectId,
      state: "active",
    } as any)
    .execute()
}

// --- (a) principalSubjectIds direct tests ---

test(
  "Batch 14: principalSubjectIds — conversation principal does NOT inherit workspace subject (Decision 8)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const convId = await newConversation(db, wsId)
      const wsSubject = await upsertAccessSubject(db, workspaceRef(wsId) as any)
      const input: ProjectToolsInput = {
        workspaceId: wsId,
        principal: { kind: "conversation", conversationId: convId },
        conversationId: convId,
        consumer: "chat_runtime",
      }
      const subjects = await principalSubjectIds(input, { db })
      assert.ok(
        subjects.principalSubjectId &&
          subjects.allIds.includes(subjects.principalSubjectId),
        "principal subject must be in allIds"
      )
      assert.equal(
        subjects.allIds.includes(wsSubject),
        false,
        "Decision 8 violated by principalSubjectIds: conversation principal received workspace subject in allIds"
      )
      assert.equal(
        subjects.scopeSubjectIds.includes(wsSubject),
        false,
        "Decision 8 violated by principalSubjectIds: conversation principal received workspace subject in scopeSubjectIds"
      )
    })
  }
)

test(
  "Batch 14: principalSubjectIds — non-active actor does NOT get conversation subject in either set",
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
      const input: ProjectToolsInput = {
        workspaceId: wsId,
        principal: { kind: "actor", actorId, conversationId: convId },
        conversationId: convId,
        consumer: "chat_runtime",
      }
      const subjects = await principalSubjectIds(input, { db })
      assert.equal(
        subjects.allIds.includes(convSubject),
        false,
        "non-active actor received the conversation subject in allIds — `subject=conversation` device bindings would leak"
      )
      assert.equal(
        subjects.scopeSubjectIds.includes(convSubject),
        false,
        "non-active actor received the conversation subject in scopeSubjectIds — `subject=actor + scope=conversation` grants would leak"
      )
      assert.equal(subjects.activeConversationSubjectId, undefined)
    })
  }
)

test(
  "Batch 14: principalSubjectIds — active actor gets conversation subject in BOTH sets + activeConversationSubjectId",
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
      const input: ProjectToolsInput = {
        workspaceId: wsId,
        principal: { kind: "actor", actorId, conversationId: convId },
        conversationId: convId,
        consumer: "chat_runtime",
      }
      const subjects = await principalSubjectIds(input, { db })
      assert.ok(
        subjects.allIds.includes(convSubject),
        "active actor missing conversation subject in allIds"
      )
      assert.ok(
        subjects.scopeSubjectIds.includes(convSubject),
        "active actor missing conversation subject in scopeSubjectIds — `actor + scope=conversation` SQL match would fail"
      )
      assert.equal(subjects.activeConversationSubjectId, convSubject)
    })
  }
)

// --- (b) buildRuntimeAuthorizationRequestParams pure-function lock ---

test("Batch 14: buildRuntimeAuthorizationRequestParams round-trips scope + sanitizedInput", () => {
  const rawInput = {
    command: "ls",
    __synapse_retry_nonce: "stale-planner-nonce-xyz",
    cwd: "/tmp",
  }
  const sanitizedInput = stripPlannerNonce(rawInput)
  const params = buildRuntimeAuthorizationRequestParams({
    projectInput: {
      workspaceId: "ws-1",
      principal: {
        kind: "actor",
        actorId: "actor-1",
        conversationId: "conv-1",
      },
      conversationId: "conv-1",
      consumer: "chat_runtime",
    },
    row: {
      device_id: "dev-1",
      device_name: "dev",
      device_service_id: "svc-1",
      device_exposure_id: "exp-1",
      device_capability_id: "cap-1",
      device_tool_id: "tool-1",
      device_tool_revision_id: "rev-1",
      catalog_revision_id: "cat-1",
      transport: "stdio",
      builtin_kind: "commandline",
      visible_tool_name: "bash",
      visible_description: "bash",
      input_schema: { type: "object" },
      capability_conversation_type_mask_override: null,
      device_conversation_type_mask_override: null,
    },
    toolName: "device__bash",
    sanitizedInput,
    requestedAction: {
      capability: "commandline",
      summary: "test",
      commandline: {
        executor: "bash",
        commandMatchType: "exact",
        commandText: "ls",
      },
    } as any,
    principalSubjectId: "subj-actor-1",
    principalScopeSubjectId: "subj-conv-1",
    conversationId: "conv-1",
  })
  // Lock 1: principalScopeSubjectId flows through (the line that — when
  // dropped — causes ScopeRebuildMismatchError to fire at approval time).
  assert.equal(
    params.source.principalScopeSubjectId,
    "subj-conv-1",
    "principalScopeSubjectId must round-trip into source — dropping it causes ScopeRebuildMismatchError on approval"
  )
  // Lock 2: sourceRequestArgs equals sanitizedInput (not raw input). If
  // someone reverts service.ts:773 from `args.sanitizedInput` to `args.input`,
  // the persisted object grows back the planner-side nonce.
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      params.sourceRequestArgs,
      "__synapse_retry_nonce"
    ),
    false,
    "sourceRequestArgs must be sanitizedInput (no nonce key) — using raw input leaks the planner-side nonce to the device"
  )
  assert.equal(params.sourceRequestArgs, sanitizedInput)
  assert.deepEqual(params.sourceRequestArgs, { command: "ls", cwd: "/tmp" })
  // null when omitted (the no-active-scope case).
  const noScope = buildRuntimeAuthorizationRequestParams({
    projectInput: {
      workspaceId: "ws-1",
      principal: { kind: "actor", actorId: "actor-1" },
      consumer: "chat_runtime",
    },
    row: {
      device_id: "dev-1",
      device_name: "dev",
      device_service_id: "svc-1",
      device_exposure_id: "exp-1",
      device_capability_id: "cap-1",
      device_tool_id: "tool-1",
      device_tool_revision_id: "rev-1",
      catalog_revision_id: "cat-1",
      transport: "stdio",
      builtin_kind: "commandline",
      visible_tool_name: "bash",
      visible_description: "bash",
      input_schema: { type: "object" },
      capability_conversation_type_mask_override: null,
      device_conversation_type_mask_override: null,
    },
    toolName: "device__bash",
    sanitizedInput: { command: "ls" },
    requestedAction: {
      capability: "commandline",
      summary: "t",
      commandline: {
        executor: "bash",
        commandMatchType: "exact",
        commandText: "ls",
      },
    } as any,
    principalSubjectId: "subj-actor-1",
    conversationId: "conv-1",
    // no principalScopeSubjectId
  })
  assert.equal(noScope.source.principalScopeSubjectId, null)
})

// --- (c) stripPlannerNonce unit lock ---

test("Batch 14: stripPlannerNonce removes __synapse_retry_nonce and leaves input untouched", () => {
  const raw = { command: "ls", __synapse_retry_nonce: "abc", cwd: "/tmp" }
  const out = stripPlannerNonce(raw)
  assert.equal(
    Object.prototype.hasOwnProperty.call(out, "__synapse_retry_nonce"),
    false
  )
  assert.equal(out.command, "ls")
  assert.equal(out.cwd, "/tmp")
  // Raw input untouched — important because dispatchDeviceTool keeps `input`
  // around for the auth-request hint metadata.
  assert.equal(raw.__synapse_retry_nonce, "abc")
})

// --- (d) Source-text inspection for the dispatch-closure wiring ---
//
// The dispatcher is a closure inside `unionWithDevice` — not directly
// callable. To lock the load-bearing line
//
//   principalScopeSubjectId: device.subjects.activeConversationSubjectId,
//
// (the wiring that propagates active scope from the projection into the
// auth request), inspect the source. If anyone reverts the line to
// `undefined` or drops it, the test fails.

test("Batch 14: capability-projection dispatch closure wires activeConversationSubjectId into requestAuthorizationOrDeny", async () => {
  const source = await readFile(
    new URL("./service.ts", import.meta.url),
    "utf8"
  )
  assert.ok(
    /principalScopeSubjectId:\s*device\.subjects\.activeConversationSubjectId/.test(
      source
    ),
    "dispatch closure no longer passes `principalScopeSubjectId: device.subjects.activeConversationSubjectId` — the locked principal_scope_subject_id will be NULL and approval will throw ScopeRebuildMismatchError"
  )
})

test("Batch 14: capability-projection dispatcher computes sanitizedInput via stripPlannerNonce", async () => {
  const source = await readFile(
    new URL("./service.ts", import.meta.url),
    "utf8"
  )
  assert.ok(
    /sanitizedInput\s*:\s*Record<string,\s*unknown>\s*=\s*stripPlannerNonce\(input\)/.test(
      source
    ),
    "dispatch closure no longer computes `sanitizedInput = stripPlannerNonce(input)` — raw planner-side nonce can leak into device args"
  )
})
