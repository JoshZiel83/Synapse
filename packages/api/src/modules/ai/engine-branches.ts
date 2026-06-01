import { createHash, randomUUID } from "crypto"
import { extractText } from "@synapse/shared"
import type {
  CanonicalContextItem,
  CanonicalToolCall,
  EngineBranchState,
  ProviderContextWindow,
  ResolvedModelConfig,
} from "@synapse/shared"
import { getModelBranchStateMode } from "@synapse/shared"
import {
  db,
  withDbTransaction,
  type TableInsert,
} from "../../infrastructure/database/kysely.js"
import { sql } from "kysely"

const MAX_APPLIED_ITEM_IDS = 512

function stableSerialize(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, nestedValue]) =>
          `${JSON.stringify(key)}:${stableSerialize(nestedValue)}`
      )
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value)
}

export function buildContextManifestHash(
  window: Pick<ProviderContextWindow, "manifest">
) {
  if (!window.manifest) return undefined
  return createHash("sha256")
    .update(stableSerialize(window.manifest))
    .digest("hex")
    .slice(0, 16)
}

function buildToolCallBatchFingerprint(
  toolCalls: Array<
    Pick<CanonicalToolCall, "callId" | "providerCallId" | "toolName" | "input">
  >
) {
  const serialized = toolCalls
    .map((toolCall) =>
      stableSerialize({
        providerCallId: toolCall.providerCallId || null,
        toolName: toolCall.toolName,
        input: toolCall.input,
      })
    )
    .join("|")
  const digest = createHash("sha256")
    .update(serialized)
    .digest("hex")
    .slice(0, 16)

  return `tool_call_batch:fingerprint:${digest}`
}

export function buildToolCallBatchAppliedKey(
  toolCalls: Array<
    Pick<CanonicalToolCall, "callId" | "providerCallId" | "toolName" | "input">
  >,
  contentText?: string
) {
  if (!toolCalls || toolCalls.length === 0) return undefined
  return buildToolCallBatchFingerprint(toolCalls)
}

function extractNativeTailToolCalls(branch: EngineBranchState) {
  const branchStateMode = getModelBranchStateMode(branch.engineKind)

  if (branchStateMode === "anthropic.messages") {
    const messages = Array.isArray(branch.nativeState?.messages)
      ? (branch.nativeState.messages as Array<Record<string, unknown>>)
      : []
    const last = messages[messages.length - 1]
    if (last?.role !== "assistant" || !Array.isArray(last.content))
      return undefined
    const toolCalls = last.content
      .filter(
        (block): block is Record<string, unknown> =>
          !!block && typeof block === "object"
      )
      .filter(
        (block) => block.type === "tool_use" && typeof block.name === "string"
      )
      .map((block) => ({
        callId: typeof block.id === "string" ? block.id : "",
        providerCallId: typeof block.id === "string" ? block.id : undefined,
        toolName: String(block.name),
        input:
          block.input && typeof block.input === "object"
            ? (block.input as Record<string, unknown>)
            : {},
      }))
    return toolCalls.length > 0 ? toolCalls : undefined
  }

  if (branchStateMode === "openai.chat_completions") {
    const messages = Array.isArray(branch.nativeState?.messages)
      ? (branch.nativeState.messages as Array<Record<string, unknown>>)
      : []
    const last = messages[messages.length - 1]
    if (last?.role !== "assistant" || !Array.isArray(last.tool_calls))
      return undefined
    const toolCalls = last.tool_calls
      .filter(
        (toolCall): toolCall is Record<string, unknown> =>
          !!toolCall && typeof toolCall === "object"
      )
      .filter(
        (toolCall) =>
          toolCall.function &&
          typeof toolCall.function === "object" &&
          typeof toolCall.id === "string"
      )
      .map((toolCall) => {
        const fn = toolCall.function as Record<string, unknown>
        let input: Record<string, unknown> = {}
        if (typeof fn.arguments === "string") {
          try {
            input = JSON.parse(fn.arguments) as Record<string, unknown>
          } catch {
            input = {}
          }
        }
        return {
          callId: String(toolCall.id),
          providerCallId: String(toolCall.id),
          toolName: typeof fn.name === "string" ? fn.name : "",
          input,
        }
      })
    return toolCalls.length > 0 ? toolCalls : undefined
  }

  if (branchStateMode === "openai.responses") {
    const items = Array.isArray(branch.nativeState?.items)
      ? (branch.nativeState.items as Array<Record<string, unknown>>)
      : []
    const collected: Array<
      Pick<
        CanonicalToolCall,
        "callId" | "providerCallId" | "toolName" | "input"
      >
    > = []
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      if (item?.type !== "function_call" || typeof item.name !== "string") {
        if (collected.length > 0) break
        continue
      }
      let input: Record<string, unknown> = {}
      if (typeof item.arguments === "string") {
        try {
          input = JSON.parse(item.arguments) as Record<string, unknown>
        } catch {
          input = {}
        }
      } else if (item.arguments && typeof item.arguments === "object") {
        input = item.arguments as Record<string, unknown>
      }
      collected.unshift({
        callId:
          typeof item.call_id === "string"
            ? item.call_id
            : typeof item.id === "string"
              ? item.id
              : "",
        providerCallId:
          typeof item.call_id === "string"
            ? item.call_id
            : typeof item.id === "string"
              ? item.id
              : undefined,
        toolName: item.name,
        input,
      })
    }
    return collected.length > 0 ? collected : undefined
  }

  return undefined
}

