import type {
  Actor,
  ThinkingResult,
  ActorAction,
  ConversationMessage,
  ResolvedModelConfig,
  ResolvedModelPlan,
  ServerToolCall,
  ToolRound,
  CanonicalToolCall,
  CanonicalToolResult,
  AssistantToolHistory,
  ConversationParticipantEntry,
  ToolResolveContext,
  ToolResultOrigin,
  CanonicalContentBlock,
  ProviderContextWindow,
  AvailableSkillSummary,
  ModelAttemptPolicy,
  ToolDefinition,
} from "@synapse/shared"
import type {
  CanonicalContextItem,
  NormalizedMcpToolResult,
} from "@synapse/shared/types"
import {
  CONVERSATION_PARTICIPANT_TYPE,
  MODEL_SERVER_TOOL,
  describeTransportKind,
  extractText,
  formatMentionText,
  isTransportKind,
  computeWireNames,
  stripForProvider,
  stripForAuditSnapshot,
  systemToolId,
  toPublicOrigin,
  type NameRegistry,
  type NamePolicyItem,
  type ProjectedToolDefinition,
  type ToolRef,
  type SourceSnapshot,
  type ToolSourceKind,
  normalizeCanonicalContentBlocks,
  resolveThreadSemantics,
  textBlock,
  textBlocks,
} from "@synapse/shared"
import { isPlanCollaborationMode } from "@synapse/shared/utils"
import type { SessionCollaborationMode } from "@synapse/shared/types"
import { randomUUID } from "crypto"
import { createLogger } from "../../infrastructure/logger/index.js"
import { sleep } from "../../infrastructure/async/index.js"
import { generateText, stepCountIs } from "ai"
import { getLanguageModel } from "./providers/get-language-model.js"
import { toLanguageModelSpec } from "./providers/to-language-model-spec.js"
import { toModelMessages } from "./providers/to-model-messages.js"
import { reconcileToolPairing } from "./providers/reconcile-tool-pairing.js"
import { buildAiTools, buildServerTools } from "./providers/build-tools.js"
import { fromGenerateText } from "./providers/from-generate-text.js"
import { compileContextWindowToConversationMessages } from "./context-compiler.js"
import { buildActorPrompt } from "./prompt-builder.js"
import { logAIRequest } from "../model-groups/service.js"
import {
  resolveLocalCallableTools,
  executeCallableTools,
  isCallableTool,
} from "./tool-plugins.js"
import { runWithToolContext } from "./session-tools.js"
import {
  readToolResultOrigin,
  readToolResultStructuredContent,
} from "./tool-result-payload.js"
import { type McpExecutionContext } from "../mcp-plugins/instance-manager.js"
import { getMcpVersion } from "../mcp-plugins/runtime-version.js"
import { ingestResponseMedia } from "./content-ingest.js"
import {
  buildDefaultUserMention,
  conversationParticipantEntryToEntityRef,
  parseInlineReferenceSegments,
  resolveInlineReferenceSegments,
  type InlineReferenceResolveOptions,
} from "./inline-ref-resolver.js"
import { buildAdHocContextItems } from "./context-builder.js"
import { buildAdHocProviderContextWindow } from "../context/service.js"
import { DEFAULT_MODEL_ATTEMPT_POLICY } from "../model-groups/defaults.js"
import { listConversationParticipantsUseCase as getLiveConversationParticipants } from "../chat/participant-roster.js"
import {
  createToolCall,
  createToolExecutionAttempt,
  createToolResult,
  finalizeToolExecutionAttempt,
  logProviderStep,
  updateToolCallStatus,
} from "../execution/service.js"
import { getSession } from "../session/service.js"
import { getTransportConnectorCapability } from "../im/connectors/index.js"
import { buildToolMeta } from "../session/tool-presentation/tool-meta.js"

export { buildActorPrompt } from "./prompt-builder.js"

const MAX_TOOL_ROUNDS = 100
const DEFAULT_ATTEMPT_POLICY: ModelAttemptPolicy = DEFAULT_MODEL_ATTEMPT_POLICY

const log = createLogger("ai")

class TurnInterruptedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TurnInterruptedError"
  }
}

// Build an AI-SDK LanguageModel for a resolved candidate. Provider objects are
// memoized inside getLanguageModel by a stable hash of the binding's
// instance-distinguishing fields (not modelName).
function languageModelFor(resolved: ResolvedModelConfig) {
  // The env model path has been removed: a model can ONLY be built from a
  // resolved candidate (which originates from a configured model group). The
  // runtime guard is defense-in-depth against an untyped/`any` caller.
  if (!resolved) {
    throw new Error(
      "Cannot create AI model: no resolved model configuration. " +
        "Configure a platform model group (run 'npm run db:seed:model-groups' " +
        "or use the UI) so a model can be resolved for this actor."
    )
  }
  return getLanguageModel(toLanguageModelSpec(resolved))
}

function classifyModelError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase()
  if (message.includes("timed out") || message.includes("abort"))
    return "timeout"
  if (
    message.includes("401") ||
    message.includes("403") ||
    message.includes("auth")
  )
    return "auth_error"
  if (
    message.includes("400") ||
    message.includes("bad request") ||
    message.includes("validation")
  )
    return "bad_request"
  if (message.includes("429") || message.includes("rate limit"))
    return "rate_limit"
  if (
    message.includes("policy") ||
    message.includes("safety") ||
    message.includes("blocked")
  )
    return "policy_block"
  if (
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504")
  )
    return "5xx"
  if (
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("econn") ||
    message.includes("enotfound")
  ) {
    return "network"
  }
  return "unknown"
}

async function delay(ms: number) {
  if (ms <= 0) return
  await sleep(ms)
}

function effectiveAttemptPolicy(
  routePolicy: ModelAttemptPolicy,
  resolved: ResolvedModelConfig
): ModelAttemptPolicy {
  return {
    ...routePolicy,
    timeoutMsPerAttempt:
      resolved.requestTimeoutMs ?? routePolicy.timeoutMsPerAttempt,
    maxAttemptsPerBinding: Math.max(
      1,
      resolved.maxRetries !== undefined
        ? resolved.maxRetries + 1
        : routePolicy.maxAttemptsPerBinding
    ),
  }
}

function collectFileRefBlocks(
  blocks: CanonicalContentBlock[]
): Extract<CanonicalContentBlock, { type: "file_ref" }>[] {
  return blocks.filter(
    (block): block is Extract<CanonicalContentBlock, { type: "file_ref" }> =>
      block.type === "file_ref"
  )
}

function mergeContentBlocks(
  baseBlocks: CanonicalContentBlock[],
  extraBlocks: CanonicalContentBlock[]
): CanonicalContentBlock[] {
  const merged: CanonicalContentBlock[] = [...baseBlocks]
  const seenFileIds = new Set(
    merged
      .filter(
        (
          block
        ): block is Extract<CanonicalContentBlock, { type: "file_ref" }> =>
          block.type === "file_ref"
      )
      .map((block) => block.sha256)
  )

  for (const block of extraBlocks) {
    if (block.type === "text") {
      if (block.text) merged.push(block)
      continue
    }
    if (block.type === "mention") {
      merged.push(block)
      continue
    }
    if (seenFileIds.has(block.sha256)) continue
    seenFileIds.add(block.sha256)
    merged.push(block)
  }

  return merged
}

async function buildResponseContentBlocks(
  textContent: string,
  options: InlineReferenceResolveOptions | undefined
): Promise<CanonicalContentBlock[]> {
  const segments = parseInlineReferenceSegments(textContent)
  if (!segments.some((segment) => segment.type !== "text")) {
    return textContent ? [textBlock(textContent)] : []
  }

  const resolved = await resolveInlineReferenceSegments(segments, options)
  if (resolved.warnings.length > 0) {
    log.warn(
      `[actorThink] Inline reference warnings: ${resolved.warnings.join("; ")}`
    )
  }
  return resolved.blocks
}

async function buildMergedResponseContentBlocks(
  textContent: string,
  supplementalBlocks: CanonicalContentBlock[],
  options?: InlineReferenceResolveOptions
): Promise<CanonicalContentBlock[]> {
  const baseBlocks = await buildResponseContentBlocks(textContent, options)
  return mergeContentBlocks(baseBlocks, supplementalBlocks)
}

function buildInlineReferenceOptions(params: {
  conversationParticipants?: ConversationParticipantEntry[]
  workspaceMemberId?: string
  userName?: string
}): InlineReferenceResolveOptions | undefined {
  const mentionCandidates = (params.conversationParticipants || []).map(
    conversationParticipantEntryToEntityRef
  )
  const defaultUser = buildDefaultUserMention({
    workspaceMemberId: params.workspaceMemberId,
    userName: params.userName,
  })

  if (mentionCandidates.length === 0 && !defaultUser) {
    return undefined
  }

  return {
    mentionCandidates,
    defaultUser,
  }
}

