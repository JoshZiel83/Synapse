// Web client constants for the chat service worker.
//
// The broadcast channel name, IDB names, and SW sync tags are owned by
// @synapse/shared so web + mobile reach the same canonical strings.
// Only the on-disk worker filename is web-local (the file is bundled
// under packages/web-next/public/ and served from /web-chat-service-worker.js).
export {
  CHAT_QUEUE_BROADCAST_CHANNEL as CHAT_WEB_SERVICE_WORKER_BROADCAST_CHANNEL,
  CHAT_SERVICE_WORKER_SYNC_TAG as CHAT_WEB_SERVICE_WORKER_SYNC_TAG,
  CHAT_SERVICE_WORKER_PERIODIC_SYNC_TAG as CHAT_WEB_SERVICE_WORKER_PERIODIC_SYNC_TAG,
} from "@synapse/shared/chat-queue"

export const CHAT_WEB_SERVICE_WORKER_PATH = "/web-chat-service-worker.js"
