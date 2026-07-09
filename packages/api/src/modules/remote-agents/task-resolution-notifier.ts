import { CONVERSATION_PARTICIPANT_TYPE } from "@synapse/shared"
import { TaskSummarySchema } from "@synapse/shared/schemas"
import type { TaskSummary } from "@synapse/shared/types"
import type { RemoteAgentApiToDaemonMessage } from "./wire.js"
import { activeTraceparent } from "../../infrastructure/observability/traceparent.js"

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

function isRecordPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function taskAsWirePayload(task: TaskSummary): Record<string, unknown> {
  const payload: unknown = TaskSummarySchema.parse(task)
  if (!isRecordPayload(payload)) {
    throw new Error("Task summary wire payload must be an object")
  }
  return payload
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
        // KNOWN LIMITATION: this is the reconnect REPLAY path (driven by the
        // daemon `ready` handler, no request span), so activeTraceparent() is
        // undefined and the replayed resolution is NOT trace-correlated. Unlike
        // deliveries (which persist origin_traceparent to survive reconnect),
        // resolved tasks have no persisted trace column — correlating the replay
        // leg would need a traceparent column on the task's resolved state.
        // Deferred as observability-only; the LIVE resolution path below IS
        // correlated.
        traceparent: activeTraceparent(),
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
    // Live path: runs under the resolving request's span (e.g. a user-input
    // reply), so the daemon's continued turn rejoins the resolver's trace.
    traceparent: activeTraceparent(),
  })
}
