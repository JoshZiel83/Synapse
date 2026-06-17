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
    workspace_id: "workspace-1",
    conversation_id: "conversation-1",
    session_id: null,
    remote_agent_run_id: null,
    conversation_item_id: null,
    kind: TASK_REQUEST_KIND.USER_INPUT,
    lifecycle_status: "input_required",
    outcome: null,
    revision: 1,
    prompt_payload: {
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
    plan_payload: {
      title: "Plan",
      planMarkdown: "Do it",
    },
    requested_tool_name: null,
    reason: null,
    request_mode: null,
    requested_action: null,
    grant_options: null,
    available_presets: null,
    source_request_args: null,
    source_runtime_session_id: null,
    source_retry_nonce: null,
    principal_subject_id: "subject-1",
    principal_scope_subject_id: null,
    principal_remote_agent_id: null,
    principal_subject_kind: null,
    resolution_payload: {},
    resolved_at: null,
    expires_at: null,
    created_at: now,
    updated_at: now,
    requester_participant_id: "requester-1",
    requester_workspace_member_id: "member-1",
    requester_actor_id: null,
    requester_remote_agent_id: null,
    target_actor_id: null,
    target_workspace_member_id: null,
    target_remote_agent_id: null,
    target_participant_id: null,
    resolved_by_actor_id: null,
    resolved_by_workspace_member_id: null,
    resolved_by_remote_agent_id: null,
    resolved_by_participant_id: null,
    device_capability_id: null,
    device_id: null,
    device_exposure_id: null,
    device_tool_stable_key: null,
    device_display_name: null,
    exposure_display_name: null,
    exposure_stable_key: null,
    requester_participant_type: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
    requester_name: "Requester",
    requester_title: null,
    requester_role: null,
    requester_actor_avatar_file_id: null,
    requester_user_avatar_file_id: null,
    requester_remote_agent_avatar_file_id: null,
    requester_avatar_emoji: null,
    target_participant_type: null,
    target_name: null,
    target_title: null,
    target_role: null,
    target_actor_avatar_file_id: null,
    target_user_avatar_file_id: null,
    target_remote_agent_avatar_file_id: null,
    target_avatar_emoji: null,
    resolved_by_participant_type: null,
    resolved_by_name: null,
    resolved_by_title: null,
    resolved_by_role: null,
    resolved_by_actor_avatar_file_id: null,
    resolved_by_user_avatar_file_id: null,
    resolved_by_remote_agent_avatar_file_id: null,
    resolved_by_avatar_emoji: null,
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
    memberId: member.id as string,
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
    prompt_payload: JSON.stringify({
      title: "Need input",
      questions: [{ id: "q1" }],
    }),
  })

  assert.equal(payload.title, "Need input")
  assert.deepEqual(payload.questions, [{ id: "q1" }])
})

