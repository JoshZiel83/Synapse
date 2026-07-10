// Unit tests for the retry_nonce dedupe-reuse contract.
//
// The bug this guards against: createRuntimeAuthorizationRequest generates
// a fresh retry_nonce on every call, but when its background-mode dedupe
// (or the inner request-key dedupe inside
// createRuntimeAuthorizationTaskRequest) reuses an existing pending
// row, the post-approval grant is created with the OLD row's
// source_retry_nonce. Surfacing the freshly-generated nonce to the caller
// would let the model retry with a token the grant matcher never honors,
// silently expiring the once-grant. The two helpers below collapse that
// rule into pure functions so a future refactor that drops them trips this
// test.

import test from "node:test"
import assert from "node:assert/strict"
import { nowIsoInstant } from "@synapse/shared/datetime"

import type { TaskSummary } from "@synapse/shared/types"
import { pickPersistedRetryNonce, didInnerDedupeReuseRow } from "./requests.js"

function makeRuntimeAuthSummary(
  overrides?: Partial<{
    sourceRetryNonce?: string
  }>
): TaskSummary {
  return {
    kind: "runtime_authorization",
    id: "00000000-0000-0000-0000-000000000001",
    workspaceId: "00000000-0000-0000-0000-00000000000a",
    conversationId: "00000000-0000-0000-0000-00000000000b",
    lifecycleStatus: "auth_required",
    revision: 1,
    createdAt: nowIsoInstant(),
    updatedAt: nowIsoInstant(),
    viewerCanResolve: true,
    requester: {
      participantType: "actor",
      actorId: "00000000-0000-0000-0000-00000000000c",
      name: "tester",
    },
    runtimeAuthorization: {
      requestedToolName: "cua_click",
      runtimeToolStableKey: "cua/click",
      requestedAction: {
        capability: "cua",
        toolName: "cua_click",
        summary: "click",
        detail: "x=10 y=10",
        cua: { access: "write" },
      },
      reason: "test",
      runtimeId: "00000000-0000-0000-0000-00000000000d",
      deviceDisplayName: "Test Device",
      runtimeCapabilityId: "00000000-0000-0000-0000-00000000000e",
      exposureId: "00000000-0000-0000-0000-00000000000f",
      exposureDisplayName: "CUA",
      grantOptions: [],
      availablePresets: [],
      requestMode: "background",
      sourceRetryNonce: overrides?.sourceRetryNonce,
    },
  } as TaskSummary
}

function makeUserInputSummary(): TaskSummary {
  return {
    kind: "user_input",
    id: "00000000-0000-0000-0000-00000000ff01",
    workspaceId: "00000000-0000-0000-0000-00000000000a",
    conversationId: "00000000-0000-0000-0000-00000000000b",
    lifecycleStatus: "input_required",
    revision: 1,
    createdAt: nowIsoInstant(),
    updatedAt: nowIsoInstant(),
    viewerCanResolve: true,
    requester: {
      participantType: "actor",
      actorId: "00000000-0000-0000-0000-00000000000c",
      name: "tester",
    },
    userInput: {
      title: "test input",
      questions: [
        {
          id: "question-1",
          type: "text",
          prompt: "say something",
          required: true,
        },
      ],
    },
  } as TaskSummary
}

// ─── pickPersistedRetryNonce ────────────────────────────────────────────────

test("pickPersistedRetryNonce returns the persisted nonce when the row has one", () => {
  const persisted = "nonce-from-row"
  const fresh = "nonce-from-caller"
  const task = makeRuntimeAuthSummary({ sourceRetryNonce: persisted })
  const got = pickPersistedRetryNonce(task, fresh)
  assert.equal(got, persisted)
})

test("pickPersistedRetryNonce falls back to the fresh nonce when the row has none", () => {
  // Legacy rows pre-dating the surfacing fix would arrive with
  // sourceRetryNonce undefined; the fresh nonce is the only thing the
  // caller has, so use it as a last resort. This branch must NOT happen on
  // a row created by our current writer (we always persist a nonce).
  const fresh = "nonce-from-caller"
  const task = makeRuntimeAuthSummary({ sourceRetryNonce: undefined })
  const got = pickPersistedRetryNonce(task, fresh)
  assert.equal(got, fresh)
})

test("pickPersistedRetryNonce returns the fresh nonce for non-runtime-authorization tasks", () => {
  // Defensive: the function is typed to accept any TaskSummary
  // because the caller hands it the result of getTaskSummary.
  // A user_input summary has no runtimeAuthorization.sourceRetryNonce, so
  // we must not crash and must not invent a value.
  const fresh = "nonce-from-caller"
  const got = pickPersistedRetryNonce(makeUserInputSummary(), fresh)
  assert.equal(got, fresh)
})