function branchTailAlreadyIncludesToolCalls(
  branch: EngineBranchState,
  toolCalls: Array<
    Pick<CanonicalToolCall, "callId" | "providerCallId" | "toolName" | "input">
  >
) {
  const nativeTailToolCalls = extractNativeTailToolCalls(branch)
  if (!nativeTailToolCalls || nativeTailToolCalls.length !== toolCalls.length) {
    return false
  }

  return (
    buildToolCallBatchFingerprint(nativeTailToolCalls) ===
    buildToolCallBatchFingerprint(toolCalls)
  )
}

function buildAppliedItemKeys(item: CanonicalContextItem) {
  const keys: string[] = []
  if (item.itemId) keys.push(`id:${item.itemId}`)

  switch (item.kind) {
    case "tool_call_batch":
      if (item.bundleId) keys.push(`${item.kind}:${item.bundleId}`)
      keys.push(buildToolCallBatchFingerprint(item.toolCalls))
      break
    case "tool_result_batch":
      if (item.bundleId) keys.push(`${item.kind}:${item.bundleId}`)
      break
    case "summary":
      if (item.sourceItemIds?.length)
        keys.push(`summary:${item.summaryType}:${item.sourceItemIds.join(",")}`)
      break
    case "message":
      keys.push(
        [
          "message",
          item.role,
          item.author?.sessionId || "",
          extractText(item.parts).slice(0, 240),
        ].join(":")
      )
      break
    case "system_notice":
      keys.push(
        ["notice", item.noticeType, extractText(item.parts).slice(0, 240)].join(
          ":"
        )
      )
      break
    case "event":
      keys.push(
        ["event", item.eventType, extractText(item.parts).slice(0, 240)].join(
          ":"
        )
      )
      break
    case "memory_recall":
      keys.push(
        [
          "memory_recall",
          item.recallType,
          item.memories.map((memory) => memory.id).join(","),
        ].join(":")
      )
      break
  }

  return keys
}

function trackAppliedItemIds(
  previous: string[] | undefined,
  items: CanonicalContextItem[]
): string[] | undefined {
  const seen = new Set(previous || [])
  const merged = [...(previous || [])]

  for (const item of items) {
    for (const key of buildAppliedItemKeys(item)) {
      if (!key || seen.has(key)) continue
      seen.add(key)
      merged.push(key)
    }
  }

  if (merged.length === 0) return undefined
  return merged.slice(-MAX_APPLIED_ITEM_IDS)
}

function updateScopeSequence(
  current: number | undefined,
  items: CanonicalContextItem[],
  scope: "shared" | "private"
) {
  let next = current
  for (const item of items) {
    if (item.scope !== scope || typeof item.sequence !== "number") continue
    next = Math.max(next || 0, item.sequence)
  }
  return next
}

function isCoveredByBranch(
  item: CanonicalContextItem,
  branch: EngineBranchState
) {
  if (typeof item.sequence === "number") {
    const limit =
      item.scope === "shared"
        ? branch.cursor.sharedSequence || 0
        : branch.cursor.privateSequence || 0
    if (item.sequence <= limit) {
      return true
    }
  }

  if (
    item.kind === "tool_call_batch" &&
    branchTailAlreadyIncludesToolCalls(branch, item.toolCalls)
  ) {
    return true
  }

  for (const appliedKey of buildAppliedItemKeys(item)) {
    if (appliedKey && branch.cursor.appliedItemIds?.includes(appliedKey)) {
      return true
    }
  }

  return false
}

