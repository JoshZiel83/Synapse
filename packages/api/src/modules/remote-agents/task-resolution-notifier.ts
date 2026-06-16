import { CONVERSATION_PARTICIPANT_TYPE } from "@synapse/shared"
import { TaskSummarySchema } from "@synapse/shared/schemas"
import type { TaskSummary } from "@synapse/shared/types"
import type { RemoteAgentApiToDaemonMessage } from "./wire.js"

export type ReplayResolvedTaskTarget = {
  remoteAgentId: string
  activeTaskId: string
}

export type ReplayResolvedRemoteAgentTasksDeps = {
  hasMachineConnection: (machineId: string) => boolean
  loadReplayResolvedTaskTargets: (params: {
    machineId: string
    remoteAgentIds: string[]
  }) => Promise<ReplayResolvedTaskTarget[]>
  getTaskSummary: (taskId: string) => Promise<TaskSummary | null>
  sendToMachine: (
    machineId: string,
    message: RemoteAgentApiToDaemonMessage
  ) => boolean
}

export type NotifyRemoteAgentTaskResolvedDeps = {
  getTaskSummary: (taskId: string) => Promise<TaskSummary | null>
  loadActiveBindingMachineId: (remoteAgentId: string) => Promise<string | null>
  sendToMachine: (
    machineId: string,
    message: RemoteAgentApiToDaemonMessage
  ) => boolean
}

function taskAsWirePayload(task: TaskSummary): Record<string, unknown> {
  return TaskSummarySchema.parse(task) as unknown as Record<string, unknown>
}

export async function replayResolvedRemoteAgentTasksUseCase(
  params: {
    machineId: string
    remoteAgentIds: string[]
  },
  deps: ReplayResolvedRemoteAgentTasksDeps
): Promise<{ sent: number; skippedMissingTask: number }> {
  if (params.remoteAgentIds.length === 0) {
    return { sent: 0, skippedMissingTask: 0 }
  }
  if (!deps.hasMachineConnection(params.machineId)) {
    return { sent: 0, skippedMissingTask: 0 }
  }

  const rows = await deps.loadReplayResolvedTaskTargets({
    machineId: params.machineId,
    remoteAgentIds: params.remoteAgentIds,
  })
  let sent = 0
  let skippedMissingTask = 0
  for (const row of rows) {
    const task = await deps.getTaskSummary(row.activeTaskId)
    if (!task) {
      skippedMissingTask += 1
      continue
    }
    if (
      deps.sendToMachine(params.machineId, {
        type: "agent:task:resolved",
        remoteAgentId: row.remoteAgentId,
        taskId: row.activeTaskId,
        task: taskAsWirePayload(task),
      })
    ) {
      sent += 1
    }
  }
  return { sent, skippedMissingTask }
}

export async function notifyRemoteAgentTaskResolvedUseCase(
  taskId: string,
  deps: NotifyRemoteAgentTaskResolvedDeps
): Promise<boolean> {
  const task = await deps.getTaskSummary(taskId)
  if (
    !task ||
    task.requester?.participantType !==
      CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT ||
    !task.requester.remoteAgentId
  ) {
    return false
  }

  const taskPayload = taskAsWirePayload(task)
  const machineId = await deps.loadActiveBindingMachineId(
    task.requester.remoteAgentId
  )
  if (!machineId) {
    return false
  }
  return deps.sendToMachine(machineId, {
    type: "agent:task:resolved",
    remoteAgentId: task.requester.remoteAgentId,
    taskId,
    task: taskPayload,
  })
}
