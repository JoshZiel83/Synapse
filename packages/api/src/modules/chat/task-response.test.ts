import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { ChatTaskResolveInput, TaskSummary } from "@synapse/shared/types"
import type {
  ResolveTaskRequestParams,
  ResolveTaskRequestResult,
} from "../tasks/service.js"
import {
  respondToChatTaskUseCase,
  type RespondToChatTaskDeps,
} from "./task-response.js"

function taskSummary(values: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: randomUUID(),
    workspaceId: randomUUID(),
    conversationId: randomUUID(),
    itemId: randomUUID(),
    kind: "user_input",
    lifecycleStatus: "auth_required",
    revision: 1,
    ...values,
  } as TaskSummary
}

function userInputResolveInput(
  values: Partial<ChatTaskResolveInput> = {}
): ChatTaskResolveInput {
  return {
    commandId: randomUUID(),
    baseRevision: 1,
    answers: [{ questionId: "q1", text: "answer" }],
    ...values,
  } as ChatTaskResolveInput
}

function deps(params: {
  task?: TaskSummary | null
  canView?: boolean
  participantId?: string | null
  resolveResult?: ResolveTaskRequestResult
  resolveError?: Error
  enrichedTask?: TaskSummary
  resolveCalls?: ResolveTaskRequestParams[]
}): RespondToChatTaskDeps {
  return {
    getTaskSummary: async () => params.task ?? null,
    canUserViewTask: async () => params.canView ?? true,
    getConversationParticipant: async () =>
      params.participantId === null
        ? null
        : { id: params.participantId ?? randomUUID() },
    resolveTaskRequest: async (input) => {
      params.resolveCalls?.push(input)
      if (params.resolveError) {
        throw params.resolveError
      }
      if (!params.resolveResult) {
        throw new Error("missing resolve result")
      }
      return params.resolveResult
    },
    enrichTaskForUser: async () => params.enrichedTask ?? params.task!,
  }
}

test("respondToChatTaskUseCase resolves task input and enriches the response task", async () => {
  const task = taskSummary()
  const enrichedTask = taskSummary({
    id: task.id,
    workspaceId: task.workspaceId,
    conversationId: task.conversationId,
    lifecycleStatus: "completed",
  })
  const resolveCalls: ResolveTaskRequestParams[] = []
  const participantId = randomUUID()
  const input = userInputResolveInput({ note: "done" })

  const result = await respondToChatTaskUseCase(
    {
      workspaceId: task.workspaceId,
      conversationId: task.conversationId,
      taskId: task.id,
      workspaceMemberId: randomUUID(),
      userId: randomUUID(),
      input,
    },
    deps({
      task,
      participantId,
      enrichedTask,
      resolveCalls,
      resolveResult: {
        outcome: "applied",
        task,
      },
    })
  )

  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.body, {
    outcome: "applied",
    task: enrichedTask,
  })
  assert.equal(resolveCalls.length, 1)
  assert.equal(resolveCalls[0]!.taskId, task.id)
  assert.equal(resolveCalls[0]!.resolverParticipantId, participantId)
  assert.deepEqual(resolveCalls[0]!.answers, input.answers)
  assert.equal(resolveCalls[0]!.note, "done")
})

test("respondToChatTaskUseCase returns not found for missing or mismatched tasks", async () => {
  const result = await respondToChatTaskUseCase(
    {
      workspaceId: randomUUID(),
      conversationId: randomUUID(),
      taskId: randomUUID(),
      workspaceMemberId: randomUUID(),
      userId: randomUUID(),
      input: userInputResolveInput(),
    },
    deps({ task: null })
  )

  assert.deepEqual(result, {
    statusCode: 404,
    body: {
      error: "Task not found",
      code: "task_not_found",
    },
  })
})

test("respondToChatTaskUseCase returns access errors before resolving", async () => {
  const task = taskSummary()

  const cannotView = await respondToChatTaskUseCase(
    {
      workspaceId: task.workspaceId,
      conversationId: task.conversationId,
      taskId: task.id,
      workspaceMemberId: randomUUID(),
      userId: randomUUID(),
      input: userInputResolveInput(),
    },
    deps({ task, canView: false })
  )
  assert.deepEqual(cannotView, {
    statusCode: 403,
    body: {
      error: "You cannot access this task",
      code: "task_access_denied",
    },
  })

  const notParticipant = await respondToChatTaskUseCase(
    {
      workspaceId: task.workspaceId,
      conversationId: task.conversationId,
      taskId: task.id,
      workspaceMemberId: randomUUID(),
      userId: randomUUID(),
      input: userInputResolveInput(),
    },
    deps({ task, participantId: null })
  )
  assert.deepEqual(notParticipant, {
    statusCode: 403,
    body: {
      error: "You are not an active participant in this conversation",
      code: "task_resolver_not_participant",
    },
  })
})

test("respondToChatTaskUseCase maps conflict and resolution failures", async () => {
  const task = taskSummary()
  const enrichedTask = taskSummary({
    id: task.id,
    workspaceId: task.workspaceId,
    conversationId: task.conversationId,
  })
  const conflict = await respondToChatTaskUseCase(
    {
      workspaceId: task.workspaceId,
      conversationId: task.conversationId,
      taskId: task.id,
      workspaceMemberId: randomUUID(),
      userId: randomUUID(),
      input: userInputResolveInput(),
    },
    deps({
      task,
      enrichedTask,
      resolveResult: {
        outcome: "conflict",
        task,
      },
    })
  )

  assert.deepEqual(conflict, {
    statusCode: 409,
    body: {
      error: "Task state changed before this submission was applied",
      code: "task_conflict",
      outcome: "conflict",
      task: enrichedTask,
    },
  })

  const failed = await respondToChatTaskUseCase(
    {
      workspaceId: task.workspaceId,
      conversationId: task.conversationId,
      taskId: task.id,
      workspaceMemberId: randomUUID(),
      userId: randomUUID(),
      input: userInputResolveInput(),
    },
    deps({
      task,
      resolveError: new Error("bad resolution"),
    })
  )

  assert.deepEqual(failed, {
    statusCode: 400,
    body: {
      error: "bad resolution",
      code: "task_resolution_failed",
    },
  })
})
