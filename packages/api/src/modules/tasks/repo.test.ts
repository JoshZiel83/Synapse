import assert from "node:assert/strict"
import crypto from "node:crypto"
import test from "node:test"
import {
  CONVERSATION_KIND,
  CONVERSATION_PARTICIPANT_TYPE,
  INVITE_TRUST_LEVELS,
  SUBJECT_KIND,
  TASK_REQUEST_KIND,
} from "@synapse/shared"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { presentTaskSummary } from "./presenter.js"
import {
  decodeActionTokenPayload,
  decodeTaskPromptPayload,
  decodeTaskResolutionPayload,
  normalizeTaskCommandRow,
  normalizeTaskRow,
  upsertTaskTransportProjection,
} from "./repo.js"
import type { RawTaskDbRow } from "./repo.types.js"

const now = new Date("2026-01-01T00:00:00.000Z")

type AnyDb = import("kysely").Kysely<any>

function buildTaskDbRow(overrides: Partial<RawTaskDbRow> = {}): RawTaskDbRow {
  return {
    id: "task-1",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    sessionId: null,
    remoteAgentRunId: null,
    conversationItemId: null,
    kind: TASK_REQUEST_KIND.USER_INPUT,
    lifecycleStatus: "input_required",
    outcome: null,
    revision: 1,
    promptPayload: {
      title: "Need input",
      questions: [
        {
          id: "q1",
          type: "text",
          header: "Question",
          prompt: "What should happen?",
          required: true,
          secret: false,
        },
      ],
    },
    planPayload: {
      title: "Plan",
      planMarkdown: "Do it",
    },
    requestedToolName: null,
    reason: null,
    requestMode: null,
    requestedAction: null,
    grantOptions: null,
    availablePresets: null,
    sourceRequestArgs: null,
    sourceRuntimeSessionId: null,
    sourceRetryNonce: null,
    principalSubjectId: "subject-1",
    principalScopeSubjectId: null,
    principalRemoteAgentId: null,
    principalSubjectKind: null,
    resolutionPayload: {},
    resolvedAt: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    requesterParticipantId: "requester-1",
    requesterWorkspaceMemberId: "member-1",
    requesterActorId: null,
    requesterRemoteAgentId: null,
    targetActorId: null,
    targetWorkspaceMemberId: null,
    targetRemoteAgentId: null,
    targetParticipantId: null,
    resolvedByActorId: null,
    resolvedByWorkspaceMemberId: null,
    resolvedByRemoteAgentId: null,
    resolvedByParticipantId: null,
    deviceCapabilityId: null,
    deviceId: null,
    deviceExposureId: null,
    deviceToolStableKey: null,
    deviceDisplayName: null,
    exposureDisplayName: null,
    exposureStableKey: null,
    requesterParticipantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
    requesterName: "Requester",
    requesterTitle: null,
    requesterRole: null,
    requesterActorAvatarFileId: null,
    requesterUserAvatarFileId: null,
    requesterRemoteAgentAvatarFileId: null,
    requesterAvatarEmoji: null,
    targetParticipantType: null,
    targetName: null,
    targetTitle: null,
    targetRole: null,
    targetActorAvatarFileId: null,
    targetUserAvatarFileId: null,
    targetRemoteAgentAvatarFileId: null,
    targetAvatarEmoji: null,
    resolvedByParticipantType: null,
    resolvedByName: null,
    resolvedByTitle: null,
    resolvedByRole: null,
    resolvedByActorAvatarFileId: null,
    resolvedByUserAvatarFileId: null,
    resolvedByRemoteAgentAvatarFileId: null,
    resolvedByAvatarEmoji: null,
    ...overrides,
  }
}

