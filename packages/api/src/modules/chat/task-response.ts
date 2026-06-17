import type {
  ChatTaskResolveInput,
  ChatTaskResolveOutcome,
  TaskSummary,
} from "@synapse/shared/types"
import {
  canUserViewTask,
  enrichTaskForUser,
  getTaskSummary,
  resolveTaskRequest,
  type ResolveTaskRequestParams,
  type ResolveTaskRequestResult,
} from "../tasks/service.js"
import { getConversationParticipantUseCase as getConversationParticipant } from "./participant-roster.js"

type TaskResponseSuccessBody = {
  outcome: ChatTaskResolveOutcome
  task: TaskSummary
}

type TaskResponseErrorBody =
  | { error: string; code: "task_not_found" }
  | { error: string; code: "task_access_denied" }
  | { error: string; code: "task_resolver_not_participant" }
  | {
      error: string
      code: "task_conflict"
      outcome: "conflict"
      task: TaskSummary
    }
  | { error: string; code: "task_resolution_failed" }

export type ChatTaskResponseResult =
  | { statusCode: 200; body: TaskResponseSuccessBody }
  | { statusCode: 400 | 403 | 404 | 409; body: TaskResponseErrorBody }

export type RespondToChatTaskInput = {
  workspaceId: string
  conversationId: string
  taskId: string
  workspaceMemberId: string
  userId: string
  input: ChatTaskResolveInput
}

export type RespondToChatTaskDeps = {
  getTaskSummary: (taskId: string) => Promise<TaskSummary | null>
  canUserViewTask: (params: {
    taskId: string
    userId: string
  }) => Promise<boolean>
  getConversationParticipant: (params: {
    conversationId: string
    workspaceMemberId: string
  }) => Promise<{ id?: string | null } | null>
  resolveTaskRequest: (
    params: ResolveTaskRequestParams
  ) => Promise<ResolveTaskRequestResult>
  enrichTaskForUser: (task: TaskSummary, userId: string) => Promise<TaskSummary>
}

function buildResolveTaskRequestParams(params: {
  task: TaskSummary
  workspaceMemberId: string
  participantId: string
  input: ChatTaskResolveInput
}): ResolveTaskRequestParams {
  return {
    ...params.input,
    taskId: params.task.id,
    resolverWorkspaceMemberId: params.workspaceMemberId,
    resolverParticipantId: params.participantId,
  }
}

export async function respondToChatTaskUseCase(
  params: RespondToChatTaskInput,
  deps: RespondToChatTaskDeps
): Promise<ChatTaskResponseResult> {
  const task = await deps.getTaskSummary(params.taskId)
  if (
    !task ||
    task.workspaceId !== params.workspaceId ||
    task.conversationId !== params.conversationId
  ) {
    return {
      statusCode: 404,
      body: {
        error: "Task not found",
        code: "task_not_found",
      },
    }
  }

  const canView = await deps.canUserViewTask({
    taskId: task.id,
    userId: params.userId,
  })
  if (!canView) {
    return {
      statusCode: 403,
      body: {
        error: "You cannot access this task",
        code: "task_access_denied",
      },
    }
  }

  const resolverParticipant = await deps.getConversationParticipant({
    conversationId: params.conversationId,
    workspaceMemberId: params.workspaceMemberId,
  })
  if (!resolverParticipant?.id) {
    return {
      statusCode: 403,
      body: {
        error: "You are not an active participant in this conversation",
        code: "task_resolver_not_participant",
      },
    }
  }

  try {
    const result = await deps.resolveTaskRequest(
      buildResolveTaskRequestParams({
        task,
        workspaceMemberId: params.workspaceMemberId,
        participantId: resolverParticipant.id,
        input: params.input,
      })
    )
    const taskForViewer = await deps.enrichTaskForUser(
      result.task,
      params.userId
    )
    if (result.outcome === "conflict") {
      return {
        statusCode: 409,
        body: {
          error: "Task state changed before this submission was applied",
          code: "task_conflict",
          outcome: result.outcome,
          task: taskForViewer,
        },
      }
    }
    return {
      statusCode: 200,
      body: {
        outcome: result.outcome,
        task: taskForViewer,
      },
    }
  } catch (error) {
    return {
      statusCode: 400,
      body: {
        error:
          error instanceof Error ? error.message : "Failed to resolve task",
        code: "task_resolution_failed",
      },
    }
  }
}

export async function respondToChatTask(
  params: RespondToChatTaskInput
): Promise<ChatTaskResponseResult> {
  return respondToChatTaskUseCase(params, {
    getTaskSummary,
    canUserViewTask,
    getConversationParticipant,
    resolveTaskRequest,
    enrichTaskForUser,
  })
}