export function createEngineBindingKey(resolved: ResolvedModelConfig) {
  return [
    resolved.providerType,
    resolved.engineKind,
    resolved.profileRevisionId,
    resolved.baseUrl,
    resolved.modelName,
  ].join(":")
}

export function getBranchStoreKey(sessionId: string, bindingKey: string) {
  return `${sessionId}:${bindingKey}`
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!value) return undefined
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string")
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

function rowToBranchState(row: Record<string, unknown>): EngineBranchState {
  return {
    branchId: String(row.id),
    sessionId: String(row.session_id),
    conversationId:
      typeof row.conversation_id === "string" ? row.conversation_id : undefined,
    providerType: row.provider_type as string,
    engineKind: row.engine_kind as EngineBranchState["engineKind"],
    bindingKey: String(row.binding_key),
    cursor: {
      sharedSequence:
        typeof row.last_shared_sequence === "number"
          ? row.last_shared_sequence
          : Number(row.last_shared_sequence || 0),
      privateSequence:
        typeof row.last_private_sequence === "number"
          ? row.last_private_sequence
          : Number(row.last_private_sequence || 0),
      appliedItemIds: asStringArray(row.applied_item_keys),
    },
    nativeState: asObject(row.native_state),
    metadata: asObject(row.metadata),
  }
}

export async function getEngineBranchState(
  sessionId: string | undefined,
  resolved: ResolvedModelConfig
): Promise<EngineBranchState | undefined> {
  if (!sessionId) return undefined
  const result = await db
    .selectFrom("session_engine_branches")
    .selectAll()
    .where("session_id", "=", sessionId)
    .where("binding_key", "=", createEngineBindingKey(resolved))
    .where("status", "=", "active")
    .limit(1)
    .executeTakeFirst()

  return result
    ? rowToBranchState(result as Record<string, unknown>)
    : undefined
}

export async function saveEngineBranchState(
  branch: EngineBranchState | undefined,
  options: {
    checkpointKind?: "snapshot" | "compaction"
  } = {}
): Promise<EngineBranchState | undefined> {
  if (!branch) return undefined

  return withDbTransaction(async (trx) => {
    const branchResult = await trx
      .insertInto("session_engine_branches")
      .values({
        id: branch.branchId,
        session_id: branch.sessionId,
        conversation_id: branch.conversationId || null,
        provider_type: branch.providerType,
        engine_kind: branch.engineKind,
        binding_key: branch.bindingKey,
        last_shared_sequence: branch.cursor.sharedSequence || 0,
        last_private_sequence: branch.cursor.privateSequence || 0,
        applied_item_keys: branch.cursor.appliedItemIds || [],
        native_state: (branch.nativeState ||
          {}) as TableInsert<"session_engine_branches">["native_state"],
        metadata: (branch.metadata ||
          {}) as TableInsert<"session_engine_branches">["metadata"],
        status: "active",
        created_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      })
      .onConflict((oc) =>
        oc.columns(["session_id", "binding_key"]).doUpdateSet({
          conversation_id: branch.conversationId || null,
          provider_type: branch.providerType,
          engine_kind: branch.engineKind,
          last_shared_sequence: branch.cursor.sharedSequence || 0,
          last_private_sequence: branch.cursor.privateSequence || 0,
          applied_item_keys: branch.cursor.appliedItemIds || [],
          native_state: (branch.nativeState ||
            {}) as TableInsert<"session_engine_branches">["native_state"],
          metadata: (branch.metadata ||
            {}) as TableInsert<"session_engine_branches">["metadata"],
          status: "active",
          updated_at: sql`NOW()`,
        })
      )
      .returningAll()
      .executeTakeFirst()
    if (!branchResult) {
      throw new Error("Failed to persist engine branch")
    }

    const persisted = rowToBranchState(branchResult as Record<string, unknown>)

    await trx
      .insertInto("engine_branch_checkpoints")
      .values({
        branch_id: persisted.branchId,
        session_id: persisted.sessionId,
        conversation_id: persisted.conversationId || null,
        provider_type: persisted.providerType,
        engine_kind: persisted.engineKind,
        binding_key: persisted.bindingKey,
        checkpoint_kind: options.checkpointKind || "snapshot",
        shared_sequence: persisted.cursor.sharedSequence || 0,
        private_sequence: persisted.cursor.privateSequence || 0,
        applied_item_keys: persisted.cursor.appliedItemIds || [],
        native_state: (persisted.nativeState ||
          {}) as TableInsert<"engine_branch_checkpoints">["native_state"],
        metadata: (persisted.metadata ||
          {}) as TableInsert<"engine_branch_checkpoints">["metadata"],
        created_at: sql`NOW()`,
      })
      .execute()

    return persisted
  })
}

