import {
  CONVERSATION_KIND,
  CONVERSATION_PARTICIPANT_TYPE,
  CONVERSATION_TYPE_KEYS,
  CONVERSATION_TYPE_MASK_BITS,
  CONVERSATION_TYPE_MASK_PRESETS,
  DEFAULT_CONVERSATION_TYPE_MASK,
} from "../constants/enums.js"
import type {
  ActorRuntimeProcessingTarget,
  ActorRuntimeState,
  ActorRuntimeTurnPreviewTool,
  ConversationTypeKey,
  ConversationTypeMask,
  WorkItemStatus,
} from "../types/index.js"
import { WORK_ITEM_TRANSITIONS } from "../types/index.js"

export function generateId(): string {
  // crypto.randomUUID is available in every runtime this ships to (Node 18+,
  // all modern browsers, RN/Hermes with the polyfill). No Math.random
  // fallback — that produced non-UUID, low-entropy ids and only ever ran in
  // ancient environments we don't support.
  return globalThis.crypto.randomUUID()
}

export function isValidTransition(
  from: WorkItemStatus,
  to: WorkItemStatus
): boolean {
  const allowed = WORK_ITEM_TRANSITIONS[from]
  return allowed?.includes(to) ?? false
}

export function paginate(page: number, pageSize: number, maxPageSize = 100) {
  const p = Math.max(1, page)
  const ps = Math.min(Math.max(1, pageSize), maxPageSize)
  return { offset: (p - 1) * ps, limit: ps, page: p, pageSize: ps }
}

export function nowISO(): string {
  return new Date().toISOString()
}

export const GROUP_CONVERSATION_KIND = CONVERSATION_KIND.GROUP
export const DIRECT_CONVERSATION_KIND = CONVERSATION_KIND.DIRECT
export const THREAD_CONVERSATION_KINDS = [
  GROUP_CONVERSATION_KIND,
  DIRECT_CONVERSATION_KIND,
] as const

export type ThreadAddressingMode =
  | "none"
  | "implicit_peer"
  | "explicit_recipients"

export interface ThreadSemantics {
  hasThreadContext: boolean
  isDirectConversation: boolean
  isGroupConversation: boolean
  otherParticipantCount: number
  hasAddressablePeer: boolean
  addressingMode: ThreadAddressingMode
  requiresVisibleReplyBeforeSleep: boolean
  allowsSleepWithoutReplyConfirmation: boolean
}

export type ParsedSynapseQrPayload =
  | { kind: "login"; token: string }
  | { kind: "relationship"; token: string }
  | { kind: "token"; token: string }

export function isGroupConversationKind(
  kind: string | null | undefined
): boolean {
  return kind === GROUP_CONVERSATION_KIND
}

export function isDirectConversationKind(
  kind: string | null | undefined
): boolean {
  return kind === DIRECT_CONVERSATION_KIND
}

export function isThreadConversationKind(
  kind: string | null | undefined
): boolean {
  return kind === GROUP_CONVERSATION_KIND || kind === DIRECT_CONVERSATION_KIND
}

export function isPlanDraftingCollaborationMode(
  mode: string | null | undefined
): boolean {
  return mode === "plan_drafting"
}

export function isPlanAwaitingApprovalCollaborationMode(
  mode: string | null | undefined
): boolean {
  return mode === "plan_awaiting_approval"
}

export function isPlanCollaborationMode(
  mode: string | null | undefined
): boolean {
  return (
    isPlanDraftingCollaborationMode(mode) ||
    isPlanAwaitingApprovalCollaborationMode(mode)
  )
}

export const CONVERSATION_TYPE_MASK_KEY_ORDER = CONVERSATION_TYPE_KEYS

export function resolveConversationTypeKey(
  kind: string | null | undefined,
  isIm: boolean
): ConversationTypeKey | null {
  if (kind === DIRECT_CONVERSATION_KIND) {
    return isIm ? "im_direct" : "direct"
  }
  if (kind === GROUP_CONVERSATION_KIND) {
    return isIm ? "im_group" : "group"
  }
  return null
}