interface Subordinate {
  name: string
  title: string
  summary: string
}

async function loadToolResolveConversationParticipants(params: {
  conversationId?: string
  actorId: string
  fallback?: ConversationParticipantEntry[]
}): Promise<ConversationParticipantEntry[] | undefined> {
  if (!params.conversationId) {
    return params.fallback
  }

  const members = await getLiveConversationParticipants(params.conversationId)
  const entries: ConversationParticipantEntry[] = []

  for (const member of members) {
    if (member.state !== "active") continue
    if (member.actorId) {
      entries.push({
        participantType: "actor",
        id: member.actorId,
        participantId: member.id,
        name: member.participantName || "Unknown actor",
        title: member.participantTitle || member.participantRole || "Actor",
        role: member.participantRole || undefined,
      })
      continue
    }
    if (member.userId) {
      const workspaceMemberId =
        typeof member.workspaceMemberId === "string" &&
        member.workspaceMemberId.trim().length > 0
          ? member.workspaceMemberId
          : null
      if (!workspaceMemberId) {
        throw new Error(
          `Conversation ${params.conversationId} has workspace participant ${member.id} without workspace_member_id`
        )
      }
      const transportKind = isTransportKind(member.transportKind)
        ? member.transportKind
        : undefined
      entries.push({
        participantType: "workspace_member",
        id: workspaceMemberId,
        participantId: member.id,
        name: member.userName || "User",
        title: transportKind
          ? `Workspace member · reachable via ${
              getTransportConnectorCapability(transportKind)?.displayName ??
              describeTransportKind(transportKind)
            }`
          : "Workspace member",
        role: "Workspace member",
      })
      continue
    }
    if (member.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL) {
      const linkedWorkspaceMemberName = member.linkedUserName || undefined
      entries.push({
        participantType: "external",
        id: member.linkedUserId || member.transportExternalId || member.id,
        participantId: member.id,
        name:
          member.transportDisplayName ||
          member.displayName ||
          linkedWorkspaceMemberName ||
          "External participant",
        title: linkedWorkspaceMemberName
          ? `Linked workspace user: ${linkedWorkspaceMemberName}`
          : "External participant",
        role: "External participant",
        linkedWorkspaceMemberId: member.linkedUserId || undefined,
        linkedWorkspaceMemberName,
        externalUserKey: member.transportExternalId || undefined,
      })
    }
  }

  return entries
}

// Map a routed ToolRef to the public ToolResultOrigin used by
// CanonicalToolResult. Used on the replan-skip path where the tool didn't
// actually run. A missing ref (stale / unknown wire name) falls back to a
// system origin.
function originFromRef(
  ref: ToolRef | undefined,
  fallbackName: string
): ToolResultOrigin {
  return ref
    ? toPublicOrigin(ref)
    : { kind: "system", registryKey: fallbackName }
}

function blocksToToolResultParts(blocks: CanonicalContentBlock[]) {
  return blocks.map((block) => {
    if (block.type === "text") {
      return { type: "text" as const, text: block.text }
    }
    if (block.type === "mention") {
      return {
        type: "json" as const,
        json: {
          type: "mention" as const,
          mention: block.mention,
        },
        mimeType: "application/vnd.synapse.mention+json",
        name: "mention",
        metadata: {
          displayText: formatMentionText(block),
        },
      }
    }
    return {
      type: "file_ref" as const,
      refPath: block.path ?? null,
      refSha256: block.sha256,
      mimeType: block.mimeType,
      name: block.name,
      metadata: {
        sha256: block.sha256,
        path: block.path,
        sizeBytes: block.sizeBytes,
        category: block.category,
      },
    }
  })
}

function buildSleepWithoutSendToReminder(params: {
  semantics: ReturnType<typeof resolveThreadSemantics>
  otherParticipants: ConversationParticipantEntry[]
  allowConfirmSleepWithoutReply: boolean
}): CanonicalContextItem {
  const otherMemberName =
    params.otherParticipants[0]?.name || "the other participant"

  if (params.semantics.addressingMode === "implicit_peer") {
    return {
      kind: "system_notice",
      noticeType: "task_instruction",
      scope: "private",
      surface: "internal",
      parts: textBlocks(
        `You called \`sleep\` before using \`send_to\` in this wakeup. Your reasoning and tool calls are invisible to everyone else. ` +
          `This is a direct thread, so \`send_to\` goes directly to ${otherMemberName}. ` +
          `Send a visible result, handoff, clarification, or explicit "no action needed" message with the correct \`intent\` and \`summary\`, then call \`sleep\` again.`
      ),
    }
  }

  return {
    kind: "system_notice",
    noticeType: "task_instruction",
    scope: "private",
    surface: "internal",
    parts: textBlocks(
      params.allowConfirmSleepWithoutReply
        ? `You called \`sleep\` before using \`send_to\` in this wakeup. Your reasoning and tool calls are invisible to other conversation participants unless you use \`send_to\`. ` +
            `Before sleeping, either send a visible update, result, handoff, clarification, or explicit "no action needed" message to the relevant participant(s), or if the wakeup is truly unrelated to you and the message already reached the correct assignee, call \`sleep\` again now to confirm that no visible reply from you is needed.`
        : `You called \`sleep\` again without using \`send_to\`. Your reasoning and tool calls are still invisible to other conversation participants. ` +
            `If no visible reply from you is genuinely needed because the wakeup is entirely unrelated to you and the correct assignee already received it, you may remain asleep. Otherwise, use \`send_to\` now before sleeping.`
    ),
  }
}

// A per-turn registry mapping the wire name the model sees to the routed
// ToolRef. Built by NamePolicy from the projected mcp/device tools; system
// callable tools occupy the collision space as reserved bare names.
interface ToolWireRegistry {
  /** wireName -> ref for mcp/device routed tools. */
  refByWireName: Map<string, ToolRef>
  /** wire-named ToolDefinitions to send to the provider (binding stripped). */
  wireTools: ToolDefinition[]
  /** wire names of mcp/device tools (the "mcp bucket" membership set). */
  mcpWireNames: Set<string>
}

function buildToolWireRegistry(
  projected: ProjectedToolDefinition[],
  reservedNames: readonly string[]
): ToolWireRegistry {
  const items: NamePolicyItem[] = projected.map((tool) => ({
    ref: tool.ref,
    leafName: tool.name,
  }))
  const registry: NameRegistry = computeWireNames(items, reservedNames)
  const refByWireName = new Map<string, ToolRef>()
  const wireTools: ToolDefinition[] = []
  const mcpWireNames = new Set<string>()
  const defByToolId = new Map<string, ProjectedToolDefinition>(
    projected.map((t) => [t.ref.toolId, t])
  )
  for (const [toolId, { wireName, ref }] of registry.byToolId) {
    const def = defByToolId.get(toolId)!
    refByWireName.set(wireName, ref)
    mcpWireNames.add(wireName)
    wireTools.push(stripForProvider({ definition: def, wireName }))
  }
  return { refByWireName, wireTools, mcpWireNames }
}

// Derive the tool_calls provenance columns for one model tool call. A routed
// ref (plugin/device) yields its snapshot + soft pointer; everything else is a
// system tool whose source is the bare wire name.
function toolCallProvenance(
  wireName: string,
  ref: ToolRef | undefined
): {
  sourceKind: ToolSourceKind
  sourceSnapshot: SourceSnapshot
  pluginInstallationId: string | null
  deviceToolId: string | null
} {
  if (!ref) {
    return {
      sourceKind: "system",
      // System stableKey IS the registry/wire name (systemToolId(registryKey)).
      // Persist it on the snapshot so the display resolver dispatches uniformly
      // off source_snapshot.stableKey across all source kinds.
      sourceSnapshot: {
        kind: "system",
        registryKey: wireName,
        stableKey: wireName,
      },
      pluginInstallationId: null,
      deviceToolId: null,
    }
  }
  const snapshot = stripForAuditSnapshot(ref)
  return {
    sourceKind: ref.source.kind,
    sourceSnapshot: snapshot,
    pluginInstallationId:
      ref.source.kind === "plugin" ? ref.source.installationId : null,
    deviceToolId: ref.source.kind === "device" ? ref.source.deviceToolId : null,
  }
}