export function initializeEngineBranchState(params: {
  sessionId: string
  conversationId?: string
  resolved: ResolvedModelConfig
  metadata?: Record<string, unknown>
}): EngineBranchState {
  return {
    branchId: randomUUID(),
    sessionId: params.sessionId,
    conversationId: params.conversationId,
    providerType: params.resolved.providerType,
    engineKind: params.resolved.engineKind,
    bindingKey: createEngineBindingKey(params.resolved),
    cursor: {},
    metadata: params.metadata,
  }
}

export function buildBranchDeltaWindow(
  window: ProviderContextWindow,
  branch: EngineBranchState | undefined
): ProviderContextWindow {
  if (!branch) return window

  const sharedTailItems = window.sharedTailItems.filter(
    (item) => !isCoveredByBranch(item, branch)
  )
  const privateTailItems = window.privateTailItems.filter(
    (item) => !isCoveredByBranch(item, branch)
  )
  const orderedTailItems = window.orderedTailItems.filter(
    (item) => !isCoveredByBranch(item, branch)
  )

  return {
    manifest: undefined,
    sharedArchivePoint: null,
    sharedTailItems,
    privateArchivePoint: null,
    privateTailItems,
    orderedTailItems,
  }
}

export function canResumeBranchFromWindow(
  window: ProviderContextWindow,
  branch: EngineBranchState | undefined
) {
  if (!branch) return false
  if (
    buildContextManifestHash(window) !== branch.metadata?.contextManifestHash
  ) {
    return false
  }
  if (
    window.sharedArchivePoint &&
    window.sharedArchivePoint.coversUntilSequence >
      (branch.cursor.sharedSequence || 0)
  ) {
    return false
  }
  if (
    window.privateArchivePoint &&
    window.privateArchivePoint.coversUntilSequence >
      (branch.cursor.privateSequence || 0)
  ) {
    return false
  }

  const pendingTailToolCalls = extractNativeTailToolCalls(branch)
  if (pendingTailToolCalls && pendingTailToolCalls.length > 0) {
    const deltaWindow = buildBranchDeltaWindow(window, branch)
    const firstDeltaItem = deltaWindow.orderedTailItems[0]
    if (firstDeltaItem?.kind !== "tool_result_batch") {
      return false
    }
  }

  return true
}

export function shouldRebuildBranchState(
  window: ProviderContextWindow,
  branch: EngineBranchState | undefined,
  systemPrompt: string
) {
  if (!branch?.nativeState) return false
  if (branch.metadata?.systemPrompt !== systemPrompt) return true
  return !canResumeBranchFromWindow(window, branch)
}

export function advanceEngineBranchState(
  branch: EngineBranchState,
  window: ProviderContextWindow,
  nativeState: Record<string, unknown> | undefined,
  metadata?: Record<string, unknown>,
  extraAppliedItemIds?: string[]
): EngineBranchState {
  const appliedItemIds =
    trackAppliedItemIds(
      branch.cursor.appliedItemIds,
      window.orderedTailItems
    ) || []
  if (extraAppliedItemIds) {
    const seen = new Set(appliedItemIds)
    for (const itemId of extraAppliedItemIds) {
      if (!itemId || seen.has(itemId)) continue
      seen.add(itemId)
      appliedItemIds.push(itemId)
    }
  }

  return {
    ...branch,
    conversationId:
      branch.conversationId ||
      window.sharedArchivePoint?.conversationId ||
      window.privateArchivePoint?.conversationId,
    cursor: {
      sharedSequence: updateScopeSequence(
        window.sharedArchivePoint?.coversUntilSequence ??
          branch.cursor.sharedSequence,
        window.sharedTailItems,
        "shared"
      ),
      privateSequence: updateScopeSequence(
        window.privateArchivePoint?.coversUntilSequence ??
          branch.cursor.privateSequence,
        window.privateTailItems,
        "private"
      ),
      appliedItemIds:
        appliedItemIds.length > 0
          ? appliedItemIds.slice(-MAX_APPLIED_ITEM_IDS)
          : undefined,
    },
    nativeState,
    metadata: metadata
      ? { ...(branch.metadata || {}), ...metadata }
      : branch.metadata,
  }
}

export function buildAssistantMessageAppliedKey(
  sessionId: string | undefined,
  text: string
) {
  return ["message", "assistant", sessionId || "", text.slice(0, 240)].join(":")
}