async function insertTaskTransportProjectionFixture(db: AnyDb) {
  const user = await db
    .insertInto("users")
    .values({
      email: `task-projection-${crypto.randomUUID()}@example.test`,
      name: "task projection test user",
    })
    .returning("id")
    .executeTakeFirstOrThrow()

  const workspace = await db
    .insertInto("workspaces")
    .values({
      ownerId: user.id,
      slug: `task-projection-${crypto.randomUUID()}`,
      name: "task projection test workspace",
    })
    .returning("id")
    .executeTakeFirstOrThrow()

  const member = await db
    .insertInto("workspaceMembers")
    .values({
      workspaceId: workspace.id,
      userId: user.id,
      trustLevel: INVITE_TRUST_LEVELS[1],
    })
    .returning("id")
    .executeTakeFirstOrThrow()

  const conversation = await db
    .insertInto("conversations")
    .values({
      workspaceId: workspace.id,
      kind: CONVERSATION_KIND.GROUP,
      title: "task projection test conversation",
    })
    .returning("id")
    .executeTakeFirstOrThrow()

  const subjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    workspaceMemberId: member.id as string,
  })

  const task = await db
    .insertInto("toolCallTasks")
    .values({
      workspaceId: workspace.id,
      conversationId: conversation.id,
      executorKind: TASK_REQUEST_KIND.USER_INPUT,
      deliveryKind: "none",
      humanSurface: "needs_response",
      principalSubjectId: subjectId,
      sourceToolName: "task_projection_test",
      lifecycleStatus: "input_required",
      requestKey: `task-projection-${crypto.randomUUID()}`,
      requestPayload: JSON.stringify({ title: "Need input" }),
      immediateResultPayload: JSON.stringify({}),
      finalResultPayload: JSON.stringify({}),
      finalErrorPayload: JSON.stringify({}),
      metadata: JSON.stringify({}),
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()

  return {
    taskId: task.id as string,
    workspaceId: workspace.id as string,
    conversationId: conversation.id as string,
  }
}

test("decodeTaskPromptPayload decodes JSONB string payloads at repo exit", () => {
  const payload = decodeTaskPromptPayload({
    promptPayload: JSON.stringify({
      title: "Need input",
      questions: [{ id: "q1" }],
    }),
  })

  assert.equal(payload.title, "Need input")
  assert.deepEqual(payload.questions, [{ id: "q1" }])
})

test("decodeTaskResolutionPayload accepts object payloads without shape loss", () => {
  const payload = decodeTaskResolutionPayload({
    resolutionPayload: {
      note: "cancelled",
      answers: [{ questionId: "q1", text: "ok" }],
    },
  })

  assert.equal(payload.note, "cancelled")
  assert.deepEqual(payload.answers, [{ questionId: "q1", text: "ok" }])
})

test("task payload decoders reject non-object JSON at repo exit", () => {
  assert.throws(
    () =>
      decodeTaskPromptPayload({
        promptPayload: "[malformed",
      }),
    /Task prompt_payload must be a valid JSON object/
  )

  assert.throws(
    () =>
      decodeTaskResolutionPayload({
        resolutionPayload: JSON.stringify(["not", "an", "object"]),
      }),
    /Task resolution_payload must be a JSON object/
  )
})

test("decodeActionTokenPayload validates task action token business payloads", () => {
  assert.deepEqual(
    decodeActionTokenPayload({
      payload: JSON.stringify({
        decision: "approve",
        preset: "once",
        selectedGrantOptionId: "primary",
      }),
    }),
    {
      decision: "approve",
      preset: "once",
      selectedGrantOptionId: "primary",
    }
  )

  assert.throws(
    () => decodeActionTokenPayload({ token: "token-1", payload: "{}" }),
    /Action token token-1 payload is invalid/
  )

  assert.throws(
    () =>
      decodeActionTokenPayload({
        token: "token-1",
        payload: JSON.stringify(["not", "an", "object"]),
      }),
    /Action token token-1 payload must be a JSON object/
  )
})

test("normalizeTaskRow decodes task summary JSONB fields at repo exit", () => {
  const grantOptions = [
    {
      id: "once",
      summary: "Allow once",
      grantSpec: {
        capability: "commandline",
        commandline: {
          executor: "bash",
          commandMatchType: "exact",
          commandText: "date",
        },
      },
    },
  ]
  const normalized = normalizeTaskRow(
    buildTaskDbRow({
      promptPayload: JSON.stringify({
        title: "Need input",
        questions: [
          {
            id: "q1",
            type: "text",
            header: "Question",
            prompt: "What should happen?",
            required: true,
            secret: false,
          },
        ],
      }),
      planPayload: JSON.stringify({
        title: "Plan",
        planMarkdown: "Do it",
      }),
      resolutionPayload: JSON.stringify({
        answers: [{ questionId: "q1", text: "ok" }],
      }),
      requestedAction: JSON.stringify({
        capability: "commandline",
        toolName: "shell",
        summary: "Run command",
        commandline: {
          executor: "bash",
          commandMatchType: "exact",
          commandText: "date",
        },
      }),
      grantOptions: JSON.stringify(grantOptions),
      availablePresets: JSON.stringify(["once"]),
      sourceRequestArgs: JSON.stringify({ command: "date" }),
    })
  )

  assert.equal(normalized.promptPayload.title, "Need input")
  assert.deepEqual(normalized.resolutionPayload.answers, [
    { questionId: "q1", text: "ok" },
  ])
  assert.deepEqual(normalized.requestedAction, {
    capability: "commandline",
    toolName: "shell",
    summary: "Run command",
    commandline: {
      executor: "bash",
      commandMatchType: "exact",
      commandText: "date",
    },
  })
  assert.deepEqual(normalized.grantOptions, grantOptions)
  assert.deepEqual(normalized.availablePresets, ["once"])
  assert.deepEqual(normalized.sourceRequestArgs, { command: "date" })
})

test("normalizeTaskRow validates runtime authorization JSONB shape at repo exit", () => {
  assert.throws(
    () =>
      normalizeTaskRow(
        buildTaskDbRow({
          requestedAction: JSON.stringify({
            capability: "commandline",
            toolName: "shell",
          }),
        })
      ),
    /Task task-1 requested_action is invalid/
  )

  assert.throws(
    () =>
      normalizeTaskRow(
        buildTaskDbRow({
          grantOptions: JSON.stringify([{ id: "once" }]),
        })
      ),
    /Task task-1 grant_options is invalid/
  )

  assert.throws(
    () =>
      normalizeTaskRow(
        buildTaskDbRow({
          availablePresets: JSON.stringify(["not-a-preset"]),
        })
      ),
    /Task task-1 available_presets is invalid/
  )
})

test("normalizeTaskCommandRow decodes request and response payloads at repo exit", () => {
  const row = normalizeTaskCommandRow({
    id: "command-1",
    taskId: "task-1",
    commandId: "command-idempotency-1",
    baseRevision: 2,
    outcome: "applied",
    requestPayload: JSON.stringify({
      answers: [{ questionId: "q1", text: "ok" }],
    }),
    responsePayload: JSON.stringify({
      outcome: "applied",
      task: { id: "task-1" },
    }),
    createdByWorkspaceMemberId: "member-1",
    createdAt: now,
    updatedAt: now,
  })

  assert.deepEqual(row.requestPayload.answers, [
    { questionId: "q1", text: "ok" },
  ])
  assert.deepEqual(row.responsePayload.task, { id: "task-1" })
})

test("presentTaskSummary consumes normalized task rows without JSON parsing", () => {
  const row = normalizeTaskRow(
    buildTaskDbRow({
      resolutionPayload: JSON.stringify({
        answers: [{ questionId: "q1", text: "ok" }],
      }),
    })
  )
  const summary = presentTaskSummary(row)

  assert.equal(summary.kind, TASK_REQUEST_KIND.USER_INPUT)
  if (summary.kind !== TASK_REQUEST_KIND.USER_INPUT) {
    throw new Error("Expected user input task summary")
  }
  assert.equal(summary.userInput.title, "Need input")
  assert.equal(summary.userInput.questions[0]?.answer?.text, "ok")
})

function runtimeAuthorizationTaskRow(
  overrides: Partial<RawTaskDbRow> = {}
): ReturnType<typeof normalizeTaskRow> {
  return normalizeTaskRow(
    buildTaskDbRow({
      kind: TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      lifecycleStatus: "auth_required",
      requestedToolName: "shell",
      deviceToolStableKey: "commandline.shell",
      reason: "Needs command access",
      requestMode: "blocking",
      requestedAction: {
        capability: "commandline",
        toolName: "shell",
        summary: "Run command",
      },
      grantOptions: [],
      availablePresets: ["once"],
      sourceRequestArgs: {},
      deviceId: "device-1",
      deviceCapabilityId: "capability-1",
      deviceExposureId: "exposure-1",
      deviceDisplayName: "Laptop",
      exposureDisplayName: "Shell",
      ...overrides,
    })
  )
}

test("presentTaskSummary consumes repo-validated runtime authorization requested action", () => {
  const summary = presentTaskSummary(runtimeAuthorizationTaskRow())

  assert.equal(summary.kind, TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION)
  if (summary.kind !== TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION) {
    throw new Error("Expected runtime authorization task summary")
  }
  assert.deepEqual(summary.runtimeAuthorization.requestedAction, {
    capability: "commandline",
    toolName: "shell",
    summary: "Run command",
  })
})

test(
  "upsertTaskTransportProjection inserts and re-arms recoverable skipped projections",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const fixture = await insertTaskTransportProjectionFixture(db)

      await upsertTaskTransportProjection(db, fixture)
      const inserted = await db
        .selectFrom("toolCallTaskTransportProjections")
        .select(["taskId", "workspaceId", "conversationId", "status", "error"])
        .where("taskId", "=", fixture.taskId)
        .executeTakeFirstOrThrow()

      assert.equal(inserted.workspaceId, fixture.workspaceId)
      assert.equal(inserted.conversationId, fixture.conversationId)
      assert.equal(inserted.status, "pending")
      assert.equal(inserted.error, null)

      await db
        .updateTable("toolCallTaskTransportProjections")
        .set({
          status: "skipped",
          error: "no_binding",
          attempts: 3,
        })
        .where("taskId", "=", fixture.taskId)
        .execute()

      await upsertTaskTransportProjection(db, fixture)
      const rearmed = await db
        .selectFrom("toolCallTaskTransportProjections")
        .select(["status", "error", "attempts"])
        .where("taskId", "=", fixture.taskId)
        .executeTakeFirstOrThrow()

      assert.equal(rearmed.status, "pending")
      assert.equal(rearmed.error, null)
      assert.equal(rearmed.attempts, 0)

      await db
        .updateTable("toolCallTaskTransportProjections")
        .set({
          status: "skipped",
          error: "not_supported_in_v1",
          attempts: 4,
        })
        .where("taskId", "=", fixture.taskId)
        .execute()

      await upsertTaskTransportProjection(db, fixture)
      const unchanged = await db
        .selectFrom("toolCallTaskTransportProjections")
        .select(["status", "error", "attempts"])
        .where("taskId", "=", fixture.taskId)
        .executeTakeFirstOrThrow()

      assert.equal(unchanged.status, "skipped")
      assert.equal(unchanged.error, "not_supported_in_v1")
      assert.equal(unchanged.attempts, 4)
    })
  }
)

test("normalizeTaskRow consumes camelCase raw rows (CamelCasePlugin contract)", () => {
  // At runtime, runCompiledOn rows arrive camelCase because CamelCasePlugin's
  // transformResult rewrites raw / sql.compile result keys too (convention A:
  // the join's double-quoted camelCase aliases + bare physical columns both
  // surface as camelCase keys). Feed the camelCase shape the query actually
  // returns and assert normalizeTaskRow reads it directly — no re-snake —
  // keeping Date values and decoding JSONB payloads (regression for the
  // GET /actors-class "Expected a valid Date" / undefined-payload 500s).
  const row = buildTaskDbRow({
    promptPayload: JSON.stringify({ title: "Need input", questions: [] }),
    resolutionPayload: JSON.stringify({ answers: [] }),
  })

  const normalized = normalizeTaskRow(row)

  assert.equal(normalized.id, "task-1")
  assert.equal(normalized.workspaceId, "workspace-1")
  assert.equal(normalized.conversationId, "conversation-1")
  assert.equal(normalized.promptPayload.title, "Need input")
  assert.ok(normalized.createdAt instanceof Date)
  assert.ok(normalized.updatedAt instanceof Date)
})
