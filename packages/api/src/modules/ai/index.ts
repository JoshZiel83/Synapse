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
  ConversationMemberEntry,
  ToolResolveContext,
  CanonicalContentBlock,
  ProviderContextWindow,
  AvailableSkillSummary,
  ModelAttemptPolicy,
  EngineBranchState,
} from "@synapse/shared";
import type {
  CanonicalContextItem,
  NormalizedMcpToolResult,
} from "@synapse/shared/types";
import {
  extractText,
  formatMentionText,
  getDefaultModelEngineKind,
  normalizeCanonicalContentBlocks,
  textBlock,
  textBlocks,
} from "@synapse/shared";
import { randomUUID } from "crypto";
import { config } from "../../config/index.js";
import {
  createAIProvider,
  type AIProvider,
  type AIProviderConfig,
} from "./providers/index.js";
import { toolCallsToActions } from "./tools.js";
import { buildActorPrompt } from "./prompt-builder.js";
import { logAIRequest } from "../model-groups/service.js";
import {
  resolveBuiltinTools,
  executeCallableTools,
  isCallableTool,
  isActionTool,
} from "./tool-plugins.js";
import { runWithToolContext } from "./session-tools.js";
import { maybeAutoBridgeRelayApproval } from "./relay-approval-bridge.js";
import { getMcpVersion } from "../mcp-plugins/instance-manager.js";
import { ingestResponseMedia } from "./content-ingest.js";
import {
  buildDefaultUserMention,
  conversationMemberEntryToEntityRef,
  parseInlineReferenceSegments,
  resolveInlineReferenceSegments,
  type InlineReferenceResolveOptions,
} from "./inline-ref-resolver.js";
import { buildAdHocContextItems } from "./context-builder.js";
import { buildAdHocProviderContextWindow } from "../context/service.js";
import {
  createEngineBindingKey,
  getEngineBranchState,
  initializeEngineBranchState,
  saveEngineBranchState,
  shouldRebuildBranchState,
} from "./engine-branches.js";
import { DEFAULT_MODEL_ATTEMPT_POLICY } from "../model-groups/defaults.js";
import { getConversationMembers as getLiveConversationMembers } from "../conversation/chat-service.js";
import {
  createToolCall,
  createToolExecutionAttempt,
  createToolResult,
  finalizeToolExecutionAttempt,
  logProviderStep,
  updateToolCallStatus,
} from "../execution/service.js";

export { buildActorPrompt } from "./prompt-builder.js";

const MAX_TOOL_ROUNDS = 100;
const DEFAULT_ATTEMPT_POLICY: ModelAttemptPolicy = DEFAULT_MODEL_ATTEMPT_POLICY;

// Cache providers by config fingerprint to avoid recreating
const providerCache = new Map<string, AIProvider>();

function getProvider(resolved?: ResolvedModelConfig | null): AIProvider {
  const providerConfig: AIProviderConfig = resolved
    ? {
        apiKey: resolved.apiKey,
        baseUrl: resolved.baseUrl,
        model: resolved.modelName,
        maxTokens: resolved.maxTokens,
        engineKind: resolved.engineKind,
      }
    : {
        apiKey: config.ai.apiKey,
        baseUrl: config.ai.baseUrl,
        model: config.ai.model,
        maxTokens: config.ai.maxTokens,
        engineKind: config.ai.engineKind,
      };

  const providerName = resolved?.providerType || config.ai.provider;
  const cacheKey = `${providerConfig.engineKind}:${providerConfig.apiKey}:${providerConfig.baseUrl}:${providerConfig.model}`;

  let provider = providerCache.get(cacheKey);
  if (!provider) {
    provider = createAIProvider(providerName, providerConfig);
    providerCache.set(cacheKey, provider);
  }
  return provider;
}

function getFallbackResolvedConfig(): ResolvedModelConfig {
  return {
    groupId: "env-fallback",
    profileId: "env-fallback",
    profileRevisionId: "env-fallback",
    providerType: config.ai.provider,
    engineKind: config.ai.engineKind,
    apiKey: config.ai.apiKey,
    baseUrl: config.ai.baseUrl,
    modelName: config.ai.model,
    maxTokens: config.ai.maxTokens,
    requestTimeoutMs: DEFAULT_ATTEMPT_POLICY.timeoutMsPerAttempt,
    maxRetries: DEFAULT_ATTEMPT_POLICY.maxAttemptsPerBinding - 1,
  };
}

function classifyModelError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  if (message.includes("timed out") || message.includes("abort"))
    return "timeout";
  if (
    message.includes("401") ||
    message.includes("403") ||
    message.includes("auth")
  )
    return "auth_error";
  if (
    message.includes("400") ||
    message.includes("bad request") ||
    message.includes("validation")
  )
    return "bad_request";
  if (message.includes("429") || message.includes("rate limit"))
    return "rate_limit";
  if (
    message.includes("policy") ||
    message.includes("safety") ||
    message.includes("blocked")
  )
    return "policy_block";
  if (
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504")
  )
    return "5xx";
  if (
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("econn") ||
    message.includes("enotfound")
  ) {
    return "network";
  }
  return "unknown";
}

