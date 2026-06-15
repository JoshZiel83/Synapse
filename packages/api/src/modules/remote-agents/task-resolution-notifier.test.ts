import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { CONVERSATION_PARTICIPANT_TYPE } from "@synapse/shared"
import type { TaskSummary } from "@synapse/shared/types"
import type { RemoteAgentApiToDaemonMessage } from "./wire.js"
import {
  notifyRemoteAgentTaskResolvedUseCase,
  replayResolvedRemoteAgentTasksUseCase,
  type NotifyRemoteAgentTaskResolvedDeps,
  type ReplayResolvedRemoteAgentTasksDeps,
} from "./task-resolution-notifier.js"

function taskSummary(values: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: randomUUID(),
    workspaceId: randomUUID(),
    conversationId: randomUUID(),
    kind: "user_input",
    lifecycleStatus: "completed",
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    viewerCanResolve: false,
    userInput: {
      title: "Need input",
      questions: [],
    },
    ...values,
  } as TaskSummary
}

function deps(params: {
  hasConnection?: boolean
  targets?: Array<{ remoteAgentId: string; activeTaskId: string }>
  tasksById?: Map<string, TaskSummary>
  machineId?: string | null
  sent?: Array<{ machineId: string; message: RemoteAgentApiToDaemonMessage }>
  loadTargetCalls?: string[]
}): ReplayResolvedRemoteAgentTasksDeps & NotifyRemoteAgentTaskResolvedDeps {
  return {
    hasMachineConnection: () => params.hasConnection ?? true,
    loadReplayResolvedTaskTargets: async ({ machineId }) => {
      params.loadTargetCalls?.push(machineId)
      return params.targets ?? []
    },
    getTaskSummary: async (taskId) => params.tasksById?.get(taskId) ?? null,
    loadActiveBindingMachineId: async () => params.machineId ?? null,
    sendToMachine: (machineId, message) => {
      params.sent?.push({ machineId, message })
      return true
    },
  }
}

test("replayResolvedRemoteAgentTasksUseCase sends resolved task frames and skips missing summaries", async () => {
  const machineId = randomUUID()
  const remoteAgentId = randomUUID()
  const task = taskSummary()
  const sent: Array<{
    machineId: string
    message: RemoteAgentApiToDaemonMessage
  }> = []

  const result = await replayResolvedRemoteAgentTasksUseCase(
    {
      machineId,
      remoteAgentIds: [remoteAgentId],
    },
    deps({
      targets: [
        { remoteAgentId, activeTaskId: task.id },
        { remoteAgentId, activeTaskId: randomUUID() },
      ],
      tasksById: new Map([[task.id, task]]),
      sent,
    })
  )

  assert.deepEqual(result, { sent: 1, skippedMissingTask: 1 })
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.machineId, machineId)
  assert.deepEqual(sent[0]!.message, {
    type: "agent:task:resolved",
    remoteAgentId,
    taskId: task.id,
    task: task as unknown as Record<string, unknown>,
  })
})

test("replayResolvedRemoteAgentTasksUseCase does not load targets without ids or connection", async () => {
  const loadTargetCalls: string[] = []
  const withoutIds = await replayResolvedRemoteAgentTasksUseCase(
    {
      machineId: randomUUID(),
      remoteAgentIds: [],
    },
    deps({ loadTargetCalls })
  )
  assert.deepEqual(withoutIds, { sent: 0, skippedMissingTask: 0 })

  const withoutConnection = await replayResolvedRemoteAgentTasksUseCase(
    {
      machineId: randomUUID(),
      remoteAgentIds: [randomUUID()],
    },
    deps({ hasConnection: false, loadTargetCalls })
  )
  assert.deepEqual(withoutConnection, { sent: 0, skippedMissingTask: 0 })
  assert.deepEqual(loadTargetCalls, [])
})

test("notifyRemoteAgentTaskResolvedUseCase sends only remote-agent-requested tasks with an active machine", async () => {
  const remoteAgentId = randomUUID()
  const machineId = randomUUID()
  const task = taskSummary({
    requester: {
      participantType: CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT,
      remoteAgentId,
    },
  })
  const sent: Array<{
    machineId: string
    message: RemoteAgentApiToDaemonMessage
  }> = []

  const result = await notifyRemoteAgentTaskResolvedUseCase(
    task.id,
    deps({
      tasksById: new Map([[task.id, task]]),
      machineId,
      sent,
    })
  )

  assert.equal(result, true)
  assert.deepEqual(sent, [
    {
      machineId,
      message: {
        type: "agent:task:resolved",
        remoteAgentId,
        taskId: task.id,
        task: task as unknown as Record<string, unknown>,
      },
    },
  ])

  const workspaceMemberTask = taskSummary({
    requester: {
      participantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
      workspaceMemberId: randomUUID(),
    },
  })
  assert.equal(
    await notifyRemoteAgentTaskResolvedUseCase(
      workspaceMemberTask.id,
      deps({
        tasksById: new Map([[workspaceMemberTask.id, workspaceMemberTask]]),
        machineId,
        sent,
      })
    ),
    false
  )

  const noMachineTask = taskSummary({
    requester: {
      participantType: CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT,
      remoteAgentId,
    },
  })
  assert.equal(
    await notifyRemoteAgentTaskResolvedUseCase(
      noMachineTask.id,
      deps({
        tasksById: new Map([[noMachineTask.id, noMachineTask]]),
        machineId: null,
        sent,
      })
    ),
    false
  )
  assert.equal(sent.length, 1)
})
