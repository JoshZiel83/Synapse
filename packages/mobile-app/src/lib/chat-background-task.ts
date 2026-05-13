import * as BackgroundTask from "expo-background-task"
import { Platform } from "react-native"
import * as TaskManager from "expo-task-manager"

import { getApiAuthToken, setApiAuthToken } from "@/lib/api"
import { chatRuntime, createChatRuntime } from "@/lib/chat-runtime"
import {
  CHAT_BACKGROUND_TASK_NAME,
  SESSION_TOKEN_KEY,
  WORKSPACE_KEY,
} from "@/lib/storage-keys"
import { readStoredValue } from "@/lib/storage"

async function runBackgroundChatPass() {
  const token = await readStoredValue(SESSION_TOKEN_KEY)
  const workspaceId = await readStoredValue(WORKSPACE_KEY)
  if (!token || !workspaceId) {
    return BackgroundTask.BackgroundTaskResult.Success
  }

  const previousToken = getApiAuthToken()
  const runtime = createChatRuntime()
  setApiAuthToken(token)

  try {
    await runtime.ensureWorkspace(workspaceId)
    await runtime.syncFromServer()
    return BackgroundTask.BackgroundTaskResult.Success
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed
  } finally {
    setApiAuthToken(previousToken)
  }
}

if (
  Platform.OS !== "web" &&
  !TaskManager.isTaskDefined(CHAT_BACKGROUND_TASK_NAME)
) {
  TaskManager.defineTask(CHAT_BACKGROUND_TASK_NAME, async () => {
    return runBackgroundChatPass()
  })
}

export async function syncChatBackgroundTaskRegistration(input: {
  token: string | null
  workspaceId: string | null
}) {
  if (Platform.OS === "web") {
    return
  }

  const available = await TaskManager.isAvailableAsync().catch(() => false)
  const status = await BackgroundTask.getStatusAsync().catch(
    () => BackgroundTask.BackgroundTaskStatus.Restricted
  )
  const registered = await TaskManager.isTaskRegisteredAsync(
    CHAT_BACKGROUND_TASK_NAME
  ).catch(() => false)

  if (
    !input.token ||
    !input.workspaceId ||
    !available ||
    status !== BackgroundTask.BackgroundTaskStatus.Available
  ) {
    if (registered) {
      await BackgroundTask.unregisterTaskAsync(CHAT_BACKGROUND_TASK_NAME).catch(
        () => undefined
      )
    }
    return
  }

  if (!registered) {
    await BackgroundTask.registerTaskAsync(CHAT_BACKGROUND_TASK_NAME, {
      minimumInterval: 15,
    }).catch(() => undefined)
  }
}

export async function triggerChatBackgroundTaskForTesting() {
  if (Platform.OS === "web") {
    return false
  }

  return BackgroundTask.triggerTaskWorkerForTestingAsync().catch(() => false)
}

export async function forceChatBackgroundSyncOnce() {
  const current = chatRuntime.getState()
  if (current.activeWorkspaceId) {
    return chatRuntime.syncFromServer()
  }
  return runBackgroundChatPass()
}