function classifyMcpExecutionError(error: unknown) {
  const raw =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : null
  const code = typeof raw?.code === "string" ? raw.code : undefined
  const requiresReplan =
    raw?.requiresReplan === true ||
    code === "tool_definition_changed" ||
    code === "tool_removed"
  const message = ((): string => {
    if (typeof raw?.message === "string" && raw.message.trim().length > 0) {
      return raw.message
    }
    if (error instanceof Error) {
      return error.message
    }
    return String(error || "MCP tool execution failed")
  })()

  return {
    code,
    message,
    requiresReplan,
  }
}

function formatMcpExecutionErrorMessage(
  message: string,
  requiresReplan: boolean,
  skipped = false
) {
  if (!requiresReplan) {
    return `Error: ${message}`
  }
  if (skipped) {
    return "Error: Skipped because another MCP tool changed during execution. Re-read the latest tool definitions before retrying."
  }
  if (/re-read the latest tool definition/i.test(message)) {
    return `Error: ${message}`
  }
  return `Error: ${message} Re-read the latest tool definitions before retrying.`
}

function getToolErrorDetails(metadata?: Record<string, unknown>): {
  kind?: "model_actionable" | "internal"
  retryable?: boolean
  code?: string
} {
  const raw =
    typeof metadata?.toolError === "object" && metadata.toolError !== null
      ? (metadata.toolError as Record<string, unknown>)
      : null

  return {
    kind:
      raw?.kind === "model_actionable" || raw?.kind === "internal"
        ? raw.kind
        : undefined,
    retryable: typeof raw?.retryable === "boolean" ? raw.retryable : undefined,
    code: typeof raw?.code === "string" ? raw.code : undefined,
  }
}

function buildCallableInternalErrorNotice(toolNames: string[]) {
  const uniqueToolNames = Array.from(new Set(toolNames))
  const renderedToolNames = uniqueToolNames
    .map((toolName) => `\`${toolName}\``)
    .join(", ")
  return {
    kind: "system_notice" as const,
    noticeType: "task_instruction" as const,
    scope: "private" as const,
    surface: "internal" as const,
    parts: textBlocks(
      `The callable tool(s) ${renderedToolNames} failed with internal system errors. ` +
        `These failures are not fixable by changing tool arguments alone. ` +
        `Do not retry the same failing call unless external state has changed. ` +
        `Choose an alternate path, send a visible status/failure update if needed, or sleep.`
    ),
  }
}