async function delay(ms: number) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`Model attempt timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function effectiveAttemptPolicy(
  routePolicy: ModelAttemptPolicy,
  resolved: ResolvedModelConfig,
): ModelAttemptPolicy {
  return {
    ...routePolicy,
    timeoutMsPerAttempt:
      resolved.requestTimeoutMs ?? routePolicy.timeoutMsPerAttempt,
    maxAttemptsPerBinding: Math.max(
      1,
      resolved.maxRetries !== undefined
        ? resolved.maxRetries + 1
        : routePolicy.maxAttemptsPerBinding,
    ),
  };
}

function collectFileRefBlocks(
  blocks: CanonicalContentBlock[],
): Extract<CanonicalContentBlock, { type: "file_ref" }>[] {
  return blocks.filter(
    (block): block is Extract<CanonicalContentBlock, { type: "file_ref" }> =>
      block.type === "file_ref",
  );
}

function mergeContentBlocks(
  baseBlocks: CanonicalContentBlock[],
  extraBlocks: CanonicalContentBlock[],
): CanonicalContentBlock[] {
  const merged: CanonicalContentBlock[] = [...baseBlocks];
  const seenFileIds = new Set(
    merged
      .filter(
        (
          block,
        ): block is Extract<CanonicalContentBlock, { type: "file_ref" }> =>
          block.type === "file_ref",
      )
      .map((block) => block.fileId),
  );

  for (const block of extraBlocks) {
    if (block.type === "text") {
      if (block.text) merged.push(block);
      continue;
    }
    if (block.type === "mention") {
      merged.push(block);
      continue;
    }
    if (seenFileIds.has(block.fileId)) continue;
    seenFileIds.add(block.fileId);
    merged.push(block);
  }

  return merged;
}

async function buildResponseContentBlocks(
  textContent: string,
  options: InlineReferenceResolveOptions | undefined,
): Promise<CanonicalContentBlock[]> {
  const segments = parseInlineReferenceSegments(textContent);
  if (!segments.some((segment) => segment.type !== "text")) {
    return textContent ? [textBlock(textContent)] : [];
  }

  const resolved = await resolveInlineReferenceSegments(segments, options);
  if (resolved.warnings.length > 0) {
    console.warn(
      `[actorThink] Inline reference warnings: ${resolved.warnings.join("; ")}`,
    );
  }
  return resolved.blocks;
}

async function buildMergedResponseContentBlocks(
  textContent: string,
  supplementalBlocks: CanonicalContentBlock[],
  options?: InlineReferenceResolveOptions,
): Promise<CanonicalContentBlock[]> {
  const baseBlocks = await buildResponseContentBlocks(textContent, options);
  return mergeContentBlocks(baseBlocks, supplementalBlocks);
}

function buildInlineReferenceOptions(params: {
  conversationMembers?: ConversationMemberEntry[];
  userId?: string;
  userName?: string;
}): InlineReferenceResolveOptions | undefined {
  const mentionCandidates = (params.conversationMembers || []).map(
    conversationMemberEntryToEntityRef,
  );
  const defaultUser = buildDefaultUserMention({
    userId: params.userId,
    userName: params.userName,
  });

  if (mentionCandidates.length === 0 && !defaultUser) {
    return undefined;
  }

  return {
    mentionCandidates,
    defaultUser,
  };
}

interface Subordinate {
  name: string;
  title: string;
  summary: string;
}

async function loadToolResolveConversationMembers(params: {
  conversationId?: string;
  actorId: string;
  fallback?: ConversationMemberEntry[];
}): Promise<ConversationMemberEntry[] | undefined> {
  if (!params.conversationId) {
    return params.fallback;
  }

  const members = await getLiveConversationMembers(params.conversationId);
  const entries: ConversationMemberEntry[] = [];

  for (const member of members) {
    if (member.state !== "active") continue;
    if (member.actor_id) {
      if (member.actor_id === params.actorId) continue;
      entries.push({
        type: "actor",
        id: member.actor_id,
        name: member.actor_name || "Unknown actor",
        title: member.actor_title || member.actor_role || "Actor",
      });
      continue;
    }
    if (member.user_id) {
      const transportKind =
        member.transport_kind === "feishu" || member.transport_kind === "weixin"
          ? member.transport_kind
          : undefined;
      entries.push({
        type: "user",
        id: member.user_id,
        participantId: member.id,
        name: member.user_name || "User",
        title: transportKind
          ? `Workspace user · reachable via ${transportKind === "feishu" ? "Feishu" : "WeChat"}`
          : "Workspace user",
      });
      continue;
    }
    if (member.member_type === "external") {
      const linkedUserName =
        (member.linked_user_name as string | null) || undefined;
      entries.push({
        type: "external",
        id:
          (member.linked_user_id as string | null) ||
          (member.transport_external_id as string | null) ||
          (member.id as string),
        participantId: member.id as string,
        name:
          (member.transport_display_name as string | null) ||
          (member.display_name as string | null) ||
          linkedUserName ||
          "External participant",
        title: linkedUserName
          ? `Linked workspace user: ${linkedUserName}`
          : "External participant",
        linkedUserId: (member.linked_user_id as string | null) || undefined,
        linkedUserName,
        externalUserKey:
          (member.transport_external_id as string | null) || undefined,
      });
    }
  }

  return entries;
}

function blocksToToolResultParts(blocks: CanonicalContentBlock[]) {
  return blocks.map((block) => {
    if (block.type === "text") {
      return { type: "text" as const, text: block.text };
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
      };
    }
    return {
      type: "file_ref" as const,
      fileId: block.fileId,
      mimeType: block.mimeType,
      name: block.originalName,
      metadata: {
        storedName: block.storedName,
        url: block.url,
        sizeBytes: block.sizeBytes,
        category: block.category,
      },
    };
  });
}

function buildSleepWithoutSendToReminder(params: {
  participantCount: number;
  otherMembers: ConversationMemberEntry[];
  allowConfirmSleepWithoutReply: boolean;
}): CanonicalContextItem {
  const otherMemberName = params.otherMembers[0]?.name || "the other member";

  if (params.participantCount === 2) {
    return {
      kind: "system_notice",
      noticeType: "task_instruction",
      scope: "private",
      surface: "internal",
      parts: textBlocks(
        `You called \`sleep\` before using \`send_to\` in this wakeup. Your reasoning and tool calls are invisible to everyone else. ` +
          `This conversation currently has only you and ${otherMemberName}, so you must call \`send_to\` to ${otherMemberName} before sleeping. ` +
          `Send a visible result, handoff, clarification, or explicit "no action needed" message with the correct \`intent\` and \`summary\`, then call \`sleep\` again.`,
      ),
    };
  }

  return {
    kind: "system_notice",
    noticeType: "task_instruction",
    scope: "private",
    surface: "internal",
    parts: textBlocks(
      params.allowConfirmSleepWithoutReply
        ? `You called \`sleep\` before using \`send_to\` in this wakeup. Your reasoning and tool calls are invisible to other conversation members unless you use \`send_to\`. ` +
            `Before sleeping, either send a visible update, result, handoff, clarification, or explicit "no action needed" message to the relevant member(s), or if the wakeup is truly unrelated to you and the message already reached the correct assignee, call \`sleep\` again now to confirm that no visible reply from you is needed.`
        : `You called \`sleep\` again without using \`send_to\`. Your reasoning and tool calls are still invisible to other conversation members. ` +
            `If no visible reply from you is genuinely needed because the wakeup is entirely unrelated to you and the correct assignee already received it, you may remain asleep. Otherwise, use \`send_to\` now before sleeping.`,
    ),
  };
}

function inferToolKind(toolName: string, mcpToolNames: Set<string>) {
  if (mcpToolNames.has(toolName)) return "mcp_plugin" as const;
  if (isActionTool(toolName)) return "action" as const;
  if (isCallableTool(toolName)) return "callable" as const;
  return "builtin" as const;
}