// ─── didInnerDedupeReuseRow ────────────────────────────────────────────────

test("didInnerDedupeReuseRow detects inner dedupe via nonce mismatch", () => {
  // The freshly-generated nonce the caller intended to write differs from
  // what the row actually holds → the row was reused by inner dedupe.
  const task = makeRuntimeAuthSummary({
    sourceRetryNonce: "nonce-already-on-row",
  })
  const got = didInnerDedupeReuseRow(task, "nonce-the-caller-generated")
  assert.equal(got, true)
})

test("didInnerDedupeReuseRow returns false when the row's nonce matches the fresh one", () => {
  // No mismatch means the row was newly created with our nonce; not a
  // reuse.
  const task = makeRuntimeAuthSummary({
    sourceRetryNonce: "matching-nonce",
  })
  const got = didInnerDedupeReuseRow(task, "matching-nonce")
  assert.equal(got, false)
})

test("didInnerDedupeReuseRow returns false when the row has no persisted nonce", () => {
  // Can't conclude anything without a persisted value. Default to "not
  // reused" so we don't lie about dedupe to the caller's audit metadata.
  const task = makeRuntimeAuthSummary({ sourceRetryNonce: undefined })
  const got = didInnerDedupeReuseRow(task, "anything")
  assert.equal(got, false)
})

test("didInnerDedupeReuseRow returns false for non-runtime-authorization tasks", () => {
  const got = didInnerDedupeReuseRow(makeUserInputSummary(), "anything")
  assert.equal(got, false)
})

// ─── orphan-task cleanup contract ──────────────────────────────────────────
//
// The reason didInnerDedupeReuseRow exists isn't just to pick the right
// retry_nonce: it's also the gate on whether the call site must cancel the
// just-created tool_call_task that the inner-dedupe path orphaned. The
// caller (requests.ts) reads the same helper to decide cancellation. These
// assertions document the gate so a future change can't accidentally
// weaken the contract from one side without the other tripping.
test("orphan-task cleanup gate fires on the same condition the helper detects", () => {
  // Scenario: caller created task T1 with fresh nonce N1, then
  // createRuntimeAuthorizationTaskRequest inner-deduped to an
  // existing row whose persisted nonce is N0. Helper must say "reused"
  // so the caller knows to cancel T1.
  const orphaningTask = makeRuntimeAuthSummary({
    sourceRetryNonce: "N0-already-on-row",
  })
  assert.equal(
    didInnerDedupeReuseRow(orphaningTask, "N1-fresh"),
    true,
    "must signal reuse so caller cancels the orphaned task"
  )

  // Conversely: when our nonce matches the row, the row was freshly
  // created by THIS call and our task T1 is the one bound to it. Helper
  // must say "not reused" so we leave T1 alone.
  const freshTask = makeRuntimeAuthSummary({
    sourceRetryNonce: "N1-fresh",
  })
  assert.equal(
    didInnerDedupeReuseRow(freshTask, "N1-fresh"),
    false,
    "must NOT signal reuse when the row is the one we just wrote — cancelling here would cancel our own task"
  )
})

test("concurrent INSERT race: conflict-winner is detected as reuse so orphan cleanup fires", () => {
  // Race scenario: callers A and B both pass the pre-INSERT dedupe lookup
  // (neither sees an existing row). A wins the INSERT with nonce N_A;
  // B's INSERT hits ON CONFLICT DO NOTHING (tasks/service.ts
  // insertTaskRequest) and returns null. B's
  // createRuntimeAuthorizationTaskRequest re-resolves the conflict
  // winner via resolveInsertConflictWinner and returns A's row.
  //
  // The returned row carries N_A, not B's freshly-generated N_B. The
  // existing didInnerDedupeReuseRow helper must therefore signal reuse
  // for B, so the orphan-task cleanup in requests.ts cancels the task B
  // created BEFORE the dedupe race resolved. Without this contract, B's
  // orphan tool_call_task would stay input_required forever and the
  // model would receive an authorization_task_id pointing to a task the
  // approval flow will never complete.
  const conflictWinnerRow = makeRuntimeAuthSummary({
    sourceRetryNonce: "N_A-from-winner",
  })
  assert.equal(
    didInnerDedupeReuseRow(conflictWinnerRow, "N_B-from-loser"),
    true,
    "race loser must treat the conflict winner as reuse so its orphan task gets cancelled"
  )
})
