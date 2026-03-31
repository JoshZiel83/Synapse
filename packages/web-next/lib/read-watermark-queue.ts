"use client"

import { api } from "@/lib/api"

type PendingReadWatermark = {
  workspaceId: string
  conversationId: string
  readUpToSequence: number
  updatedAt: string
}

const READ_WATERMARK_STORAGE_KEY = "chat-read-watermarks:v1"

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined"
}

function loadPendingReadsMap() {
  if (!canUseStorage()) return {} as Record<string, PendingReadWatermark>

  try {
    const raw = window.localStorage.getItem(READ_WATERMARK_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as PendingReadWatermark[] | null
    if (!Array.isArray(parsed)) return {}

    return Object.fromEntries(
      parsed
        .filter(
          (entry) =>
            entry &&
            typeof entry.workspaceId === "string" &&
            typeof entry.conversationId === "string" &&
            typeof entry.readUpToSequence === "number"
        )
        .map((entry) => [entry.conversationId, entry])
    )
  } catch {
    return {}
  }
}

function persistPendingReadsMap(
  readsMap: Record<string, PendingReadWatermark>
) {
  if (!canUseStorage()) return
  const entries = Object.values(readsMap).sort(
    (left, right) =>
      new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime()
  )
  window.localStorage.setItem(
    READ_WATERMARK_STORAGE_KEY,
    JSON.stringify(entries)
  )
}

export function queuePendingConversationRead(
  workspaceId: string,
  conversationId: string,
  readUpToSequence: number
) {
  const currentMap = loadPendingReadsMap()
  const current = currentMap[conversationId]
  const normalizedSequence = Math.max(0, Math.floor(readUpToSequence))
  currentMap[conversationId] = {
    workspaceId,
    conversationId,
    readUpToSequence: Math.max(
      normalizedSequence,
      current?.readUpToSequence || 0
    ),
    updatedAt: new Date().toISOString(),
  }
  persistPendingReadsMap(currentMap)
}

export function clearPendingConversationRead(
  conversationId: string,
  confirmedSequence?: number
) {
  const currentMap = loadPendingReadsMap()
  const current = currentMap[conversationId]
  if (!current) return
  if (
    typeof confirmedSequence === "number" &&
    current.readUpToSequence > Math.floor(confirmedSequence)
  ) {
    return
  }

  delete currentMap[conversationId]
  persistPendingReadsMap(currentMap)
}

let flushPromise: Promise<void> | null = null

export async function flushPendingConversationReads() {
  if (flushPromise) return flushPromise

  flushPromise = (async () => {
    const entries = Object.values(loadPendingReadsMap()).sort(
      (left, right) => left.readUpToSequence - right.readUpToSequence
    )

    for (const entry of entries) {
      try {
        await api.markThreadRead(
          entry.workspaceId,
          entry.conversationId,
          entry.readUpToSequence
        )
        clearPendingConversationRead(
          entry.conversationId,
          entry.readUpToSequence
        )
      } catch {
        // Leave the watermark queued for the next reconnect.
      }
    }
  })().finally(() => {
    flushPromise = null
  })

  return flushPromise
}
