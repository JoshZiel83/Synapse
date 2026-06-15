import assert from "node:assert/strict"
import test from "node:test"
import {
  CONVERSATION_PARTICIPANT_TYPE,
  TASK_REQUEST_KIND,
} from "@synapse/shared"
import { presentTaskSummary } from "./presenter.js"
import {
  decodeTaskPromptPayload,
  decodeTaskResolutionPayload,
  normalizeTaskCommandRow,
  normalizeTaskRow,
} from "./repo.js"
import type { RawTaskDbRow } from "./repo.types.js"

const now = new Date("2026-01-01T00:00:00.000Z")

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

test("decodeTaskResolutionPayload normalizes non-object JSON to an empty object", () => {
  assert.deepEqual(
    decodeTaskResolutionPayload({
      resolution_payload: JSON.stringify(["not", "an", "object"]),
    }),
    {}
  )
})

test("normalizeTaskRow decodes task summary JSONB fields at repo exit", () => {
  const grantOptions = [
    {
      id: "once",
      summary: "Allow once",
      grantSpec: { retention: "single_use" },
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
  })
  assert.deepEqual(normalized.grant_options, grantOptions)
  assert.deepEqual(normalized.available_presets, ["once"])
  assert.deepEqual(normalized.source_request_args, { command: "date" })
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