test("decodeTaskResolutionPayload accepts object payloads without shape loss", () => {
  const payload = decodeTaskResolutionPayload({
    resolution_payload: {
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
        prompt_payload: "[malformed",
      }),
    /Task prompt_payload must be a valid JSON object/
  )

  assert.throws(
    () =>
      decodeTaskResolutionPayload({
        resolution_payload: JSON.stringify(["not", "an", "object"]),
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
      prompt_payload: JSON.stringify({
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
      plan_payload: JSON.stringify({
        title: "Plan",
        planMarkdown: "Do it",
      }),
      resolution_payload: JSON.stringify({
        answers: [{ questionId: "q1", text: "ok" }],
      }),
      requested_action: JSON.stringify({
        capability: "commandline",
        toolName: "shell",
        summary: "Run command",
        commandline: {
          executor: "bash",
          commandMatchType: "exact",
          commandText: "date",
        },
      }),
      grant_options: JSON.stringify(grantOptions),
      available_presets: JSON.stringify(["once"]),
      source_request_args: JSON.stringify({ command: "date" }),
    })
  )

  assert.equal(normalized.prompt_payload.title, "Need input")
  assert.deepEqual(normalized.resolution_payload.answers, [
    { questionId: "q1", text: "ok" },
  ])
  assert.deepEqual(normalized.requested_action, {
    capability: "commandline",
    toolName: "shell",
    summary: "Run command",
    commandline: {
      executor: "bash",
      commandMatchType: "exact",
      commandText: "date",
    },
  })
  assert.deepEqual(normalized.grant_options, grantOptions)
  assert.deepEqual(normalized.available_presets, ["once"])
  assert.deepEqual(normalized.source_request_args, { command: "date" })
})

test("normalizeTaskRow validates runtime authorization JSONB shape at repo exit", () => {
  assert.throws(
    () =>
      normalizeTaskRow(
        buildTaskDbRow({
          requested_action: JSON.stringify({
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
          grant_options: JSON.stringify([{ id: "once" }]),
        })
      ),
    /Task task-1 grant_options is invalid/
  )

  assert.throws(
    () =>
      normalizeTaskRow(
        buildTaskDbRow({
          available_presets: JSON.stringify(["not-a-preset"]),
        })
      ),
    /Task task-1 available_presets is invalid/
  )
})

test("normalizeTaskCommandRow decodes request and response payloads at repo exit", () => {
  const row = normalizeTaskCommandRow({
    id: "command-1",
    task_id: "task-1",
    command_id: "command-idempotency-1",
    base_revision: 2,
    outcome: "applied",
    request_payload: JSON.stringify({
      answers: [{ questionId: "q1", text: "ok" }],
    }),
    response_payload: JSON.stringify({
      outcome: "applied",
      task: { id: "task-1" },
    }),
    created_by_workspace_member_id: "member-1",
    created_at: now,
    updated_at: now,
  })

  assert.deepEqual(row.request_payload.answers, [
    { questionId: "q1", text: "ok" },
  ])
  assert.deepEqual(row.response_payload.task, { id: "task-1" })
})

test("presentTaskSummary consumes normalized task rows without JSON parsing", () => {
  const row = normalizeTaskRow(
    buildTaskDbRow({
      resolution_payload: JSON.stringify({
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
      lifecycle_status: "auth_required",
      requested_tool_name: "shell",
      device_tool_stable_key: "commandline.shell",
      reason: "Needs command access",
      request_mode: "blocking",
      requested_action: {
        capability: "commandline",
        toolName: "shell",
        summary: "Run command",
      },
      grant_options: [],
      available_presets: ["once"],
      source_request_args: {},
      device_id: "device-1",
      device_capability_id: "capability-1",
      device_exposure_id: "exposure-1",
      device_display_name: "Laptop",
      exposure_display_name: "Shell",
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

test("normalizeTaskRow re-snakes camelCase raw rows (CamelCasePlugin regression)", () => {
  // At runtime, runCompiledOn rows arrive camelCase because CamelCasePlugin's
  // transformResult rewrites raw / sql.compile result keys too. Feed the
  // camelCase shape the query actually returns and assert normalizeTaskRow
  // recovers the snake-cased fields (regression for the GET /actors-class
  // "Expected a valid Date" / undefined-payload 500s).
  const snake = buildTaskDbRow({
    prompt_payload: JSON.stringify({ title: "Need input", questions: [] }),
    resolution_payload: JSON.stringify({ answers: [] }),
  })
  // simulate CamelCasePlugin: camelCase every top-level key
  const camel: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(snake)) {
    camel[k.replace(/_([a-z])/g, (_m, c) => c.toUpperCase())] = v
  }

  const normalized = normalizeTaskRow(camel as unknown as typeof snake)

  assert.equal(normalized.id, "task-1")
  assert.equal(normalized.workspace_id, "workspace-1")
  assert.equal(normalized.conversation_id, "conversation-1")
  assert.equal(normalized.prompt_payload.title, "Need input")
  assert.ok(normalized.created_at instanceof Date)
  assert.ok(normalized.updated_at instanceof Date)
})