export function resolveConversationTypeBit(
  kind: string | null | undefined,
  isIm: boolean
): ConversationTypeMask | null {
  const key = resolveConversationTypeKey(kind, isIm)
  return key ? CONVERSATION_TYPE_MASK_BITS[key] : null
}

export function isValidConversationTypeMask(
  mask: unknown
): mask is ConversationTypeMask {
  if (!Number.isInteger(mask)) {
    return false
  }
  const numericMask = Number(mask)
  if (numericMask <= 0) {
    return false
  }
  return (numericMask & ~CONVERSATION_TYPE_MASK_PRESETS.ALL) === 0
}

export function normalizeConversationTypeMask(
  mask: unknown,
  fallback: ConversationTypeMask = DEFAULT_CONVERSATION_TYPE_MASK
): ConversationTypeMask {
  return isValidConversationTypeMask(mask) ? Number(mask) : fallback
}

export function resolveEffectiveConversationTypeMask(params: {
  defaultMask?: unknown
  overrideMask?: unknown
}): ConversationTypeMask {
  if (params.overrideMask === null || params.overrideMask === undefined) {
    return normalizeConversationTypeMask(params.defaultMask)
  }
  return normalizeConversationTypeMask(
    params.overrideMask,
    normalizeConversationTypeMask(params.defaultMask)
  )
}

export function resolveNarrowedConversationTypeMask(
  parentMask: unknown,
  overrideMask?: unknown
): ConversationTypeMask {
  const normalizedParentMask = normalizeConversationTypeMask(parentMask)
  if (overrideMask === null || overrideMask === undefined) {
    return normalizedParentMask
  }
  return (
    normalizedParentMask &
    normalizeConversationTypeMask(overrideMask, normalizedParentMask)
  )
}

export function conversationTypeMaskToKeys(
  mask: unknown
): ConversationTypeKey[] {
  const normalizedMask = normalizeConversationTypeMask(mask)
  return CONVERSATION_TYPE_MASK_KEY_ORDER.filter(
    (key) => (normalizedMask & CONVERSATION_TYPE_MASK_BITS[key]) !== 0
  )
}

export function conversationTypeKeysToMask(
  keys: readonly ConversationTypeKey[],
  fallback: ConversationTypeMask = DEFAULT_CONVERSATION_TYPE_MASK
): ConversationTypeMask {
  const normalizedKeys = Array.from(new Set(keys)).filter((key) =>
    CONVERSATION_TYPE_MASK_KEY_ORDER.includes(key)
  )
  if (normalizedKeys.length === 0) {
    return fallback
  }
  return normalizedKeys.reduce(
    (mask, key) => mask | CONVERSATION_TYPE_MASK_BITS[key],
    0
  )
}

export function maskAllowsConversationTypeKey(
  mask: unknown,
  key: ConversationTypeKey | null
): boolean {
  if (!key) {
    return false
  }
  const normalizedMask = normalizeConversationTypeMask(mask)
  return (normalizedMask & CONVERSATION_TYPE_MASK_BITS[key]) !== 0
}

export function maskAllowsConversationType(
  mask: unknown,
  kind: string | null | undefined,
  isIm: boolean
): boolean {
  return maskAllowsConversationTypeKey(
    mask,
    resolveConversationTypeKey(kind, isIm)
  )
}

export function resolveThreadSemantics(params: {
  kind?: string | null
  otherParticipantCount?: number
}): ThreadSemantics {
  const otherParticipantCount = Math.max(
    0,
    Math.trunc(params.otherParticipantCount ?? 0)
  )
  const isDirectConversation = isDirectConversationKind(params.kind)
  const isGroupConversation = isGroupConversationKind(params.kind)
  const hasThreadContext = isThreadConversationKind(params.kind)
  const hasAddressablePeer = hasThreadContext && otherParticipantCount > 0

  let addressingMode: ThreadAddressingMode = "none"
  if (isDirectConversation) {
    addressingMode = "implicit_peer"
  } else if (isGroupConversation) {
    addressingMode = "explicit_recipients"
  }

  return {
    hasThreadContext,
    isDirectConversation,
    isGroupConversation,
    otherParticipantCount,
    hasAddressablePeer,
    addressingMode,
    requiresVisibleReplyBeforeSleep: hasAddressablePeer,
    allowsSleepWithoutReplyConfirmation:
      isGroupConversation && hasAddressablePeer,
  }
}

