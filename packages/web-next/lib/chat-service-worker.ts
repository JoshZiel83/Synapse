"use client"

import { API_BASE } from "@/lib/api"

export const CHAT_WEB_SERVICE_WORKER_PATH = "/web-chat-service-worker.js"
export const CHAT_WEB_SERVICE_WORKER_BROADCAST_CHANNEL =
  "synapse.web.chat.worker"
export const CHAT_WEB_SERVICE_WORKER_SYNC_TAG = "synapse-web-chat-sync"
export const CHAT_WEB_SERVICE_WORKER_PERIODIC_SYNC_TAG =
  "synapse-web-chat-periodic-sync"

type ChatWorkerMessage =
  | {
      type: "chat:set-auth-context"
      payload: {
        workspaceId: string
        apiBase: string
      }
    }
  | {
      type: "chat:clear-auth-context"
    }
  | {
      type: "chat:run-sync"
      payload?: { reason?: string }
    }

type ChatWorkerBroadcast =
  | {
      type: "chat:snapshot-updated"
      payload: {
        workspaceId: string
        reason?: string
      }
    }
  | {
      type: "chat:sync-failed"
      payload?: {
        reason?: string
      }
    }

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null
let lifecycleBound = false
let latestAuthContext: {
  workspaceId: string | null
} = {
  workspaceId: null,
}

function isSupported() {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "serviceWorker" in navigator
  )
}

async function refreshRegistration(
  registration: ServiceWorkerRegistration | null
) {
  await registration?.update().catch(() => undefined)
}

function bindLifecycle(registration: ServiceWorkerRegistration) {
  if (!isSupported() || lifecycleBound) {
    return
  }

  lifecycleBound = true

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    const authContext = latestAuthContext
    if (!authContext.workspaceId) {
      return
    }

    void postMessage({
      type: "chat:set-auth-context",
      payload: {
        workspaceId: authContext.workspaceId,
        apiBase: API_BASE,
      },
    }).then(() => registerOneOffSync())
  })

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void refreshRegistration(registration)
    }
  })

  window.addEventListener("focus", () => {
    void refreshRegistration(registration)
  })
  window.addEventListener("online", () => {
    void refreshRegistration(registration)
  })
}

async function getRegistration() {
  if (!isSupported()) {
    return null
  }

  if (!registrationPromise) {
    registrationPromise = navigator.serviceWorker
      .register(CHAT_WEB_SERVICE_WORKER_PATH, {
        scope: "/",
        updateViaCache: "none",
      })
      .then((registration) => {
        bindLifecycle(registration)
        void refreshRegistration(registration)
        void navigator.serviceWorker.ready.catch(() => undefined)
        return registration
      })
      .catch(() => null)
  }

  return registrationPromise
}

async function postMessage(message: ChatWorkerMessage) {
  const registration = await getRegistration()
  if (!registration || !("serviceWorker" in navigator)) {
    return
  }

  const target =
    navigator.serviceWorker.controller ??
    registration.active ??
    registration.waiting ??
    registration.installing

  target?.postMessage(message)
}

function getBroadcastChannel() {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) {
    return null
  }

  return new BroadcastChannel(CHAT_WEB_SERVICE_WORKER_BROADCAST_CHANNEL)
}

async function registerOneOffSync() {
  const registration = await getRegistration()
  const syncManager =
    registration && "sync" in registration
      ? (
          registration as ServiceWorkerRegistration & {
            sync: { register: (tag: string) => Promise<void> }
          }
        ).sync
      : null

  if (!syncManager) {
    return
  }

  await syncManager
    .register(CHAT_WEB_SERVICE_WORKER_SYNC_TAG)
    .catch(() => undefined)
}

async function registerPeriodicSync() {
  const registration = await getRegistration()
  const periodicSync =
    registration && "periodicSync" in registration
      ? (
          registration as ServiceWorkerRegistration & {
            periodicSync: {
              register: (
                tag: string,
                options: { minInterval: number }
              ) => Promise<void>
            }
          }
        ).periodicSync
      : null

  if (!periodicSync) {
    return
  }

  await periodicSync
    .register(CHAT_WEB_SERVICE_WORKER_PERIODIC_SYNC_TAG, {
      minInterval: 15 * 60 * 1000,
    })
    .catch(() => undefined)
}

export async function ensureChatServiceWorkerRegistered() {
  const registration = await getRegistration()
  await registerPeriodicSync()
  return registration
}

export async function syncChatServiceWorkerAuthContext(input: {
  workspaceId: string | null
}) {
  if (!isSupported()) {
    return
  }

  latestAuthContext = input
  await ensureChatServiceWorkerRegistered()

  if (!input.workspaceId) {
    await postMessage({ type: "chat:clear-auth-context" })
    return
  }

  await postMessage({
    type: "chat:set-auth-context",
    payload: {
      workspaceId: input.workspaceId,
      apiBase: API_BASE,
    },
  })

  await registerOneOffSync()
}

export async function requestChatServiceWorkerSync(reason = "manual") {
  if (!isSupported()) {
    return
  }

  await ensureChatServiceWorkerRegistered()
  await postMessage({
    type: "chat:run-sync",
    payload: { reason },
  })
  await registerOneOffSync()
}

export function subscribeToChatServiceWorker(
  listener: (message: ChatWorkerBroadcast) => void
) {
  const channel = getBroadcastChannel()
  if (channel) {
    const handleMessage = (event: MessageEvent<ChatWorkerBroadcast>) => {
      listener(event.data)
    }

    channel.addEventListener("message", handleMessage)
    return () => {
      channel.removeEventListener("message", handleMessage)
      channel.close()
    }
  }

  if (!isSupported()) {
    return () => undefined
  }

  const handleMessage = (event: MessageEvent<ChatWorkerBroadcast>) => {
    listener(event.data)
  }

  navigator.serviceWorker.addEventListener("message", handleMessage)
  return () => {
    navigator.serviceWorker.removeEventListener("message", handleMessage)
  }
}