export async function actorThink(
  actor: Actor,
  contextWindow: ProviderContextWindow,
  subordinates?: Subordinate[],
  modelPlan?: ResolvedModelPlan | null,
  workspaceId?: string,
  options?: {
    sessionId?: string
    turnId?: string
    collaborationMode?: SessionCollaborationMode
    conversationId?: string
    conversationKind?: "direct" | "group"
    isImConversation?: boolean
    conversationParticipants?: ConversationParticipantEntry[]
    userId?: string
    workspaceMemberId?: string
    availableSkills?: AvailableSkillSummary[]
    onStatus?: (status: string) => Promise<void>
    mcpTools?: ProjectedToolDefinition[]
    mcpExecutor?: (
      toolId: string,
      input: Record<string, unknown>,
      executionContext?: McpExecutionContext
    ) => Promise<NormalizedMcpToolResult>
    mcpVersion?: number
    mcpRefresh?: () => Promise<{
      tools: ProjectedToolDefinition[]
      mcpVersion: number
    }>
    mcpSetTurnId?: (turnId: string, round?: number) => void
    system: string
    checkNewMessages?: () => Promise<CanonicalContextItem[] | null>
    refreshCollaborationContext?: () => Promise<{
      collaborationMode?: SessionCollaborationMode
      system?: string
    }>
    shouldAbortTurn?: () => Promise<boolean>
  }
): Promise<ThinkingResult> {
  const actorDefinition = actor.definition ?? actor
  let currentSystem = options?.system || ""
  let currentCollaborationMode = options?.collaborationMode || "default"
  let allTools: import("@synapse/shared").ToolDefinition[] = []
  // No env fallback: a turn can only run against a resolved model plan that came
  // from a configured model group. If resolution produced nothing, fail loud so
  // the worker marks the turn failed + session blocked (see session-thinking
  // catch) instead of silently limping along on absent env config.
  if (!modelPlan || modelPlan.candidates.length === 0) {
    throw new Error(
      `No model group configured for actor ${actor.id} in workspace ${workspaceId ?? "(unknown)"}. ` +
        "Run 'npm run db:seed:model-groups' or configure a platform model group in the UI."
    )
  }
  const effectiveModelPlan = modelPlan

  const allContextWindow: ProviderContextWindow = {
    manifest: contextWindow.manifest,
    sharedArchivePoint: contextWindow.sharedArchivePoint,
    sharedTailItems: [...contextWindow.sharedTailItems],
    privateArchivePoint: contextWindow.privateArchivePoint,
    privateTailItems: [...contextWindow.privateTailItems],
    orderedTailItems: [...contextWindow.orderedTailItems],
  }

  const appendSharedTailItems = (items: CanonicalContextItem[]) => {
    if (items.length === 0) return
    allContextWindow.sharedTailItems.push(...items)
    allContextWindow.orderedTailItems.push(...items)
  }

  const appendPrivateTailItems = (items: CanonicalContextItem[]) => {
    if (items.length === 0) return
    allContextWindow.privateTailItems.push(...items)
    allContextWindow.orderedTailItems.push(...items)
  }

  const buildRequestLog = (
    round: number,
    resolved?: ResolvedModelConfig | null,
    attempt?: number
  ) => ({
    provider: resolved?.vendor || "",
    providerKind: resolved?.providerKind || "",
    model: resolved?.modelName || "",
    round,
    attempt: attempt || 1,
    groupId: effectiveModelPlan.groupId,
    groupName: effectiveModelPlan.groupName,
    candidateBindingIds: effectiveModelPlan.candidates.map(
      (candidate: ResolvedModelConfig) => candidate.bindingId
    ),
    system: currentSystem,
    contextWindow: allContextWindow,
    tools: allTools,
    serverTools: resolved?.serverTools || null,
    multimodal: resolved?.multimodal || null,
  })

  // MCP/device tools (already resolved and authorized by tool-resolver.ts /
  // capability-projection). These carry Layer-A ToolRefs; the per-turn
  // NameRegistry assigns each a collision-safe wire name and lets dispatch map
  // wireName -> toolId -> ref without parsing the name.
  const initialMcpToolDefs = options?.mcpTools || []
  let mcpToolDefs = isPlanCollaborationMode(currentCollaborationMode)
    ? []
    : initialMcpToolDefs
  // Per-turn wire-name registry (rebuilt whenever the tool set changes). Until
  // refreshLocalCallableTools runs it is empty.
  let toolWireRegistry: ToolWireRegistry = {
    refByWireName: new Map(),
    wireTools: [],
    mcpWireNames: new Set(),
  }
  // Union of every candidate's provider-native server tool names. These keys
  // are merged into the ToolSet via buildServerTools after buildAiTools, so the
  // NameRegistry must reserve them (any candidate may be selected at attempt
  // time). Anthropic-only today; the providerKind gate lives in buildServerTools.
  const providerNativeReservedNames = Array.from(
    new Set(
      effectiveModelPlan.candidates.flatMap(
        (candidate: ResolvedModelConfig) => candidate.serverTools ?? []
      )
    )
  )
  let currentToolConversationParticipants = options?.conversationParticipants
  const getThreadSemantics = () =>
    resolveThreadSemantics({
      kind: options?.conversationKind,
      otherParticipantCount:
        currentToolConversationParticipants?.filter(
          (participant) =>
            !(
              participant.participantType ===
                CONVERSATION_PARTICIPANT_TYPE.ACTOR &&
              participant.id === actor.id
            )
        ).length || 0,
    })
  const buildResolveCtx = (): ToolResolveContext => ({
    sessionId: options?.sessionId || "",
    actorId: actor.id,
    workspaceId: workspaceId || "",
    collaborationMode: currentCollaborationMode,
    conversationId: options?.conversationId,
    conversationKind: options?.conversationKind,
    isImConversation: options?.isImConversation,
    conversationParticipants: currentToolConversationParticipants,
    workspaceMemberId: options?.workspaceMemberId,
    availableSkills: options?.availableSkills,
  })
  const getInlineReferenceOptions = () =>
    buildInlineReferenceOptions({
      conversationParticipants: currentToolConversationParticipants,
      workspaceMemberId: options?.workspaceMemberId,
    })
  const refreshLocalCallableTools = async (): Promise<
    import("@synapse/shared").ToolDefinition[]
  > => {
    if (options?.refreshCollaborationContext) {
      const refreshed = await options.refreshCollaborationContext()
      if (refreshed?.collaborationMode) {
        currentCollaborationMode = refreshed.collaborationMode
      }
      if (typeof refreshed?.system === "string") {
        currentSystem = refreshed.system
      }
    } else if (options?.sessionId) {
      const refreshedSession = await getSession(options.sessionId).catch(
        () => null
      )
      if (refreshedSession?.collaborationMode) {
        currentCollaborationMode = refreshedSession.collaborationMode
      }
    }

    if (isPlanCollaborationMode(currentCollaborationMode)) {
      mcpToolDefs = []
    } else if (
      mcpToolDefs.length === 0 &&
      initialMcpToolDefs.length > 0 &&
      !options?.mcpRefresh
    ) {
      mcpToolDefs = initialMcpToolDefs
    }

    currentToolConversationParticipants =
      await loadToolResolveConversationParticipants({
        conversationId: options?.conversationId,
        actorId: actor.id,
        fallback: currentToolConversationParticipants,
      })
    const resolvedCallable = await resolveLocalCallableTools(buildResolveCtx())
    // Reserved names the NameRegistry must NOT hand to a plugin/device tool:
    //   - system (callable) tool names — kept bare, collisions qualify.
    //   - provider-native server tool names (web_search/web_fetch) that any
    //     candidate may merge into the ToolSet after buildAiTools (see the
    //     `...buildServerTools(...)` spread). Without reserving these, a plugin
    //     /device tool NamePolicy happened to name `web_search` would be
    //     silently shadowed by the server tool, desyncing model<->routing.
    const reservedNames = [
      ...resolvedCallable.map((tool) => tool.name),
      ...providerNativeReservedNames,
    ]
    toolWireRegistry = buildToolWireRegistry(mcpToolDefs, reservedNames)
    const filteredCallable = resolvedCallable.filter(
      (tool) => !toolWireRegistry.mcpWireNames.has(tool.name)
    )
    allTools = [...filteredCallable, ...toolWireRegistry.wireTools]
    return resolvedCallable
  }
  await refreshLocalCallableTools()
  let currentMcpVersion = options?.mcpVersion ?? 0

  const turnId = options?.turnId || randomUUID()
  const executionEnabled = !!options?.turnId && !!options?.conversationId
  const totalTokens = { input: 0, output: 0 }
  let providerStepIndex = 0

  const allToolsUsed: string[] = [] // track executable tools invoked
  const allServerToolCalls: ServerToolCall[] = [] // track cloud-side tool calls
  let allCitationSources: Record<string, { url: string; title: string }> = {} // cite index → source
  const onStatus = options?.onStatus

  // Accumulate ToolRound[] for DB storage only (not passed to provider)
  const toolRounds: ToolRound[] = []
  // Accumulate media attachments from MCP/model responses
  const allSupplementalBlocks: CanonicalContentBlock[] = []
  let finalDraftText = ""
  // True once at least one provider round produced a draft (a "final draft"
  // response that downstream prefers over finalTextContent). Replaces the old
  // finalDraftProvider object — we only need the boolean.
  let usedDraftProvider = false
  let sendToCalledThisTurn = false
  let sleepWithoutSendToReminderCount = 0

  // Common fields for logAIRequest
  const logCommon = {
    workspaceId,
    actorId: actor.id,
    sessionId: options?.sessionId,
    turnId,
    groupId: effectiveModelPlan.groupId,
    requestType: "actor_think" as const,
  }

  // Set tool execution context for session-aware callable tools
  // Uses AsyncLocalStorage — each concurrent call gets its own context
  if (options?.sessionId) {
    return runWithToolContext(
      {
        sessionId: options.sessionId,
        actorId: actor.id,
        workspaceId: workspaceId || "",
        userId: options.userId,
        turnId,
        conversationId: options.conversationId,
        conversationKind: options.conversationKind,
        isImConversation: options.isImConversation,
      },
      () => _actorThinkInner()
    )
  }
  return _actorThinkInner()

  async function _actorThinkInner(): Promise<ThinkingResult> {
    const abortIfRequested = async () => {
      if (!(await options?.shouldAbortTurn?.())) {
        return
      }
      throw new TurnInterruptedError(
        "Current turn was interrupted because the user terminated remote desktop control."
      )
    }

    const recordProviderRound = async (params: {
      round: number
      attempt: number
      resolved: ResolvedModelConfig
      latencyMs: number
      status: "success" | "error" | "timeout"
      requestBody: unknown
      responseBody?: unknown
      stopReason?: string
      inputTokens: number
      outputTokens: number
      errorMessage?: string
    }) => {
      const stepIndex = ++providerStepIndex
      if (executionEnabled) {
        return logProviderStep({
          turnId: options!.turnId!,
          stepIndex,
          providerType: params.resolved.vendor,
          requestType: "actor_think",
          modelGroupId: effectiveModelPlan.groupId,
          modelBindingId: params.resolved.bindingId,
          modelBindingVersionId: params.resolved.bindingVersionId,
          modelName: params.resolved.modelName,
          capabilitiesSnapshot: {
            providerKind: params.resolved.providerKind,
            apiStyle: params.resolved.apiStyle || null,
            serverTools: params.resolved.serverTools || [],
            multimodal: params.resolved.multimodal || null,
            toolNames: allTools.map((tool) => tool.name),
            attempt: params.attempt,
            round: params.round,
          },
          requestPayload: params.requestBody,
          responsePayload: params.responseBody,
          stopReason: params.stopReason,
          inputTokens: params.inputTokens,
          outputTokens: params.outputTokens,
          latencyMs: params.latencyMs,
          status: params.status,
          errorMessage: params.errorMessage,
        })
      }

      await logAIRequest({
        ...logCommon,
        round: stepIndex,
        bindingId: params.resolved.bindingId,
        bindingVersionId: params.resolved.bindingVersionId,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        latencyMs: params.latencyMs,
        status: params.status,
        errorMessage: params.errorMessage,
        requestBody: params.requestBody,
        responseBody: params.responseBody,
      })
      return null
    }

    const executeProviderRound = async (round: number) => {
      const routePolicy =
        effectiveModelPlan.attemptPolicy || DEFAULT_ATTEMPT_POLICY
      const perBindingAttempts = new Map<string, number>()
      let totalAttempts = 0
      let lastError: Error | null = null

      candidateLoop: for (const candidate of effectiveModelPlan.candidates) {
        const candidatePolicy = effectiveAttemptPolicy(routePolicy, candidate)
        while (true) {
          const priorAttempts = perBindingAttempts.get(candidate.bindingId) || 0
          if (priorAttempts >= candidatePolicy.maxAttemptsPerBinding) break
          if (totalAttempts >= routePolicy.maxAttemptsTotal) break candidateLoop

          const attempt = priorAttempts + 1
          perBindingAttempts.set(candidate.bindingId, attempt)
          totalAttempts += 1

          const requestBody = buildRequestLog(round, candidate, attempt)
          const attemptStart = Date.now()

          try {
            // Compile the provider-neutral canonical window once per candidate
            // (multimodal/feature degradation is candidate-specific), reconcile
            // tool-call/result pairing (the SDK rejects orphan tool calls), then
            // let the AI SDK fan the neutral ModelMessage[] out to this
            // candidate's wire format. No branch-state: every turn rebuilds from
            // canonical (validated cross-provider in the migration spikes).
            const conversationMessages =
              await compileContextWindowToConversationMessages(allContextWindow)
            const reconciled = reconcileToolPairing(conversationMessages)
            const modelMessages = await toModelMessages(reconciled, {
              multimodal: candidate.multimodal,
            })

            // Merge custom (execute-less) tools with provider-defined server
            // tools (Anthropic web_search/web_fetch) for this candidate.
            const customTools = buildAiTools(allTools)
            const serverTools = buildServerTools(
              candidate.providerKind,
              candidate.serverTools
            )
            // Invariant: server tool names are reserved in the NameRegistry, so
            // they must never collide with a custom (plugin/device/system) tool
            // name. If this fires, a provider-native name leaked into the wire
            // surface and the spread below would silently shadow it.
            for (const serverToolName of Object.keys(serverTools)) {
              if (serverToolName in customTools) {
                throw new Error(
                  `Tool name collision: provider-native server tool "${serverToolName}" ` +
                    `collides with a custom tool. NamePolicy must reserve it.`
                )
              }
            }
            const aiTools = {
              ...customTools,
              ...serverTools,
            }

            // Real cancellation on timeout: AbortController fed to the SDK so the
            // underlying provider request is actually aborted (the legacy
            // withTimeout only rejected the promise, leaking the request).
            const abortController = new AbortController()
            const timeoutHandle = setTimeout(
              () => abortController.abort(new Error("Model attempt timed out")),
              candidatePolicy.timeoutMsPerAttempt
            )
            let result
            try {
              result = await generateText({
                model: languageModelFor(candidate),
                system: currentSystem,
                messages: modelMessages,
                tools: aiTools,
                toolChoice:
                  Object.keys(aiTools).length > 0 ? "auto" : undefined,
                maxOutputTokens: candidate.maxOutputTokens,
                // single step: Synapse runs its own agent loop + tool executor
                stopWhen: stepCountIs(1),
                abortSignal: abortController.signal,
                // Per-binding provider-native options (cache control, reasoning,
                // beta headers, ...) passed through verbatim to the SDK provider.
                ...(candidate.providerOptions
                  ? { providerOptions: candidate.providerOptions as any }
                  : {}),
              })
            } finally {
              clearTimeout(timeoutHandle)
            }

            const response = fromGenerateText(result)

            const assistantMsg = response.context[0]
            const textContent =
              assistantMsg?.role === "assistant"
                ? extractText(assistantMsg.content)
                : ""
            const toolCalls =
              assistantMsg?.role === "assistant" && assistantMsg.toolCalls
                ? assistantMsg.toolCalls
                : []

            const providerStep = await recordProviderRound({
              round,
              attempt,
              resolved: candidate,
              latencyMs: Date.now() - attemptStart,
              status: "success",
              // request_payload: what Synapse intended (synapseRequest = the
              // group/candidate/tool framing) + the SDK's RAW outgoing request
              // body (sdkRequest, exact bytes sent to the provider).
              requestBody: {
                synapseRequest: requestBody,
                sdkRequest: response.rawRequestBody,
                bindingVersionId: candidate.bindingVersionId,
                providerKind: candidate.providerKind,
                vendor: candidate.vendor,
                modelName: candidate.modelName,
              },
              // response_payload: the SDK's RAW provider response + a parsed
              // summary for quick reads.
              responseBody: {
                sdkResponse: response.rawAssistantMessage,
                stopReason: response.stopReason,
                toolCalls: toolCalls.map((tc: any) => ({
                  callId: tc.callId,
                  providerCallId: tc.providerCallId,
                  toolName: tc.toolName,
                  input: tc.input,
                })),
                textContent,
              },
              stopReason: response.stopReason,
              inputTokens: response.tokensUsed.input,
              outputTokens: response.tokensUsed.output,
            }).catch((err) => {
              log.error(
                { err: err.message },
                "[actorThink] Failed to log provider step"
              )
              return null
            })

            return { response, resolved: candidate, providerStep }
          } catch (err: any) {
            const error = err instanceof Error ? err : new Error(String(err))
            lastError = error
            const errorType = classifyModelError(error)
            const status = errorType === "timeout" ? "timeout" : "error"

            await recordProviderRound({
              round,
              attempt,
              resolved: candidate,
              latencyMs: Date.now() - attemptStart,
              status,
              requestBody,
              inputTokens: 0,
              outputTokens: 0,
              errorMessage: error.message,
            }).catch(() => {})

            if (routePolicy.stopOn.includes(errorType)) {
              throw error
            }

            const canRetrySameBinding =
              routePolicy.continueOn.includes(errorType) &&
              attempt < candidatePolicy.maxAttemptsPerBinding &&
              totalAttempts < routePolicy.maxAttemptsTotal

            if (canRetrySameBinding) {
              const backoff =
                candidatePolicy.retryBackoffMs[
                  Math.min(
                    attempt - 1,
                    candidatePolicy.retryBackoffMs.length - 1
                  )
                ] || 0
              await delay(backoff)
              continue
            }

            break
          }
        }
      }

      if (lastError) throw lastError
      throw new Error("No eligible model candidates available for this request")
    }

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const currentRound = round + 1

      // Set turn+round context for MCP executor
      if (options?.mcpSetTurnId) options.mcpSetTurnId(turnId, currentRound)

      await abortIfRequested()

      if (onStatus) {
        await onStatus("Calling AI model...")
      }

      const {
        response,
        resolved: selectedResolved,
        providerStep,
      } = await executeProviderRound(currentRound)

      totalTokens.input += response.tokensUsed.input
      totalTokens.output += response.tokensUsed.output

      // Extract from canonical context
      const assistantMsg = response.context[0]
      const textContent =
        assistantMsg?.role === "assistant"
          ? extractText(assistantMsg.content)
          : ""
      const toolCalls =
        assistantMsg?.role === "assistant" && assistantMsg.toolCalls
          ? assistantMsg.toolCalls
          : []

      log.info(
        `[actorThink] actor=${actor.id} turn=${turnId.slice(0, 8)} round=${currentRound} stopReason=${response.stopReason} toolCalls=[${toolCalls.map((tc: any) => tc.toolName).join(",")}] textLen=${textContent.length}`
      )

      // Ingest response media → CanonicalContentBlock[] for ToolRound.content
      let roundMediaBlocks: CanonicalContentBlock[] = []
      if (
        response.mediaBlocks &&
        response.mediaBlocks.length > 0 &&
        workspaceId
      ) {
        try {
          roundMediaBlocks = await ingestResponseMedia(
            response.mediaBlocks,
            selectedResolved.vendor || "anthropic",
            workspaceId
          )
          allSupplementalBlocks.push(...collectFileRefBlocks(roundMediaBlocks))
        } catch (err: any) {
          log.error(
            { err: err.message },
            "[actorThink] Failed to ingest response media"
          )
        }
      }

      const serverCalls = response.serverToolCalls || []
      if (serverCalls.length > 0) {
        allServerToolCalls.push(...serverCalls)
        if (onStatus) {
          const labels = serverCalls.map((sc) => {
            if (sc.type === MODEL_SERVER_TOOL.WEB_SEARCH)
              return `Searching "${sc.query || "..."}"`
            if (sc.type === MODEL_SERVER_TOOL.WEB_FETCH)
              return `Fetching ${sc.url || "..."}`
            return sc.type
          })
          await onStatus(labels.join(", "))
        }
      }

      const citations = response.citationSources
      if (citations) {
        allCitationSources = { ...allCitationSources, ...citations }
      }

      const finalTextContent = textContent
      if (finalTextContent.trim().length > 0 || roundMediaBlocks.length > 0) {
        finalDraftText = finalTextContent
        usedDraftProvider = true
      }

      // Dispatch: local callables and projected MCP/device tools. The model
      // emits WIRE names; mcp/device membership is by NameRegistry, the rest are
      // callable (system) tools. Unknown/stale names land in the callable bucket
      // so executeCallableTools returns a model-actionable unknown_tool result.
      const mcpCalls = toolCalls.filter((tc: any) =>
        toolWireRegistry.mcpWireNames.has(tc.toolName)
      )
      const callableCalls = toolCalls.filter(
        (tc: any) => !toolWireRegistry.mcpWireNames.has(tc.toolName)
      )
      const allContinuableCalls = [...callableCalls, ...mcpCalls]
      const sendToPlanned = callableCalls.some(
        (tc: any) => tc.toolName === "send_to" && isCallableTool(tc.toolName)
      )

      if (allContinuableCalls.length > 0) {
        if (sendToPlanned && options?.checkNewMessages) {
          try {
            const newMsgs = await options.checkNewMessages()
            if (newMsgs && newMsgs.length > 0) {
              appendSharedTailItems(newMsgs)
              if (onStatus) {
                await onStatus("Conversation updated. Re-analyzing...")
              }
              log.info(
                `[actorThink] Conversation changed before send_to; rethinking with ${newMsgs.length} new message(s)`
              )
              await refreshLocalCallableTools()
              continue
            }
          } catch (err: any) {
            log.error(
              { err: err.message },
              "[actorThink] send_to preflight checkNewMessages failed"
            )
          }
        }

        if (sendToPlanned) {
          sendToCalledThisTurn = true
        }

        // Track executable tool names and emit status
        const toolNames = allContinuableCalls.map((tc: any) => tc.toolName)
        allToolsUsed.push(...toolNames)
        if (onStatus) {
          await onStatus(`Calling ${toolNames.join(", ")}...`)
        }

        const roundBundleId = randomUUID()
        const toolCallRows = new Map<string, any>()
        if (executionEnabled) {
          for (
            let callIndex = 0;
            callIndex < allContinuableCalls.length;
            callIndex++
          ) {
            const tc = allContinuableCalls[callIndex]
            const dispatchRef = toolWireRegistry.refByWireName.get(tc.toolName)
            const provenance = toolCallProvenance(tc.toolName, dispatchRef)
            const row = await createToolCall({
              id: tc.callId,
              turnId: options!.turnId!,
              providerStepId: providerStep?.id,
              conversationId: options!.conversationId!,
              sessionId: options?.sessionId,
              callIndex,
              providerCallId: tc.providerCallId,
              bundleId: roundBundleId,
              toolName: tc.toolName,
              sourceKind: provenance.sourceKind,
              sourceSnapshot: provenance.sourceSnapshot,
              pluginInstallationId: provenance.pluginInstallationId,
              deviceToolId: provenance.deviceToolId,
              normalizedInput: tc.input,
            })
            if (!row) {
              throw new Error(`Failed to create tool call for ${tc.toolName}`)
            }
            toolCallRows.set(tc.callId, row)
            await updateToolCallStatus(row.id, "running")
          }
        }

        // Execute callable tools (builtin registry)
        const callableResults = []
        for (const tc of callableCalls) {
          const callRow = toolCallRows.get(tc.callId)
          const attempt =
            executionEnabled && callRow
              ? await createToolExecutionAttempt({
                  toolCallId: callRow.id,
                  attemptNo: 1,
                  transport: "callable",
                  requestPayload: tc.input,
                })
              : null
          const attemptStart = Date.now()
          const [res] = await runWithToolContext(
            {
              sessionId: options?.sessionId || "",
              actorId: actor.id,
              workspaceId: workspaceId || "",
              userId: options?.userId,
              turnId,
              conversationId: options?.conversationId,
              toolCallId: tc.callId,
              toolName: tc.toolName,
            },
            () => executeCallableTools([tc])
          )
          callableResults.push(res)

          if (executionEnabled && callRow && attempt) {
            const blocks = res.content
            const structuredContent = readToolResultStructuredContent(res)
            const persistedMetadata: Record<string, unknown> = {
              ...(res.metadata || {}),
              origin: { kind: "system", registryKey: tc.toolName },
              ...(structuredContent !== undefined ? { structuredContent } : {}),
              toolCallId: tc.callId,
              toolName: tc.toolName,
              ...(tc.providerCallId
                ? { providerCallId: tc.providerCallId }
                : {}),
              ...(res.isError !== undefined ? { isError: res.isError } : {}),
            }
            // Phase 2 (R1): namespace the callable's structured result under
            // `toolMeta` for the presentation renderer (meta.*). res.metadata is
            // still spread top-level above for back-compat consumers.
            const callableToolMeta = buildToolMeta({
              meta: res.metadata,
              structuredContent,
            })
            if (callableToolMeta) persistedMetadata.toolMeta = callableToolMeta
            // Phase 7b: res.content is strictly CanonicalContentBlock[] post
            // Phase 3, so the old `typeof res.content === "string"` check is
            // dead. Use extractText to get a meaningful error message body.
            const errorMessage = res.isError
              ? extractText(blocks) || `Tool ${tc.toolName} failed`
              : undefined
            await finalizeToolExecutionAttempt({
              attemptId: attempt.id,
              status: res.isError ? "error" : "success",
              isError: res.isError,
              errorMessage,
              durationMs: Date.now() - attemptStart,
              responsePayload: res,
            })
            await createToolResult({
              toolCallId: callRow.id,
              attemptId: attempt.id,
              isError: res.isError,
              errorMessage,
              metadata: persistedMetadata,
              parts: blocksToToolResultParts(blocks),
            })
            await updateToolCallStatus(
              callRow.id,
              res.isError ? "failed" : "completed"
            )
          }
        }

        const callableInternalErrorToolNames = callableResults
          .filter(
            (result) =>
              result.isError &&
              getToolErrorDetails(result.metadata).kind === "internal"
          )
          .map((result) => result.toolName)

        // Execute MCP tools via mcpExecutor, with content ingestion
        const mcpResults: {
          toolCallId: string
          providerCallId?: string
          toolName: string
          content: CanonicalContentBlock[]
          isError?: boolean
          structuredContent?: Record<string, unknown>
          origin: ToolResultOrigin
          metadata?: Record<string, unknown>
        }[] = []
        let mcpReplanRequired = false
        if (mcpCalls.length > 0 && options?.mcpExecutor) {
          const appendMcpFailureResult = async (params: {
            tc: (typeof mcpCalls)[number]
            callRow: any
            attempt?: { id: string } | null
            attemptStart: number
            message: string
            metadata?: Record<string, unknown>
            responsePayload?: unknown
            origin?: ToolResultOrigin
          }) => {
            const content = textBlocks(params.message)
            const origin =
              params.origin ??
              originFromRef(
                toolWireRegistry.refByWireName.get(params.tc.toolName),
                params.tc.toolName
              )
            const failureMetadata: Record<string, unknown> = {
              ...(params.metadata || {}),
              toolCallId: params.tc.callId,
              toolName: params.tc.toolName,
              ...(params.tc.providerCallId
                ? { providerCallId: params.tc.providerCallId }
                : {}),
              isError: true,
              origin,
            }
            mcpResults.push({
              toolCallId: params.tc.callId,
              providerCallId: params.tc.providerCallId,
              toolName: params.tc.toolName,
              content,
              isError: true,
              origin,
              metadata: failureMetadata,
            })

            if (executionEnabled && params.callRow) {
              const attemptRow =
                params.attempt ??
                (await createToolExecutionAttempt({
                  toolCallId: params.callRow.id,
                  attemptNo: 1,
                  transport: "mcp",
                  requestPayload: params.tc.input,
                }))
              if (attemptRow) {
                await finalizeToolExecutionAttempt({
                  attemptId: attemptRow.id,
                  status: "error",
                  isError: true,
                  errorMessage: params.message,
                  durationMs: Date.now() - params.attemptStart,
                  responsePayload: params.responsePayload ?? {
                    error: params.message,
                  },
                })
                await createToolResult({
                  toolCallId: params.callRow.id,
                  attemptId: attemptRow.id,
                  isError: true,
                  errorMessage: params.message,
                  metadata: failureMetadata,
                  parts: blocksToToolResultParts(content),
                })
                await updateToolCallStatus(params.callRow.id, "failed")
              }
            }
          }

          for (let mcpIndex = 0; mcpIndex < mcpCalls.length; mcpIndex++) {
            const tc = mcpCalls[mcpIndex]
            const callRow = toolCallRows.get(tc.callId)
            const attempt =
              executionEnabled && callRow
                ? await createToolExecutionAttempt({
                    toolCallId: callRow.id,
                    attemptNo: 1,
                    transport: "mcp",
                    requestPayload: tc.input,
                  })
                : null
            const attemptStart = Date.now()
            const dispatchRef = toolWireRegistry.refByWireName.get(tc.toolName)
            try {
              const normalizedResult = await options.mcpExecutor(
                // Route by the deterministic toolId, not the wire name. (mcpCalls
                // membership guarantees a ref; fall back to the name only to
                // surface a clean "no instance" error if the registry drifted.)
                dispatchRef ? dispatchRef.toolId : tc.toolName,
                tc.input,
                {
                  workspaceId: workspaceId || "",
                  sessionId: options?.sessionId,
                  conversationId: options?.conversationId,
                  actorId: actor.id,
                  userId: options?.userId,
                  workspaceMemberId: options?.workspaceMemberId,
                  turnId,
                  toolCallId: tc.callId,
                  providerCallId: tc.providerCallId,
                  namespacedToolName: tc.toolName,
                }
              )
              const normalizedContent = normalizedResult.content
              // metadata persisted to tool_results.metadata JSONB carries
              // origin + structuredContent so we can rehydrate them when the
              // session is later replayed. The CanonicalToolResult also gets
              // origin/structuredContent as first-class fields below.
              const metadata: Record<string, unknown> = {
                ...(normalizedResult.metadata || {}),
                toolCallId: tc.callId,
                toolName: tc.toolName,
                ...(tc.providerCallId
                  ? { providerCallId: tc.providerCallId }
                  : {}),
                ...(normalizedResult.isError !== undefined
                  ? { isError: normalizedResult.isError }
                  : {}),
                origin: normalizedResult.origin,
                ...(normalizedResult.structuredContent
                  ? { structuredContent: normalizedResult.structuredContent }
                  : {}),
              }
              // Phase 2 (R1): expose the tool's structured result (MCP _meta /
              // device _meta / structuredContent) under a single `toolMeta`
              // namespace the presentation renderer reads via ResultRef meta.*.
              // Additive — top-level fields above are unchanged.
              const toolMeta = buildToolMeta({
                meta: normalizedResult.metadata,
                structuredContent: normalizedResult.structuredContent,
              })
              if (toolMeta) metadata.toolMeta = toolMeta

              mcpResults.push({
                toolCallId: tc.callId,
                providerCallId: tc.providerCallId,
                toolName: tc.toolName,
                content: normalizedContent,
                isError: normalizedResult.isError,
                ...(normalizedResult.structuredContent
                  ? { structuredContent: normalizedResult.structuredContent }
                  : {}),
                origin: normalizedResult.origin,
                metadata,
              })
              allSupplementalBlocks.push(
                ...collectFileRefBlocks(normalizedContent)
              )

              if (executionEnabled && callRow && attempt) {
                await finalizeToolExecutionAttempt({
                  attemptId: attempt.id,
                  status: normalizedResult.isError ? "error" : "success",
                  isError: normalizedResult.isError,
                  errorMessage: normalizedResult.isError
                    ? extractText(normalizedContent)
                    : undefined,
                  durationMs: Date.now() - attemptStart,
                  responsePayload:
                    normalizedResult.rawResult ?? normalizedResult,
                })
                await createToolResult({
                  toolCallId: callRow.id,
                  attemptId: attempt.id,
                  isError: normalizedResult.isError,
                  errorMessage: normalizedResult.isError
                    ? extractText(normalizedContent)
                    : undefined,
                  metadata,
                  parts: blocksToToolResultParts(normalizedContent),
                })
                await updateToolCallStatus(
                  callRow.id,
                  normalizedResult.isError ? "failed" : "completed"
                )
              }
            } catch (err: unknown) {
              const classifiedError = classifyMcpExecutionError(err)
              const formattedMessage = formatMcpExecutionErrorMessage(
                classifiedError.message,
                classifiedError.requiresReplan
              )
              const failureOrigin = readToolResultOrigin(err)
              await appendMcpFailureResult({
                tc,
                callRow,
                attempt,
                attemptStart,
                message: formattedMessage,
                metadata: {
                  ...(classifiedError.code
                    ? { errorCode: classifiedError.code }
                    : {}),
                  ...(classifiedError.requiresReplan
                    ? { requiresReplan: true }
                    : {}),
                },
                responsePayload: {
                  error: classifiedError.message,
                  ...(classifiedError.code
                    ? { code: classifiedError.code }
                    : {}),
                  ...(classifiedError.requiresReplan
                    ? { requiresReplan: true }
                    : {}),
                },
                origin: failureOrigin,
              })

              if (classifiedError.requiresReplan) {
                mcpReplanRequired = true
                for (
                  let skippedIndex = mcpIndex + 1;
                  skippedIndex < mcpCalls.length;
                  skippedIndex++
                ) {
                  const skippedTc = mcpCalls[skippedIndex]
                  const skippedCallRow = toolCallRows.get(skippedTc.callId)
                  const skippedAttemptStart = Date.now()
                  const skippedMessage = formatMcpExecutionErrorMessage(
                    classifiedError.message,
                    true,
                    true
                  )
                  await appendMcpFailureResult({
                    tc: skippedTc,
                    callRow: skippedCallRow,
                    attemptStart: skippedAttemptStart,
                    message: skippedMessage,
                    metadata: {
                      errorCode: "tool_replan_required",
                      requiresReplan: true,
                      skippedDueToReplan: true,
                    },
                    // Skipped MCP calls didn't actually run, so we can't
                    // inherit a real origin from a thrown error. Derive the
                    // origin from the routed ToolRef so the audit trail still
                    // attributes correctly and the roundToolResults fallback
                    // doesn't mis-tag as {kind:"builtin"}.
                    origin: originFromRef(
                      toolWireRegistry.refByWireName.get(skippedTc.toolName),
                      skippedTc.toolName
                    ),
                    responsePayload: {
                      error: skippedMessage,
                      code: "tool_replan_required",
                      requiresReplan: true,
                      skippedDueToReplan: true,
                    },
                  })
                }
                break
              }
            }
          }
        }

        const toolResults = [...callableResults, ...mcpResults]

        // Build ToolRound for DB storage
        const roundToolCalls: CanonicalToolCall[] = allContinuableCalls.map(
          (tc: any) => {
            const origin = originFromRef(
              toolWireRegistry.refByWireName.get(tc.toolName),
              tc.toolName
            )
            return {
              callId: tc.callId,
              providerCallId: tc.providerCallId,
              toolName: tc.toolName,
              input: tc.input,
              metadata: { origin },
            }
          }
        )
        const callableResultIds = new Set(
          callableResults.map((r) => r.toolCallId)
        )
        const roundToolResults: CanonicalToolResult[] = toolResults.map(
          (tr) => {
            const isCallableEntry = callableResultIds.has(tr.toolCallId)
            const fallbackOrigin: ToolResultOrigin = isCallableEntry
              ? { kind: "system", registryKey: tr.toolName }
              : originFromRef(
                  toolWireRegistry.refByWireName.get(tr.toolName),
                  tr.toolName
                )
            const origin = readToolResultOrigin(tr) ?? fallbackOrigin
            const structuredContent = readToolResultStructuredContent(tr)
            const base: CanonicalToolResult = {
              toolCallId: tr.toolCallId,
              providerCallId: tr.providerCallId,
              toolName: tr.toolName,
              content: tr.content,
              isError: tr.isError,
              metadata: tr.metadata,
              origin,
            }
            if (structuredContent !== undefined) {
              base.structuredContent = structuredContent
            }
            return base
          }
        )
        const roundContentBlocks: CanonicalContentBlock[] = []
        if (finalTextContent)
          roundContentBlocks.push(textBlock(finalTextContent))
        if (roundMediaBlocks.length > 0)
          roundContentBlocks.push(...roundMediaBlocks)
        toolRounds.push({
          content:
            roundContentBlocks.length > 0 ? roundContentBlocks : undefined,
          toolCalls: roundToolCalls,
          toolResults: roundToolResults,
        })

        appendPrivateTailItems([
          {
            kind: "tool_call_batch",
            conversationId: options?.conversationId,
            sessionId: options?.sessionId,
            turnId,
            scope: "private",
            surface: "internal",
            role: "assistant",
            bundleId: roundBundleId,
            author: {
              participantType: "actor",
              actorId: actor.id,
              sessionId: options?.sessionId,
              name: actorDefinition.displayName,
              isSelf: true,
            },
            content:
              roundContentBlocks.length > 0 ? roundContentBlocks : undefined,
            toolCalls: roundToolCalls,
          },
          {
            kind: "tool_result_batch",
            conversationId: options?.conversationId,
            sessionId: options?.sessionId,
            turnId,
            scope: "private",
            surface: "internal",
            bundleId: roundBundleId,
            toolResults: roundToolResults,
          },
        ])

        if (callableInternalErrorToolNames.length > 0) {
          appendPrivateTailItems([
            buildCallableInternalErrorNotice(callableInternalErrorToolNames),
          ])
        }

        await abortIfRequested()

        if (mcpReplanRequired && !options?.mcpRefresh) {
          throw new Error(
            "MCP tool definitions changed during execution, but no refresh handler is available"
          )
        }

        // If 'sleep' callable tool was called, the session is now sleeping — stop the loop
        const sleepCalled = callableCalls.some(
          (tc: any) => tc.toolName === "sleep"
        )
        if (!mcpReplanRequired && sleepCalled) {
          const threadSemantics = getThreadSemantics()
          const enforceVisibleReplyBeforeSleep =
            !!options?.sessionId &&
            !!options?.conversationId &&
            threadSemantics.requiresVisibleReplyBeforeSleep
          const allowSleepWithoutVisibleReply =
            !enforceVisibleReplyBeforeSleep ||
            sendToCalledThisTurn ||
            !threadSemantics.hasAddressablePeer ||
            (threadSemantics.allowsSleepWithoutReplyConfirmation &&
              sleepWithoutSendToReminderCount > 0)

          if (!allowSleepWithoutVisibleReply) {
            sleepWithoutSendToReminderCount += 1
            appendPrivateTailItems([
              buildSleepWithoutSendToReminder({
                semantics: threadSemantics,
                otherParticipants: currentToolConversationParticipants || [],
                allowConfirmSleepWithoutReply:
                  threadSemantics.allowsSleepWithoutReplyConfirmation,
              }),
            ])

            if (options?.checkNewMessages) {
              try {
                const newMsgs = await options.checkNewMessages()
                if (newMsgs && newMsgs.length > 0) {
                  appendSharedTailItems(newMsgs)
                  log.info(
                    `[actorThink] Injected ${newMsgs.length} new message(s) between rounds`
                  )
                }
              } catch (err: any) {
                log.error(
                  { err: err.message },
                  "[actorThink] checkNewMessages failed"
                )
              }
            }

            await refreshLocalCallableTools()
            continue
          }

          const actions: ActorAction[] = []
          const toolHistory: AssistantToolHistory | undefined =
            toolRounds.length > 0 ? { rounds: toolRounds } : undefined
          const responseText = usedDraftProvider
            ? finalDraftText
            : finalTextContent
          const contentBlocks = await buildMergedResponseContentBlocks(
            responseText,
            allSupplementalBlocks,
            getInlineReferenceOptions()
          )
          return {
            actions,
            reasoning: responseText,
            tokensUsed: totalTokens,
            toolsUsed: allToolsUsed.length > 0 ? allToolsUsed : undefined,
            serverToolCalls:
              allServerToolCalls.length > 0 ? allServerToolCalls : undefined,
            citationSources:
              Object.keys(allCitationSources).length > 0
                ? allCitationSources
                : undefined,
            toolHistory,
            contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
          }
        }

        // Otherwise continue to next round
        // Dynamic MCP tool refresh between rounds
        if (
          !isPlanCollaborationMode(currentCollaborationMode) &&
          options?.mcpRefresh
        ) {
          if (mcpReplanRequired && onStatus) {
            await onStatus("MCP tools changed. Refreshing tool definitions...")
          }
          let needsRefresh = mcpReplanRequired
          if (workspaceId) {
            const latestVersion = await getMcpVersion(workspaceId)
            if (latestVersion !== currentMcpVersion) {
              needsRefresh = true
            }
          }
          if (needsRefresh) {
            try {
              const refreshed = await options.mcpRefresh()
              mcpToolDefs = refreshed.tools
              currentMcpVersion = refreshed.mcpVersion
              // The wire registry + allTools are rebuilt by the
              // refreshLocalCallableTools() call below (it re-reads mcpToolDefs).
              log.info(
                `[actorThink] MCP tools refreshed: ${mcpToolDefs.length} tools, version=${currentMcpVersion}`
              )
            } catch (err: any) {
              log.error({ err: err.message }, "[actorThink] MCP refresh failed")
              if (mcpReplanRequired) {
                throw new Error(
                  `MCP tool definitions changed during execution, but refresh failed: ${err.message}`
                )
              }
            }
          }
        } else if (isPlanCollaborationMode(currentCollaborationMode)) {
          mcpToolDefs = []
        }

        await refreshLocalCallableTools()

        // Inter-round message injection: check for new messages between rounds
        if (options?.checkNewMessages) {
          try {
            const newMsgs = await options.checkNewMessages()
            if (newMsgs && newMsgs.length > 0) {
              appendSharedTailItems(newMsgs)
              log.info(
                `[actorThink] Injected ${newMsgs.length} new message(s) between rounds`
              )
            }
          } catch (err: any) {
            log.error(
              { err: err.message },
              "[actorThink] checkNewMessages failed"
            )
          }
        }

        continue
      }

      // No executable tool calls — keep looping until the model explicitly
      // sleeps or the round limit is reached.
      const actions: ActorAction[] = []

      if (finalTextContent.trim().length > 0 || roundMediaBlocks.length > 0) {
        const draftBlocks = await buildMergedResponseContentBlocks(
          finalTextContent,
          roundMediaBlocks,
          getInlineReferenceOptions()
        )
        if (draftBlocks.length > 0) {
          appendSharedTailItems(
            buildAdHocContextItems([
              {
                role: "assistant",
                content: draftBlocks,
              },
            ])
          )
        }
      }

      if (options?.checkNewMessages) {
        try {
          const newMsgs = await options.checkNewMessages()
          if (newMsgs && newMsgs.length > 0) {
            appendSharedTailItems(newMsgs)
            log.info(
              `[actorThink] Injected ${newMsgs.length} new message(s) between rounds`
            )
          }
        } catch (err: any) {
          log.error(
            { err: err.message },
            "[actorThink] checkNewMessages failed"
          )
        }
      }

      await refreshLocalCallableTools()
      continue
    }

    // Exceeded MAX_TOOL_ROUNDS — fallback respond
    log.warn(
      `[actorThink] actor=${actor.id} exceeded max tool rounds (${MAX_TOOL_ROUNDS})`
    )

    if (usedDraftProvider || allSupplementalBlocks.length > 0) {
      const contentBlocks = await buildMergedResponseContentBlocks(
        finalDraftText,
        allSupplementalBlocks,
        getInlineReferenceOptions()
      )
      return {
        actions: [],
        reasoning: finalDraftText || "Exceeded maximum tool rounds",
        tokensUsed: totalTokens,
        toolsUsed: allToolsUsed.length > 0 ? allToolsUsed : undefined,
        serverToolCalls:
          allServerToolCalls.length > 0 ? allServerToolCalls : undefined,
        citationSources:
          Object.keys(allCitationSources).length > 0
            ? allCitationSources
            : undefined,
        toolHistory: toolRounds.length > 0 ? { rounds: toolRounds } : undefined,
        contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
      }
    }

    return {
      actions: [
        {
          type: "respond",
          content:
            "I ran into complexity processing this request. Please try again with a simpler question.",
          contentBlocks: textBlocks(
            "I ran into complexity processing this request. Please try again with a simpler question."
          ),
        },
      ],
      reasoning: "Exceeded maximum tool rounds",
      tokensUsed: totalTokens,
      toolsUsed: allToolsUsed.length > 0 ? allToolsUsed : undefined,
      serverToolCalls:
        allServerToolCalls.length > 0 ? allServerToolCalls : undefined,
      citationSources:
        Object.keys(allCitationSources).length > 0
          ? allCitationSources
          : undefined,
      toolHistory: toolRounds.length > 0 ? { rounds: toolRounds } : undefined,
      contentBlocks:
        allSupplementalBlocks.length > 0 ? allSupplementalBlocks : undefined,
    }
  } // end _actorThinkInner
}