export function isActorRuntimeActive(
  runtime: Pick<ActorRuntimeState, "laneState"> | null | undefined
): boolean {
  if (!runtime) return false
  return runtime.laneState !== "idle" && runtime.laneState !== "closed"
}

export function getActorRuntimePriority(
  runtime: Pick<ActorRuntimeState, "health" | "laneState"> | null | undefined
): number {
  if (!runtime) return 3
  if (runtime.health === "error" || runtime.laneState === "blocked") return 0
  if (runtime.laneState === "running") return 1
  if (runtime.laneState === "queued") return 2
  return 3
}

export function getActorRuntimeProcessingTargets(
  runtime: Pick<ActorRuntimeState, "currentTurnPreview"> | null | undefined
): ActorRuntimeProcessingTarget[] {
  return runtime?.currentTurnPreview?.processingTargets ?? []
}

export function getActorRuntimeCurrentTool(
  runtime: Pick<ActorRuntimeState, "currentTurnPreview"> | null | undefined
): ActorRuntimeTurnPreviewTool | undefined {
  return (
    runtime?.currentTurnPreview?.activeTool ||
    runtime?.currentTurnPreview?.lastCompletedTool
  )
}

export function isActorRuntimeProcessingWorkspaceMember(
  runtime: Pick<ActorRuntimeState, "currentTurnPreview"> | null | undefined,
  workspaceMemberId: string | null | undefined
): boolean {
  if (!workspaceMemberId) return false
  return getActorRuntimeProcessingTargets(runtime).some(
    (target) =>
      target.participantType ===
        CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
      target.participantId === workspaceMemberId
  )
}

export function parseSynapseQrPayload(
  input: string
): ParsedSynapseQrPayload | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const classifyToken = (
    kind: string | null | undefined,
    token: string | null | undefined,
    pathname?: string,
    hostname?: string
  ): ParsedSynapseQrPayload | null => {
    const normalizedToken = token?.trim()
    if (!normalizedToken) return null
    const normalizedKind = kind?.trim().toLowerCase()
    const normalizedPathname = pathname?.replace(/\/+$/, "").toLowerCase() || ""
    const normalizedHostname = hostname?.trim().toLowerCase() || ""

    if (
      normalizedKind === "login" ||
      normalizedPathname.endsWith("/m/qr-login") ||
      normalizedPathname.endsWith("/qr-login")
    ) {
      return { kind: "login", token: normalizedToken }
    }

    if (
      normalizedKind === "relationship" ||
      normalizedHostname === "relationship-qr" ||
      normalizedPathname.endsWith("/relationship-qr")
    ) {
      return { kind: "relationship", token: normalizedToken }
    }

    return /^[A-Za-z0-9_-]{16,255}$/.test(normalizedToken)
      ? { kind: "token", token: normalizedToken }
      : null
  }

  try {
    const url = new URL(trimmed)
    return classifyToken(
      url.searchParams.get("kind"),
      url.searchParams.get("token"),
      url.pathname,
      url.hostname
    )
  } catch {
    // Ignore malformed URLs and fallback to raw token parsing.
  }

  return /^[A-Za-z0-9_-]{16,255}$/.test(trimmed)
    ? { kind: "token", token: trimmed }
    : null
}

export function buildMobileScanUrl(params: {
  origin: string
  kind: "login" | "relationship"
  token: string
}) {
  const url = new URL("/m/scan", params.origin)
  url.searchParams.set("kind", params.kind)
  url.searchParams.set("token", params.token)
  return url.toString()
}

export { redactSecrets } from "./redact.js"
export type { RedactOptions } from "./redact.js"

export { computeBackoff } from "./backoff.js"
export type { ComputeBackoffOptions } from "./backoff.js"
