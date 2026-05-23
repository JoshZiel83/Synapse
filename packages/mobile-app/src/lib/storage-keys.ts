import {
  CHAT_QUEUE_BROADCAST_CHANNEL,
  CHAT_SERVICE_WORKER_PERIODIC_SYNC_TAG,
  CHAT_SERVICE_WORKER_SYNC_TAG,
} from "@shared"

export const SESSION_TOKEN_KEY = "synapse.mobile.sessionToken"
export const WORKSPACE_KEY = "synapse.mobile.workspaceId"

export const CHAT_BACKGROUND_TASK_NAME = "synapse.chat.background-sync"
export const CHAT_WEB_SERVICE_WORKER_FILENAME = "chat-service-worker.js"

// Mobile keeps the historical CHAT_WEB_SERVICE_WORKER_* names but the
// underlying string values now come from @synapse/shared, so web and
// mobile broadcast on the same channel name and register the same SW
// sync tags.
export const CHAT_WEB_SERVICE_WORKER_BROADCAST_CHANNEL =
  CHAT_QUEUE_BROADCAST_CHANNEL
export const CHAT_WEB_SERVICE_WORKER_SYNC_TAG = CHAT_SERVICE_WORKER_SYNC_TAG
export const CHAT_WEB_SERVICE_WORKER_PERIODIC_SYNC_TAG =
  CHAT_SERVICE_WORKER_PERIODIC_SYNC_TAG