export async function aiComplete(
  system: string,
  messages: { role: string; content: string }[],
  resolved: ResolvedModelConfig,
  logContext?: { workspaceId?: string; actorId?: string }
): Promise<{ content: string; tokensUsed: { input: number; output: number } }> {
  const contextItems = buildAdHocContextItems(
    messages.map((message) => ({
      role: message.role as "user" | "assistant",
      content: textBlocks(message.content),
    }))
  )
  const contextWindow = buildAdHocProviderContextWindow(contextItems)

  const startTime = Date.now()
  let status = "success"
  let errorMessage: string | undefined
  let response: ReturnType<typeof fromGenerateText>

  const requestLog = {
    provider: resolved.vendor,
    model: resolved.modelName,
    system,
    contextWindow,
  }

  try {
    const conversationMessages =
      await compileContextWindowToConversationMessages(contextWindow)
    const modelMessages = await toModelMessages(
      reconcileToolPairing(conversationMessages),
      { multimodal: resolved.multimodal }
    )
    const result = await generateText({
      model: languageModelFor(resolved),
      system,
      messages: modelMessages,
      maxOutputTokens: resolved.maxOutputTokens,
      stopWhen: stepCountIs(1),
      ...(resolved.providerOptions
        ? { providerOptions: resolved.providerOptions as any }
        : {}),
    })
    response = fromGenerateText(result)
  } catch (err: any) {
    status = "error"
    errorMessage = err.message
    await logAIRequest({
      workspaceId: logContext?.workspaceId,
      actorId: logContext?.actorId,
      groupId: resolved.groupId,
      bindingId: resolved.bindingId,
      bindingVersionId: resolved.bindingVersionId,
      requestType: "ai_complete",
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startTime,
      status,
      errorMessage,
      requestBody: requestLog,
    })
    throw err
  }

  const latencyMs = Date.now() - startTime
  const ctxMsg = response.context[0]
  const responseText =
    ctxMsg?.role === "assistant" ? extractText(ctxMsg.content) : ""

  await logAIRequest({
    workspaceId: logContext?.workspaceId,
    actorId: logContext?.actorId,
    groupId: resolved.groupId,
    bindingId: resolved.bindingId,
    bindingVersionId: resolved.bindingVersionId,
    requestType: "ai_complete",
    inputTokens: response.tokensUsed.input,
    outputTokens: response.tokensUsed.output,
    latencyMs,
    status,
    requestBody: requestLog,
    responseBody: {
      stopReason: response.stopReason,
      textContent: responseText,
      tokens: response.tokensUsed,
    },
  })

  return {
    content: responseText,
    tokensUsed: response.tokensUsed,
  }
}
