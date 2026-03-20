export type MobileLaunchActor = {
  id: string
  name: string
  role: string
  title: string
  avatarUrl?: string
  emoji?: string
}

type StoredActorPayload = {
  workspaceId: string
  actor: MobileLaunchActor
}

type StoredDraftPayload = {
  workspaceId: string
  draft: string
}

const MOBILE_LAUNCH_ACTOR_STORAGE_KEY = "mobile-launch-actor"
const MOBILE_LAUNCH_DRAFT_STORAGE_KEY = "mobile-launch-draft"

function readStorageItem<T>(key: string): T | null {
  if (typeof window === "undefined") return null

  const rawValue = window.sessionStorage.getItem(key)
  if (!rawValue) return null

  try {
    return JSON.parse(rawValue) as T
  } catch {
    window.sessionStorage.removeItem(key)
    return null
  }
}

function writeStorageItem(key: string, value: unknown) {
  if (typeof window === "undefined") return
  window.sessionStorage.setItem(key, JSON.stringify(value))
}

export function readStoredMobileLaunchActor(
  workspaceId: string | null | undefined
): MobileLaunchActor | null {
  if (!workspaceId) return null

  const payload = readStorageItem<StoredActorPayload>(
    MOBILE_LAUNCH_ACTOR_STORAGE_KEY
  )

  if (!payload || payload.workspaceId !== workspaceId) {
    return null
  }

  return payload.actor
}

export function writeStoredMobileLaunchActor(
  workspaceId: string,
  actor: MobileLaunchActor
) {
  writeStorageItem(MOBILE_LAUNCH_ACTOR_STORAGE_KEY, { workspaceId, actor })
}

export function clearStoredMobileLaunchActor() {
  if (typeof window === "undefined") return
  window.sessionStorage.removeItem(MOBILE_LAUNCH_ACTOR_STORAGE_KEY)
}

export function readStoredMobileLaunchDraft(
  workspaceId: string | null | undefined
): string {
  if (!workspaceId) return ""

  const payload = readStorageItem<StoredDraftPayload>(
    MOBILE_LAUNCH_DRAFT_STORAGE_KEY
  )

  if (!payload || payload.workspaceId !== workspaceId) {
    return ""
  }

  return payload.draft
}

export function writeStoredMobileLaunchDraft(
  workspaceId: string,
  draft: string
) {
  writeStorageItem(MOBILE_LAUNCH_DRAFT_STORAGE_KEY, { workspaceId, draft })
}

export function takeStoredMobileLaunchDraft(
  workspaceId: string | null | undefined
): string {
  const draft = readStoredMobileLaunchDraft(workspaceId)
  clearStoredMobileLaunchDraft()
  return draft
}

export function clearStoredMobileLaunchDraft() {
  if (typeof window === "undefined") return
  window.sessionStorage.removeItem(MOBILE_LAUNCH_DRAFT_STORAGE_KEY)
}