function classifyMcpExecutionError(error: unknown) {
  const raw =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : null;
  const code = typeof raw?.code === "string" ? raw.code : undefined;
  const requiresReplan =
    raw?.requiresReplan === true ||
    code === "tool_definition_changed" ||
    code === "tool_removed";
  const message =
    typeof raw?.message === "string" && raw.message.trim().length > 0
      ? raw.message
      : error instanceof Error
        ? error.message
        : String(error || "MCP tool execution failed");

  return {
    code,
    message,
    requiresReplan,
  };
}

function formatMcpExecutionErrorMessage(
  message: string,
  requiresReplan: boolean,
  skipped = false,
) {
  if (!requiresReplan) {
    return `Error: ${message}`;
  }
  if (skipped) {
    return "Error: Skipped because another MCP tool changed during execution. Re-read the latest tool definitions before retrying.";
  }
  if (/re-read the latest tool definition/i.test(message)) {
    return `Error: ${message}`;
  }
  return `Error: ${message} Re-read the latest tool definitions before retrying.`;
}

function getToolErrorDetails(
  metadata?: Record<string, unknown>,
): {
  kind?: "model_actionable" | "internal";
  retryable?: boolean;
  code?: string;
} {
  const raw =
    typeof metadata?.toolError === "object" && metadata.toolError !== null
      ? (metadata.toolError as Record<string, unknown>)
      : null;

  return {
    kind:
      raw?.kind === "model_actionable" || raw?.kind === "internal"
        ? raw.kind
        : undefined,
    retryable:
      typeof raw?.retryable === "boolean" ? raw.retryable : undefined,
    code: typeof raw?.code === "string" ? raw.code : undefined,
  };
}

function buildCallableInternalErrorNotice(toolNames: string[]) {
  const uniqueToolNames = Array.from(new Set(toolNames));
  const renderedToolNames = uniqueToolNames
    .map((toolName) => `\`${toolName}\``)
    .join(", ");
  return {
    kind: "system_notice" as const,
    noticeType: "task_instruction" as const,
    scope: "private" as const,
    surface: "internal" as const,
    parts: textBlocks(
      `The callable tool(s) ${renderedToolNames} failed with internal system errors. ` +
        `These failures are not fixable by changing tool arguments alone. ` +
        `Do not retry the same failing call unless external state has changed. ` +
        `Choose an alternate path, send a visible status/failure update if needed, or sleep.`,
    ),
  };
}

export async function actorThink(
  actor: Actor,
  contextWindow: ProviderContextWindow,
  subordinates?: Subordinate[],
  modelPlan?: ResolvedModelPlan | null,
  workspaceId?: string,
  options?: {
    sessionId?: string;
    turnId?: string;
    conversationId?: string;
    conversationMembers?: ConversationMemberEntry[];
    userId?: string;
    availableSkills?: AvailableSkillSummary[];
    onStatus?: (status: string) => Promise<void>;
    mcpTools?: import("@synapse/shared").ToolDefinition[];
    mcpExecutor?: (
      toolName: string,
      input: Record<string, unknown>,
    ) => Promise<NormalizedMcpToolResult>;
    mcpVersion?: number;
    mcpRefresh?: () => Promise<{
      tools: import("@synapse/shared").ToolDefinition[];
      mcpVersion: number;
    }>;
    mcpSetTurnId?: (turnId: string, round?: number) => void;
    system: string;
    checkNewMessages?: () => Promise<CanonicalContextItem[] | null>;
  },
): Promise<ThinkingResult> {
  const actorDefinition = actor.definition ?? actor;
  const system = options?.system || "";
  let allTools: import("@synapse/shared").ToolDefinition[] = [];
  const effectiveModelPlan =
    modelPlan && modelPlan.candidates.length > 0
      ? modelPlan
      : {
          groupId: "env-fallback",
          groupName: "Environment Fallback",
          routingStrategy: "priority_failover" as const,
          attemptPolicy: DEFAULT_ATTEMPT_POLICY,
          candidates: [getFallbackResolvedConfig()],
        };

  const allContextWindow: ProviderContextWindow = {
    sharedArchivePoint: contextWindow.sharedArchivePoint,
    sharedTailItems: [...contextWindow.sharedTailItems],
    privateArchivePoint: contextWindow.privateArchivePoint,
    privateTailItems: [...contextWindow.privateTailItems],
    orderedTailItems: [...contextWindow.orderedTailItems],
  };

  const appendSharedTailItems = (items: CanonicalContextItem[]) => {
    if (items.length === 0) return;
    allContextWindow.sharedTailItems.push(...items);
    allContextWindow.orderedTailItems.push(...items);
  };

  const appendPrivateTailItems = (items: CanonicalContextItem[]) => {
    if (items.length === 0) return;
    allContextWindow.privateTailItems.push(...items);
    allContextWindow.orderedTailItems.push(...items);
  };

  const buildRequestLog = (
    round: number,
    resolved?: ResolvedModelConfig | null,
    attempt?: number,
  ) => ({
    provider: resolved?.providerType || config.ai.provider,
    engineKind:
      resolved?.engineKind ||
      config.ai.engineKind ||
      getDefaultModelEngineKind(config.ai.provider),
    model: resolved?.modelName || config.ai.model,
    round,
    attempt: attempt || 1,
    groupId: effectiveModelPlan.groupId,
    groupName: effectiveModelPlan.groupName,
    candidateProfileIds: effectiveModelPlan.candidates.map(
      (candidate: ResolvedModelConfig) => candidate.profileId,
    ),
    system,
    contextWindow: allContextWindow,
    tools: allTools,
    builtinTools: resolved?.builtinTools || null,
    multimodal: resolved?.multimodal || null,
  });

  // MCP tools (already resolved and authorized by tool-resolver.ts)
  let mcpToolDefs = options?.mcpTools || [];
  let mcpToolNames = new Set(mcpToolDefs.map((t) => t.name));
  let currentToolConversationMembers = options?.conversationMembers;
  const buildResolveCtx = (): ToolResolveContext => ({
    sessionId: options?.sessionId || "",
    actorId: actor.id,
    workspaceId: workspaceId || "",
    conversationId: options?.conversationId,
    conversationMembers: currentToolConversationMembers,
    userId: options?.userId,
    availableSkills: options?.availableSkills,
  });
  const getInlineReferenceOptions = () =>
    buildInlineReferenceOptions({
      conversationMembers: currentToolConversationMembers,
      userId: options?.userId,
    });
  const refreshBuiltinTools = async (): Promise<
    import("@synapse/shared").ToolDefinition[]
  > => {
    currentToolConversationMembers = await loadToolResolveConversationMembers({
      conversationId: options?.conversationId,
      actorId: actor.id,
      fallback: currentToolConversationMembers,
    });
    const resolvedBuiltin = await resolveBuiltinTools(buildResolveCtx());
    const filteredBuiltin = resolvedBuiltin.filter(
      (tool) => !mcpToolNames.has(tool.name),
    );
    allTools = [...filteredBuiltin, ...mcpToolDefs];
    return resolvedBuiltin;
  };
  let builtinTools = await refreshBuiltinTools();
  let currentMcpVersion = options?.mcpVersion ?? 0;

  const turnId = options?.turnId || randomUUID();
  const executionEnabled = !!options?.turnId && !!options?.conversationId;
  let totalTokens = { input: 0, output: 0 };
  let providerStepIndex = 0;

  const allToolsUsed: string[] = []; // track callable tools invoked
  const allServerToolCalls: ServerToolCall[] = []; // track cloud-side tool calls
  let allCitationSources: Record<string, { url: string; title: string }> = {}; // cite index → source
  const onStatus = options?.onStatus;
  const branchStateCache = new Map<string, EngineBranchState>();

  // Accumulate ToolRound[] for DB storage only (not passed to provider)
  const toolRounds: ToolRound[] = [];
  // Accumulate media attachments from MCP/model responses
  const allSupplementalBlocks: CanonicalContentBlock[] = [];
  let finalDraftText = "";
  let finalDraftProvider: AIProvider | null = null;
  let sendToCalledThisTurn = false;
  let sleepWithoutSendToReminderCount = 0;
  const participantCount = options?.conversationId
    ? (options?.conversationMembers?.length || 0) + 1
    : 0;
  const enforceVisibleReplyBeforeSleep =
    !!options?.sessionId && !!options?.conversationId && participantCount > 1;

  // Common fields for logAIRequest
  const logCommon = {
    workspaceId,
    actorId: actor.id,
    sessionId: options?.sessionId,
    turnId,
    groupId: effectiveModelPlan.groupId,
    requestType: "actor_think" as const,
  };

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
      },
      () => _actorThinkInner(),
    );
  }
  return _actorThinkInner();

  async function _actorThinkInner(): Promise<ThinkingResult> {
    const recordProviderRound = async (params: {
      round: number;
      attempt: number;
      resolved: ResolvedModelConfig;
      latencyMs: number;
      status: "success" | "error" | "timeout";
      requestBody: unknown;
      responseBody?: unknown;
      stopReason?: string;
      inputTokens: number;
      outputTokens: number;
      errorMessage?: string;
    }) => {
      const stepIndex = ++providerStepIndex;
      if (executionEnabled) {
        return logProviderStep({
          turnId: options!.turnId!,
          stepIndex,
          providerType: params.resolved.providerType,
          requestType: "actor_think",
          modelGroupId: effectiveModelPlan.groupId,
          modelProfileId: params.resolved.profileId,
          modelProfileRevisionId: params.resolved.profileRevisionId,
          modelName: params.resolved.modelName || config.ai.model,
          capabilitiesSnapshot: {
            engineKind: params.resolved.engineKind,
            builtinTools: params.resolved.builtinTools || [],
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
        });
      }

      await logAIRequest({
        ...logCommon,
        round: stepIndex,
        profileId: params.resolved.profileId,
        profileRevisionId: params.resolved.profileRevisionId,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        latencyMs: params.latencyMs,
        status: params.status,
        errorMessage: params.errorMessage,
        requestBody: params.requestBody,
        responseBody: params.responseBody,
      });
      return null;
    };

    const executeProviderRound = async (round: number) => {
      const routePolicy =
        effectiveModelPlan.attemptPolicy || DEFAULT_ATTEMPT_POLICY;
      const perProfileAttempts = new Map<string, number>();
      let totalAttempts = 0;
      let lastError: Error | null = null;

      candidateLoop: for (const candidate of effectiveModelPlan.candidates) {
        const candidatePolicy = effectiveAttemptPolicy(routePolicy, candidate);
        while (true) {
          const priorAttempts =
            perProfileAttempts.get(candidate.profileId) || 0;
          if (priorAttempts >= candidatePolicy.maxAttemptsPerBinding) break;
          if (totalAttempts >= routePolicy.maxAttemptsTotal)
            break candidateLoop;

          const attempt = priorAttempts + 1;
          perProfileAttempts.set(candidate.profileId, attempt);
          totalAttempts += 1;

          const provider = getProvider(candidate);
          const requestBody = buildRequestLog(round, candidate, attempt);
          const attemptStart = Date.now();

          try {
            const branchKey = options?.sessionId
              ? `${options.sessionId}:${createEngineBindingKey(candidate)}`
              : "";
            let branchState = options?.sessionId
              ? branchStateCache.get(branchKey) ||
                (await getEngineBranchState(options.sessionId, candidate)) ||
                initializeEngineBranchState({
                  sessionId: options.sessionId,
                  conversationId: options.conversationId,
                  resolved: candidate,
                })
              : undefined;

            if (branchState && branchKey) {
              branchStateCache.set(branchKey, branchState);
            }

            if (
              branchState &&
              branchKey &&
              shouldRebuildBranchState(allContextWindow, branchState, system)
            ) {
              const rebuiltBranchState = await provider.rebuildBranchState({
                system,
                contextWindow: allContextWindow,
                branchState,
                tools: allTools,
                builtinTools: candidate.builtinTools,
                multimodal: candidate.multimodal,
              });

              const persistedRebuiltBranch = await saveEngineBranchState(
                rebuiltBranchState,
                {
                  checkpointKind: "compaction",
                },
              );
              branchState = persistedRebuiltBranch || rebuiltBranchState;
              branchStateCache.set(branchKey, branchState);
            }

            const response = await withTimeout(
              provider.chat({
                system,
                contextWindow: allContextWindow,
                branchState,
                tools: allTools,
                builtinTools: candidate.builtinTools,
                multimodal: candidate.multimodal,
              }),
              candidatePolicy.timeoutMsPerAttempt,
            );

            if (response.branchState) {
              const persistedBranchState = await saveEngineBranchState(
                response.branchState,
              );
              if (persistedBranchState && branchKey) {
                branchStateCache.set(branchKey, persistedBranchState);
              }
            }

            const assistantMsg = response.context[0];
            const textContent =
              assistantMsg?.role === "assistant"
                ? extractText(assistantMsg.content)
                : "";
            const toolCalls =
              assistantMsg?.role === "assistant" && assistantMsg.toolCalls
                ? assistantMsg.toolCalls
                : [];

            const providerStep = await recordProviderRound({
              round,
              attempt,
              resolved: candidate,
              latencyMs: Date.now() - attemptStart,
              status: "success",
              requestBody,
              responseBody: {
                stopReason: response.stopReason,
                toolCalls: toolCalls.map((tc: any) => ({
                  callId: tc.callId,
                  providerCallId: tc.providerCallId,
                  toolName: tc.toolName,
                  input: tc.input,
                })),
                textContent,
                rawAssistantMessage: response.rawAssistantMessage,
              },
              stopReason: response.stopReason,
              inputTokens: response.tokensUsed.input,
              outputTokens: response.tokensUsed.output,
            }).catch((err) => {
              console.error(
                "[actorThink] Failed to log provider step:",
                err.message,
              );
              return null;
            });

            return { response, provider, resolved: candidate, providerStep };
          } catch (err: any) {
            const error = err instanceof Error ? err : new Error(String(err));
            lastError = error;
            const errorType = classifyModelError(error);
            const status = errorType === "timeout" ? "timeout" : "error";

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
            }).catch(() => {});

            if (routePolicy.stopOn.includes(errorType)) {
              throw error;
            }

            const canRetrySameBinding =
              routePolicy.continueOn.includes(errorType) &&
              attempt < candidatePolicy.maxAttemptsPerBinding &&
              totalAttempts < routePolicy.maxAttemptsTotal;

            if (canRetrySameBinding) {
              const backoff =
                candidatePolicy.retryBackoffMs[
                  Math.min(
                    attempt - 1,
                    candidatePolicy.retryBackoffMs.length - 1,
                  )
                ] || 0;
              await delay(backoff);
              continue;
            }

            break;
          }
        }
      }

      if (lastError) throw lastError;
      throw new Error(
        "No eligible model candidates available for this request",
      );
    };

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const currentRound = round + 1;

      // Set turn+round context for MCP executor
      if (options?.mcpSetTurnId) options.mcpSetTurnId(turnId, currentRound);

      if (onStatus) {
        await onStatus("Calling AI model...");
      }

      const {
        response,
        provider,
        resolved: selectedResolved,
        providerStep,
      } = await executeProviderRound(currentRound);

      totalTokens.input += response.tokensUsed.input;
      totalTokens.output += response.tokensUsed.output;

      // Extract from canonical context
      const assistantMsg = response.context[0];
      const textContent =
        assistantMsg?.role === "assistant"
          ? extractText(assistantMsg.content)
          : "";
      const toolCalls =
        assistantMsg?.role === "assistant" && assistantMsg.toolCalls
          ? assistantMsg.toolCalls
          : [];

      console.log(
        `[actorThink] actor=${actor.id} turn=${turnId.slice(0, 8)} round=${currentRound} stopReason=${response.stopReason} toolCalls=[${toolCalls.map((tc: any) => tc.toolName).join(",")}] textLen=${textContent.length}`,
      );

      // Ingest response media → CanonicalContentBlock[] for ToolRound.content
      let roundMediaBlocks: CanonicalContentBlock[] = [];
      if (
        response.mediaBlocks &&
        response.mediaBlocks.length > 0 &&
        workspaceId
      ) {
        try {
          roundMediaBlocks = await ingestResponseMedia(
            response.mediaBlocks,
            selectedResolved.providerType || "anthropic",
            workspaceId,
          );
          allSupplementalBlocks.push(...collectFileRefBlocks(roundMediaBlocks));
        } catch (err: any) {
          console.error(
            "[actorThink] Failed to ingest response media:",
            err.message,
          );
        }
      }

      const serverCalls = response.serverToolCalls || [];
      if (serverCalls.length > 0) {
        allServerToolCalls.push(...serverCalls);
        if (onStatus) {
          const labels = serverCalls.map((sc) => {
            if (sc.type === "web_search")
              return `Searching "${sc.query || "..."}"`;
            if (sc.type === "web_fetch") return `Fetching ${sc.url || "..."}`;
            return sc.type;
          });
          await onStatus(labels.join(", "));
        }
      }

      const citations = response.citationSources;
      if (citations) {
        allCitationSources = { ...allCitationSources, ...citations };
      }

      let finalTextContent = textContent;
      if (finalTextContent.trim().length > 0 || roundMediaBlocks.length > 0) {
        finalDraftText = finalTextContent;
        finalDraftProvider = provider;
      }

      // Dispatch: three-bucket separation
      const actionCalls = toolCalls.filter((tc: any) =>
        isActionTool(tc.toolName),
      );
      const callableCalls = toolCalls.filter((tc: any) =>
        isCallableTool(tc.toolName),
      );
      const mcpCalls = toolCalls.filter((tc: any) =>
        mcpToolNames.has(tc.toolName),
      );
      const allContinuableCalls = [...callableCalls, ...mcpCalls];
      const sendToPlanned = callableCalls.some(
        (tc: any) => tc.toolName === "send_to",
      );

      if (allContinuableCalls.length > 0) {
        if (sendToPlanned && options?.checkNewMessages) {
          try {
            const newMsgs = await options.checkNewMessages();
            if (newMsgs && newMsgs.length > 0) {
              appendSharedTailItems(newMsgs);
              if (onStatus) {
                await onStatus("Conversation updated. Re-analyzing...");
              }
              console.log(
                `[actorThink] Conversation changed before send_to; rethinking with ${newMsgs.length} new message(s)`,
              );
              builtinTools = await refreshBuiltinTools();
              continue;
            }
          } catch (err: any) {
            console.error(
              "[actorThink] send_to preflight checkNewMessages failed:",
              err.message,
            );
          }
        }

        if (sendToPlanned) {
          sendToCalledThisTurn = true;
        }

        // Track tool names and emit status
        const toolNames = allContinuableCalls.map((tc: any) => tc.toolName);
        allToolsUsed.push(...toolNames);
        if (onStatus) {
          await onStatus(`Calling ${toolNames.join(", ")}...`);
        }

        const roundBundleId = randomUUID();
        const toolCallRows = new Map<string, any>();
        if (executionEnabled) {
          for (
            let callIndex = 0;
            callIndex < allContinuableCalls.length;
            callIndex++
          ) {
            const tc = allContinuableCalls[callIndex];
            const row = await createToolCall({
              id: tc.callId,
              turnId: options!.turnId!,
              providerStepId: providerStep?.id,
              conversationId: options!.conversationId!,
              sessionId: options?.sessionId,
              callIndex,
              providerCallId: tc.providerCallId,
              bundleId: roundBundleId,
              toolKind: inferToolKind(tc.toolName, mcpToolNames),
              toolName: tc.toolName,
              normalizedInput: tc.input,
            });
            toolCallRows.set(tc.callId, row);
            await updateToolCallStatus(row.id, "running");
          }
        }

        // Execute callable tools (builtin registry)
        const callableResults = [];
        for (const tc of callableCalls) {
          const callRow = toolCallRows.get(tc.callId);
          const attempt =
            executionEnabled && callRow
              ? await createToolExecutionAttempt({
                  toolCallId: callRow.id,
                  attemptNo: 1,
                  executorKind: "callable",
                  transport: "callable",
                  requestPayload: tc.input,
                })
              : null;
          const attemptStart = Date.now();
          const [res] = await executeCallableTools([tc]);
          callableResults.push(res);

          if (executionEnabled && callRow && attempt) {
            const blocks =
              typeof res.content === "string"
                ? textBlocks(res.content)
                : textBlocks(JSON.stringify(res.content));
            await finalizeToolExecutionAttempt({
              attemptId: attempt.id,
              status: res.isError ? "error" : "success",
              isError: res.isError,
              errorMessage:
                res.isError && typeof res.content === "string"
                  ? res.content
                  : undefined,
              durationMs: Date.now() - attemptStart,
              responsePayload: res,
            });
            await createToolResult({
              toolCallId: callRow.id,
              attemptId: attempt.id,
              isError: res.isError,
              errorMessage:
                res.isError && typeof res.content === "string"
                  ? res.content
                  : undefined,
              metadata: res.metadata,
              parts: blocksToToolResultParts(blocks),
            });
            await updateToolCallStatus(
              callRow.id,
              res.isError ? "failed" : "completed",
            );
          }
        }

        const callableInternalErrorToolNames = callableResults
          .filter(
            (result) =>
              result.isError &&
              getToolErrorDetails(result.metadata).kind === "internal",
          )
          .map((result) => result.toolName);

        // Execute MCP tools via mcpExecutor, with content ingestion
        const mcpResults: {
          toolCallId: string;
          providerCallId?: string;
          toolName: string;
          content: CanonicalContentBlock[];
          isError?: boolean;
          metadata?: Record<string, unknown>;
        }[] = [];
        let mcpReplanRequired = false;
        if (mcpCalls.length > 0 && options?.mcpExecutor) {
          const appendMcpFailureResult = async (params: {
            tc: (typeof mcpCalls)[number];
            callRow: any;
            attempt?: { id: string } | null;
            attemptStart: number;
            message: string;
            metadata?: Record<string, unknown>;
            responsePayload?: unknown;
          }) => {
            const content = textBlocks(params.message);
            mcpResults.push({
              toolCallId: params.tc.callId,
              providerCallId: params.tc.providerCallId,
              toolName: params.tc.toolName,
              content,
              isError: true,
              metadata: params.metadata,
            });

            if (executionEnabled && params.callRow) {
              const attemptRow =
                params.attempt ??
                (await createToolExecutionAttempt({
                  toolCallId: params.callRow.id,
                  attemptNo: 1,
                  executorKind: "mcp_plugin",
                  transport: "mcp",
                  requestPayload: params.tc.input,
                }));
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
                });
                await createToolResult({
                  toolCallId: params.callRow.id,
                  attemptId: attemptRow.id,
                  isError: true,
                  errorMessage: params.message,
                  metadata: params.metadata,
                  parts: blocksToToolResultParts(content),
                });
                await updateToolCallStatus(params.callRow.id, "failed");
              }
            }
          };

          for (let mcpIndex = 0; mcpIndex < mcpCalls.length; mcpIndex++) {
            const tc = mcpCalls[mcpIndex];
            const callRow = toolCallRows.get(tc.callId);
            const attempt =
              executionEnabled && callRow
                ? await createToolExecutionAttempt({
                    toolCallId: callRow.id,
                    attemptNo: 1,
                    executorKind: "mcp_plugin",
                    transport: "mcp",
                    requestPayload: tc.input,
                  })
                : null;
            const attemptStart = Date.now();
            try {
              const normalizedResult = await options.mcpExecutor(
                tc.toolName,
                tc.input,
              );
              let normalizedContent = normalizedResult.content;
              let metadata: Record<string, unknown> = {
                ...(normalizedResult.metadata || {}),
                ...(normalizedResult.structuredContent
                  ? { structuredContent: normalizedResult.structuredContent }
                  : {}),
              };

              try {
                const approvalBridge = await maybeAutoBridgeRelayApproval({
                  actorId: actor.id,
                  workspaceId,
                  sessionId: options?.sessionId,
                  conversationId: options?.conversationId,
                  userId: options?.userId,
                  relayToolName: tc.toolName,
                  toolInput: tc.input,
                  result: normalizedResult,
                });
                if (approvalBridge) {
                  normalizedContent = [
                    ...normalizedContent,
                    textBlock(approvalBridge.note),
                  ];
                  metadata = {
                    ...metadata,
                    relayApprovalBridge: {
                      status: approvalBridge.status,
                      interactionId:
                        "interactionId" in approvalBridge
                          ? approvalBridge.interactionId
                          : undefined,
                    },
                  };
                }
              } catch (bridgeError: any) {
                console.error(
                  "[AI] Failed to auto-bridge relay approval:",
                  bridgeError?.message || bridgeError,
                );
              }

              mcpResults.push({
                toolCallId: tc.callId,
                providerCallId: tc.providerCallId,
                toolName: tc.toolName,
                content: normalizedContent,
                isError: normalizedResult.isError,
                metadata,
              });
              allSupplementalBlocks.push(
                ...collectFileRefBlocks(normalizedContent),
              );

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
                });
                await createToolResult({
                  toolCallId: callRow.id,
                  attemptId: attempt.id,
                  isError: normalizedResult.isError,
                  errorMessage: normalizedResult.isError
                    ? extractText(normalizedContent)
                    : undefined,
                  metadata,
                  parts: blocksToToolResultParts(normalizedContent),
                });
                await updateToolCallStatus(
                  callRow.id,
                  normalizedResult.isError ? "failed" : "completed",
                );
              }
            } catch (err: any) {
              const classifiedError = classifyMcpExecutionError(err);
              const formattedMessage = formatMcpExecutionErrorMessage(
                classifiedError.message,
                classifiedError.requiresReplan,
              );
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
              });

              if (classifiedError.requiresReplan) {
                mcpReplanRequired = true;
                for (
                  let skippedIndex = mcpIndex + 1;
                  skippedIndex < mcpCalls.length;
                  skippedIndex++
                ) {
                  const skippedTc = mcpCalls[skippedIndex];
                  const skippedCallRow = toolCallRows.get(skippedTc.callId);
                  const skippedAttemptStart = Date.now();
                  const skippedMessage = formatMcpExecutionErrorMessage(
                    classifiedError.message,
                    true,
                    true,
                  );
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
                    responsePayload: {
                      error: skippedMessage,
                      code: "tool_replan_required",
                      requiresReplan: true,
                      skippedDueToReplan: true,
                    },
                  });
                }
                break;
              }
            }
          }
        }

        const toolResults = [...callableResults, ...mcpResults];

        // Build ToolRound for DB storage
        const roundToolCalls: CanonicalToolCall[] = allContinuableCalls.map(
          (tc: any) => ({
            callId: tc.callId,
            providerCallId: tc.providerCallId,
            toolName: tc.toolName,
            input: tc.input,
          }),
        );
        const roundToolResults: CanonicalToolResult[] = toolResults.map(
          (tr) => ({
            toolCallId: tr.toolCallId,
            providerCallId: tr.providerCallId,
            toolName: tr.toolName,
            content:
              typeof tr.content === "string"
                ? textBlocks(tr.content)
                : Array.isArray(tr.content)
                  ? normalizeCanonicalContentBlocks(tr.content as any[])
                  : textBlocks(JSON.stringify(tr.content)),
            isError: tr.isError,
            metadata: tr.metadata,
          }),
        );
        const roundContentBlocks: CanonicalContentBlock[] = [];
        if (finalTextContent)
          roundContentBlocks.push(textBlock(finalTextContent));
        if (roundMediaBlocks.length > 0)
          roundContentBlocks.push(...roundMediaBlocks);
        toolRounds.push({
          content:
            roundContentBlocks.length > 0 ? roundContentBlocks : undefined,
          toolCalls: roundToolCalls,
          toolResults: roundToolResults,
        });

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
              memberType: "actor",
              actorId: actor.id,
              sessionId: options?.sessionId,
              name: actorDefinition.name,
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
        ]);

        if (callableInternalErrorToolNames.length > 0) {
          appendPrivateTailItems([
            buildCallableInternalErrorNotice(callableInternalErrorToolNames),
          ]);
        }

        if (mcpReplanRequired && !options?.mcpRefresh) {
          throw new Error(
            "MCP tool definitions changed during execution, but no refresh handler is available",
          );
        }

        // If model also produced action calls in the same turn, execute them and finish
        if (!mcpReplanRequired && actionCalls.length > 0) {
          const actions = toolCallsToActions(actionCalls);
          if (executionEnabled) {
            const actionBundleId = randomUUID();
            for (
              let actionIndex = 0;
              actionIndex < actionCalls.length;
              actionIndex++
            ) {
              const tc = actionCalls[actionIndex];
              const actionRow = await createToolCall({
                id: tc.callId,
                turnId: options!.turnId!,
                providerStepId: providerStep?.id,
                conversationId: options!.conversationId!,
                sessionId: options?.sessionId,
                callIndex: actionIndex,
                providerCallId: tc.providerCallId,
                bundleId: actionBundleId,
                toolKind: "action",
                toolName: tc.toolName,
                normalizedInput: tc.input,
              });
              await createToolResult({
                toolCallId: actionRow.id,
                parts: [{ type: "json", json: tc.input }],
              });
              await updateToolCallStatus(actionRow.id, "completed");
            }
          }

          const toolHistory: AssistantToolHistory | undefined =
            toolRounds.length > 0 ? { rounds: toolRounds } : undefined;
          const responseText = finalDraftProvider
            ? finalDraftText
            : finalTextContent;
          const contentBlocks = await buildMergedResponseContentBlocks(
            responseText,
            allSupplementalBlocks,
            getInlineReferenceOptions(),
          );
          return {
            actions,
            reasoning: responseText,
            tokensUsed: totalTokens,
            toolsUsed: allToolsUsed,
            serverToolCalls:
              allServerToolCalls.length > 0 ? allServerToolCalls : undefined,
            citationSources:
              Object.keys(allCitationSources).length > 0
                ? allCitationSources
                : undefined,
            toolHistory,
            contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
          };
        }

        // If 'sleep' callable tool was called, the session is now sleeping — stop the loop
        const sleepCalled = callableCalls.some(
          (tc: any) => tc.toolName === "sleep",
        );
        if (!mcpReplanRequired && sleepCalled) {
          const allowSleepWithoutVisibleReply =
            !enforceVisibleReplyBeforeSleep ||
            sendToCalledThisTurn ||
            participantCount <= 1 ||
            (participantCount > 2 && sleepWithoutSendToReminderCount > 0);

          if (!allowSleepWithoutVisibleReply) {
            sleepWithoutSendToReminderCount += 1;
            appendPrivateTailItems([
              buildSleepWithoutSendToReminder({
                participantCount,
                otherMembers: options?.conversationMembers || [],
                allowConfirmSleepWithoutReply: participantCount > 2,
              }),
            ]);

            if (options?.checkNewMessages) {
              try {
                const newMsgs = await options.checkNewMessages();
                if (newMsgs && newMsgs.length > 0) {
                  appendSharedTailItems(newMsgs);
                  console.log(
                    `[actorThink] Injected ${newMsgs.length} new message(s) between rounds`,
                  );
                }
              } catch (err: any) {
                console.error(
                  "[actorThink] checkNewMessages failed:",
                  err.message,
                );
              }
            }

            builtinTools = await refreshBuiltinTools();
            continue;
          }

          const actions: ActorAction[] = [];
          const toolHistory: AssistantToolHistory | undefined =
            toolRounds.length > 0 ? { rounds: toolRounds } : undefined;
          const responseText = finalDraftProvider
            ? finalDraftText
            : finalTextContent;
          const contentBlocks = await buildMergedResponseContentBlocks(
            responseText,
            allSupplementalBlocks,
            getInlineReferenceOptions(),
          );
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
          };
        }

        // Otherwise continue to next round
        // Dynamic MCP tool refresh between rounds
        if (options?.mcpRefresh) {
          if (mcpReplanRequired && onStatus) {
            await onStatus("MCP tools changed. Refreshing tool definitions...");
          }
          let needsRefresh = mcpReplanRequired;
          if (workspaceId) {
            const latestVersion = await getMcpVersion(workspaceId);
            if (latestVersion !== currentMcpVersion) {
              needsRefresh = true;
            }
          }
          if (needsRefresh) {
            try {
              const refreshed = await options.mcpRefresh();
              mcpToolDefs = refreshed.tools;
              mcpToolNames = new Set(mcpToolDefs.map((t) => t.name));
              currentMcpVersion = refreshed.mcpVersion;
              console.log(
                `[actorThink] MCP tools refreshed: ${mcpToolDefs.length} tools, version=${currentMcpVersion}`,
              );
            } catch (err: any) {
              console.error("[actorThink] MCP refresh failed:", err.message);
              if (mcpReplanRequired) {
                throw new Error(
                  `MCP tool definitions changed during execution, but refresh failed: ${err.message}`,
                );
              }
            }
          }
        }

        builtinTools = await refreshBuiltinTools();

        // Inter-round message injection: check for new messages between rounds
        if (options?.checkNewMessages) {
          try {
            const newMsgs = await options.checkNewMessages();
            if (newMsgs && newMsgs.length > 0) {
              appendSharedTailItems(newMsgs);
              console.log(
                `[actorThink] Injected ${newMsgs.length} new message(s) between rounds`,
              );
            }
          } catch (err: any) {
            console.error("[actorThink] checkNewMessages failed:", err.message);
          }
        }

        continue;
      }

      // No callable calls — keep looping until the model explicitly sleeps or round limit is reached.
      let actions: ActorAction[];
      if (actionCalls.length > 0) {
        actions = await Promise.all(
          toolCallsToActions(actionCalls).map(async (action) => {
            if (action.type !== "respond" || action.contentBlocks) {
              return action;
            }

            const responseBlocks = await buildResponseContentBlocks(
              action.content,
              getInlineReferenceOptions(),
            );

            return {
              ...action,
              contentBlocks:
                responseBlocks.length > 0
                  ? responseBlocks
                  : textBlocks(action.content),
            };
          }),
        );
        if (executionEnabled) {
          const actionBundleId = randomUUID();
          for (
            let actionIndex = 0;
            actionIndex < actionCalls.length;
            actionIndex++
          ) {
            const tc = actionCalls[actionIndex];
            const actionRow = await createToolCall({
              id: tc.callId,
              turnId: options!.turnId!,
              providerStepId: providerStep?.id,
              conversationId: options!.conversationId!,
              sessionId: options?.sessionId,
              callIndex: actionIndex,
              providerCallId: tc.providerCallId,
              bundleId: actionBundleId,
              toolKind: "action",
              toolName: tc.toolName,
              normalizedInput: tc.input,
            });
            await createToolResult({
              toolCallId: actionRow.id,
              parts: [{ type: "json", json: tc.input }],
            });
            await updateToolCallStatus(actionRow.id, "completed");
          }
        }
        actions = [];
      } else {
        actions = [];
      }

      if (finalTextContent.trim().length > 0 || roundMediaBlocks.length > 0) {
        const draftBlocks = await buildMergedResponseContentBlocks(
          finalTextContent,
          roundMediaBlocks,
          getInlineReferenceOptions(),
        );
        if (draftBlocks.length > 0) {
          appendSharedTailItems(
            buildAdHocContextItems([
              {
                role: "assistant",
                content: draftBlocks,
              },
            ]),
          );
        }
      }

      if (options?.checkNewMessages) {
        try {
          const newMsgs = await options.checkNewMessages();
          if (newMsgs && newMsgs.length > 0) {
            appendSharedTailItems(newMsgs);
            console.log(
              `[actorThink] Injected ${newMsgs.length} new message(s) between rounds`,
            );
          }
        } catch (err: any) {
          console.error("[actorThink] checkNewMessages failed:", err.message);
        }
      }

      builtinTools = await refreshBuiltinTools();
      continue;
    }

    // Exceeded MAX_TOOL_ROUNDS — fallback respond
    console.warn(
      `[actorThink] actor=${actor.id} exceeded max tool rounds (${MAX_TOOL_ROUNDS})`,
    );

    if (finalDraftProvider || allSupplementalBlocks.length > 0) {
      const contentBlocks = await buildMergedResponseContentBlocks(
        finalDraftText,
        allSupplementalBlocks,
        getInlineReferenceOptions(),
      );
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
      };
    }

    return {
      actions: [
        {
          type: "respond",
          content:
            "I ran into complexity processing this request. Please try again with a simpler question.",
          contentBlocks: textBlocks(
            "I ran into complexity processing this request. Please try again with a simpler question.",
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
    };
  } // end _actorThinkInner
}

export async function aiComplete(
  system: string,
  messages: { role: string; content: string }[],
  resolved?: ResolvedModelConfig | null,
  logContext?: { workspaceId?: string; actorId?: string },
): Promise<{ content: string; tokensUsed: { input: number; output: number } }> {
  const provider = getProvider(resolved);
  const contextItems = buildAdHocContextItems(
    messages.map((message) => ({
      role: message.role as "user" | "assistant",
      content: textBlocks(message.content),
    })),
  );
  const contextWindow = buildAdHocProviderContextWindow(contextItems);

  const startTime = Date.now();
  let status = "success";
  let errorMessage: string | undefined;
  let response;

  const requestLog = {
    provider: resolved?.providerType || config.ai.provider,
    model: resolved?.modelName || config.ai.model,
    system,
    contextWindow,
  };

  try {
    response = await provider.chat({ system, contextWindow });
  } catch (err: any) {
    status = "error";
    errorMessage = err.message;
    await logAIRequest({
      workspaceId: logContext?.workspaceId,
      actorId: logContext?.actorId,
      groupId: resolved?.groupId,
      profileId: resolved?.profileId,
      profileRevisionId: resolved?.profileRevisionId,
      requestType: "ai_complete",
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startTime,
      status,
      errorMessage,
      requestBody: requestLog,
    });
    throw err;
  }

  const latencyMs = Date.now() - startTime;
  const ctxMsg = response.context[0];
  const responseText =
    ctxMsg?.role === "assistant" ? extractText(ctxMsg.content) : "";

  await logAIRequest({
    workspaceId: logContext?.workspaceId,
    actorId: logContext?.actorId,
    groupId: resolved?.groupId,
    profileId: resolved?.profileId,
    profileRevisionId: resolved?.profileRevisionId,
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
  });

  return {
    content: responseText,
    tokensUsed: response.tokensUsed,
  };
}
