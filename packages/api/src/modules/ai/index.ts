import type { Actor, ActorSkill, Memory, ThinkingResult, ActorAction, ConversationMessage, ResolvedModelConfig, ServerToolCall, ToolRound, CanonicalToolCall, CanonicalToolResult, AssistantToolHistory, GroupMemberEntry, ToolResolveContext, CanonicalContentBlock, ProviderContextWindow } from '@synapse/shared';
import type { CanonicalContextItem } from '@synapse/shared/types';
import { textBlocks, extractText } from '@synapse/shared';
import { randomUUID } from 'crypto';
import { config } from '../../config/index.js';
import { createAIProvider, type AIProvider, type AIProviderConfig } from './providers/index.js';
import { toolCallsToActions } from './tools.js';
import { buildActorPrompt } from './prompt-builder.js';
import { logAIRequest } from '../model-groups/service.js';
import { resolveBuiltinTools, executeCallableTools, isCallableTool, isActionTool } from './tool-plugins.js';
import { runWithToolContext } from './session-tools.js';
import { getMcpVersion } from '../mcp-plugins/instance-manager.js';
import { ingestToolResultContent, ingestResponseMedia } from './content-ingest.js';
import { resolveFileRefSegments } from './fileref-resolver.js';
import { buildAdHocContextItems } from './context-builder.js';
import { buildAdHocProviderContextWindow } from '../context/service.js';
import {
  createToolCall,
  createToolExecutionAttempt,
  createToolResult,
  finalizeToolExecutionAttempt,
  logProviderStep,
  updateToolCallStatus,
} from '../execution/service.js';

export { buildActorPrompt } from './prompt-builder.js';

const MAX_TOOL_ROUNDS = 10;

// Cache providers by config fingerprint to avoid recreating
const providerCache = new Map<string, AIProvider>();

function getProvider(resolved?: ResolvedModelConfig | null): AIProvider {
  const providerConfig: AIProviderConfig = resolved
    ? {
        apiKey: resolved.apiKey,
        baseUrl: resolved.baseUrl,
        model: resolved.modelName,
        maxTokens: resolved.maxTokens,
      }
    : {
        apiKey: config.ai.apiKey,
        baseUrl: config.ai.baseUrl,
        model: config.ai.model,
        maxTokens: config.ai.maxTokens,
      };

  const providerName = resolved?.providerType || config.ai.provider;
  const cacheKey = `${providerName}:${providerConfig.apiKey}:${providerConfig.baseUrl}:${providerConfig.model}`;

  let provider = providerCache.get(cacheKey);
  if (!provider) {
    provider = createAIProvider(providerName, providerConfig);
    providerCache.set(cacheKey, provider);
  }
  return provider;
}

function collectFileRefBlocks(blocks: CanonicalContentBlock[]): Extract<CanonicalContentBlock, { type: 'file_ref' }>[] {
  return blocks.filter((block): block is Extract<CanonicalContentBlock, { type: 'file_ref' }> => block.type === 'file_ref');
}

function mergeContentBlocks(
  baseBlocks: CanonicalContentBlock[],
  extraBlocks: CanonicalContentBlock[],
): CanonicalContentBlock[] {
  const merged: CanonicalContentBlock[] = [...baseBlocks];
  const seenFileIds = new Set(
    merged
      .filter((block): block is Extract<CanonicalContentBlock, { type: 'file_ref' }> => block.type === 'file_ref')
      .map((block) => block.fileId),
  );

  for (const block of extraBlocks) {
    if (block.type === 'text') {
      if (block.text) merged.push(block);
      continue;
    }
    if (seenFileIds.has(block.fileId)) continue;
    seenFileIds.add(block.fileId);
    merged.push(block);
  }

  return merged;
}

async function buildResponseContentBlocks(
  provider: AIProvider,
  textContent: string,
  supplementalBlocks: CanonicalContentBlock[],
): Promise<CanonicalContentBlock[]> {
  const segments = provider.parseFileRefs(textContent);
  const baseBlocks = segments.some((segment) => segment.type === 'ref')
    ? await resolveFileRefSegments(segments)
    : textContent
      ? [{ type: 'text', text: textContent } satisfies CanonicalContentBlock]
      : [];

  return mergeContentBlocks(baseBlocks, supplementalBlocks);
}

interface Subordinate {
  name: string;
  title: string;
  charter: string;
  skills?: ActorSkill[];
}

function blocksToToolResultParts(blocks: CanonicalContentBlock[]) {
  return blocks.map((block) => {
    if (block.type === 'text') {
      return { type: 'text' as const, text: block.text };
    }
    return {
      type: 'file_ref' as const,
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

function inferToolKind(toolName: string, mcpToolNames: Set<string>) {
  if (mcpToolNames.has(toolName)) return 'mcp_plugin' as const;
  if (isActionTool(toolName)) return 'action' as const;
  if (isCallableTool(toolName)) return 'callable' as const;
  return 'builtin' as const;
}

export async function actorThink(
  actor: Actor,
  memories: Memory[],
  contextWindow: ProviderContextWindow,
  subordinates?: Subordinate[],
  resolved?: ResolvedModelConfig | null,
  workspaceId?: string,
  options?: {
    sessionId?: string;
    turnId?: string;
    conversationId?: string;
    groupId?: string;
    groupMembers?: GroupMemberEntry[];
    userId?: string;
    onStatus?: (status: string) => Promise<void>;
    mcpTools?: import('@synapse/shared').ToolDefinition[];
    mcpExecutor?: (toolName: string, input: Record<string, unknown>) => Promise<string | unknown[]>;
    mcpVersion?: number;
    mcpRefresh?: () => Promise<{ tools: import('@synapse/shared').ToolDefinition[]; mcpVersion: number }>;
    mcpSetTurnId?: (turnId: string, round?: number) => void;
    system: string;
    checkNewMessages?: () => Promise<CanonicalContextItem[] | null>;
  },
): Promise<ThinkingResult> {
  const system = options?.system || '';
  const provider = getProvider(resolved);
  let allTools: import('@synapse/shared').ToolDefinition[] = [];

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

  const buildRequestLog = (round: number) => ({
    provider: resolved?.providerType || config.ai.provider,
    model: resolved?.modelName || config.ai.model,
    round,
    system,
    contextWindow: allContextWindow,
    tools: allTools,
    builtinTools: resolved?.builtinTools || null,
    multimodal: resolved?.multimodal || null,
  });

  // Build ToolResolveContext for builtin tool resolution
  const resolveCtx: ToolResolveContext = {
    sessionId: options?.sessionId || '',
    actorId: actor.id,
    workspaceId: workspaceId || '',
    groupId: options?.groupId,
    groupMembers: options?.groupMembers,
    userId: options?.userId,
    userCount: options?.groupMembers?.filter(m => m.type === 'user').length,
  };

  // Resolve builtin tools (action + callable)
  const builtinTools = resolveBuiltinTools(resolveCtx);

  // MCP tools (already resolved and authorized by tool-resolver.ts)
  let mcpToolDefs = options?.mcpTools || [];
  let mcpToolNames = new Set(mcpToolDefs.map(t => t.name));

  // Merge: MCP names override builtin (defensive)
  const filteredBuiltin = builtinTools.filter(t => !mcpToolNames.has(t.name));
  allTools = [...filteredBuiltin, ...mcpToolDefs];
  let currentMcpVersion = options?.mcpVersion ?? 0;

  const startTime = Date.now();
  const turnId = options?.turnId || randomUUID();
  const executionEnabled = !!options?.turnId && !!options?.conversationId;
  let totalTokens = { input: 0, output: 0 };

  const allToolsUsed: string[] = []; // track callable tools invoked
  const allServerToolCalls: ServerToolCall[] = []; // track cloud-side tool calls
  let allCitationSources: Record<string, { url: string; title: string }> = {}; // cite index → source
  const onStatus = options?.onStatus;
  let currentRound = 0; // track for error handler

  // Accumulate ToolRound[] for DB storage only (not passed to provider)
  const toolRounds: ToolRound[] = [];
  // Accumulate media attachments from MCP/model responses
  const allSupplementalBlocks: CanonicalContentBlock[] = [];

  // Common fields for logAIRequest
  const logCommon = {
    workspaceId,
    actorId: actor.id,
    sessionId: options?.sessionId,
    turnId,
    groupId: resolved?.groupId,
    itemId: resolved?.itemId,
    configId: resolved?.configId,
    requestType: 'actor_think' as const,
  };

  // Set tool execution context for session-aware callable tools
  // Uses AsyncLocalStorage — each concurrent call gets its own context
  if (options?.sessionId) {
    return runWithToolContext(
      { sessionId: options.sessionId, actorId: actor.id, workspaceId: workspaceId || '' },
      () => _actorThinkInner(),
    );
  }
  return _actorThinkInner();

  async function _actorThinkInner(): Promise<ThinkingResult> {
  const recordProviderRound = async (params: {
    round: number;
    latencyMs: number;
    status: 'success' | 'error' | 'timeout';
    requestBody: unknown;
    responseBody?: unknown;
    stopReason?: string;
    inputTokens: number;
    outputTokens: number;
    errorMessage?: string;
  }) => {
    if (executionEnabled) {
      return logProviderStep({
        turnId: options!.turnId!,
        stepIndex: params.round,
        providerType: (resolved?.providerType || config.ai.provider) === 'openai' ? 'openai' : 'anthropic',
        requestType: 'actor_think',
        modelGroupId: resolved?.groupId,
        modelItemId: resolved?.itemId,
        modelConfigId: resolved?.configId,
        modelName: resolved?.modelName || config.ai.model,
        capabilitiesSnapshot: {
          builtinTools: resolved?.builtinTools || [],
          multimodal: resolved?.multimodal || null,
          toolNames: allTools.map((tool) => tool.name),
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
      round: params.round,
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

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      currentRound = round + 1;
      const roundStartTime = Date.now();

      // Set turn+round context for MCP executor
      if (options?.mcpSetTurnId) options.mcpSetTurnId(turnId, currentRound);

      const response = await provider.chat({
        system,
        contextWindow: allContextWindow,
        tools: allTools,
        builtinTools: resolved?.builtinTools,
        multimodal: resolved?.multimodal,
      });

      const roundLatencyMs = Date.now() - roundStartTime;
      totalTokens.input += response.tokensUsed.input;
      totalTokens.output += response.tokensUsed.output;

      // Extract from canonical context
      const assistantMsg = response.context[0];
      const textContent = assistantMsg?.role === 'assistant' ? extractText(assistantMsg.content) : '';
      const toolCalls = (assistantMsg?.role === 'assistant' && assistantMsg.toolCalls) ? assistantMsg.toolCalls : [];

      // Build per-round request/response bodies for logging
      const roundRequestBody = buildRequestLog(currentRound);
      const roundResponseBody = {
        stopReason: response.stopReason,
        toolCalls: toolCalls.map((tc: any) => ({
          callId: tc.callId,
          providerCallId: tc.providerCallId,
          toolName: tc.toolName,
          input: tc.input,
        })),
        textContent,
        rawAssistantMessage: response.rawAssistantMessage,
      };

      const providerStep = await recordProviderRound({
        round: currentRound,
        latencyMs: roundLatencyMs,
        status: 'success',
        requestBody: roundRequestBody,
        responseBody: roundResponseBody,
        stopReason: response.stopReason,
        inputTokens: response.tokensUsed.input,
        outputTokens: response.tokensUsed.output,
      }).catch((err) => {
        console.error('[actorThink] Failed to log AI request:', err.message);
        return null;
      });

      console.log(`[actorThink] actor=${actor.id} turn=${turnId.slice(0,8)} round=${currentRound} stopReason=${response.stopReason} toolCalls=[${toolCalls.map((tc: any) => tc.toolName).join(',')}] textLen=${textContent.length}`);

      // Ingest response media → CanonicalContentBlock[] for ToolRound.content
      let roundMediaBlocks: CanonicalContentBlock[] = [];
      if (response.mediaBlocks && response.mediaBlocks.length > 0 && workspaceId) {
        try {
          roundMediaBlocks = await ingestResponseMedia(response.mediaBlocks, resolved?.providerType || 'anthropic', workspaceId);
          allSupplementalBlocks.push(...collectFileRefBlocks(roundMediaBlocks));
        } catch (err: any) {
          console.error('[actorThink] Failed to ingest response media:', err.message);
        }
      }

      // Extract server-side tool calls from raw response (Anthropic web_search/web_fetch, OpenAI web_search_call)
      const serverCalls = extractServerToolCalls(response.rawAssistantMessage);
      if (serverCalls.length > 0) {
        allServerToolCalls.push(...serverCalls);
        if (onStatus) {
          const labels = serverCalls.map((sc) => {
            if (sc.type === 'web_search') return `Searching "${sc.query || '...'}"`;
            if (sc.type === 'web_fetch') return `Fetching ${sc.url || '...'}`;
            return sc.type;
          });
          await onStatus(labels.join(', '));
        }
      }

      // Extract citation index → source mapping from raw response
      const citations = extractCitationSources(response.rawAssistantMessage);
      if (citations) {
        allCitationSources = { ...allCitationSources, ...citations };
      }

      // For OpenAI: inject <cite> markers into text using url_citation annotations
      // We need a mutable textContent for citation injection
      let finalTextContent = textContent;
      if (citations && !Array.isArray(response.rawAssistantMessage)) {
        finalTextContent = injectOpenAICitationMarkers(textContent, response.rawAssistantMessage, citations);
      }

      // Dispatch: three-bucket separation
      const actionCalls   = toolCalls.filter((tc: any) => isActionTool(tc.toolName));
      const callableCalls = toolCalls.filter((tc: any) => isCallableTool(tc.toolName));
      const mcpCalls      = toolCalls.filter((tc: any) => mcpToolNames.has(tc.toolName));
      const allContinuableCalls = [...callableCalls, ...mcpCalls];

      if (allContinuableCalls.length > 0) {
        // Track tool names and emit status
        const toolNames = allContinuableCalls.map((tc: any) => tc.toolName);
        allToolsUsed.push(...toolNames);
        if (onStatus) {
          await onStatus(`Calling ${toolNames.join(', ')}...`);
        }

        const roundBundleId = randomUUID();
        const toolCallRows = new Map<string, any>();
        if (executionEnabled) {
          for (let callIndex = 0; callIndex < allContinuableCalls.length; callIndex++) {
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
            await updateToolCallStatus(row.id, 'running');
          }
        }

        // Execute callable tools (builtin registry)
        const callableResults = [];
        for (const tc of callableCalls) {
          const callRow = toolCallRows.get(tc.callId);
          const attempt = executionEnabled && callRow
            ? await createToolExecutionAttempt({
                toolCallId: callRow.id,
                attemptNo: 1,
                executorKind: 'callable',
                transport: 'callable',
                requestPayload: tc.input,
              })
            : null;
          const attemptStart = Date.now();
          const [res] = await executeCallableTools([tc]);
          callableResults.push(res);

          if (executionEnabled && callRow && attempt) {
            const blocks = typeof res.content === 'string'
              ? textBlocks(res.content)
              : textBlocks(JSON.stringify(res.content));
            await finalizeToolExecutionAttempt({
              attemptId: attempt.id,
              status: res.isError ? 'error' : 'success',
              isError: res.isError,
              errorMessage: res.isError && typeof res.content === 'string' ? res.content : undefined,
              durationMs: Date.now() - attemptStart,
              responsePayload: res,
            });
            await createToolResult({
              toolCallId: callRow.id,
              attemptId: attempt.id,
              isError: res.isError,
              errorMessage: res.isError && typeof res.content === 'string' ? res.content : undefined,
              parts: blocksToToolResultParts(blocks),
            });
            await updateToolCallStatus(callRow.id, res.isError ? 'failed' : 'completed');
          }
        }

        // Execute MCP tools via mcpExecutor, with content ingestion
        const mcpResults: { toolCallId: string; providerCallId?: string; toolName: string; content: CanonicalContentBlock[]; isError?: boolean; metadata?: Record<string, unknown> }[] = [];
        if (mcpCalls.length > 0 && options?.mcpExecutor) {
          for (const tc of mcpCalls) {
            const callRow = toolCallRows.get(tc.callId);
            const attempt = executionEnabled && callRow
              ? await createToolExecutionAttempt({
                  toolCallId: callRow.id,
                  attemptNo: 1,
                  executorKind: 'mcp_plugin',
                  transport: 'mcp',
                  requestPayload: tc.input,
                })
              : null;
            const attemptStart = Date.now();
            try {
              const rawResult = await options.mcpExecutor(tc.toolName, tc.input);
              // Ingest MCP result content into platform file storage (always returns CanonicalContentBlock[])
              const normalizedContent = workspaceId
                ? await ingestToolResultContent(rawResult, workspaceId)
                : (typeof rawResult === 'string' ? textBlocks(rawResult) : textBlocks(JSON.stringify(rawResult)));
              mcpResults.push({
                toolCallId: tc.callId,
                providerCallId: tc.providerCallId,
                toolName: tc.toolName,
                content: normalizedContent,
              });
              allSupplementalBlocks.push(...collectFileRefBlocks(normalizedContent));

              if (executionEnabled && callRow && attempt) {
                await finalizeToolExecutionAttempt({
                  attemptId: attempt.id,
                  status: 'success',
                  durationMs: Date.now() - attemptStart,
                  responsePayload: rawResult,
                });
                await createToolResult({
                  toolCallId: callRow.id,
                  attemptId: attempt.id,
                  parts: blocksToToolResultParts(normalizedContent),
                });
                await updateToolCallStatus(callRow.id, 'completed');
              }
            } catch (err: any) {
              mcpResults.push({
                toolCallId: tc.callId,
                providerCallId: tc.providerCallId,
                toolName: tc.toolName,
                content: textBlocks(`Error: ${err.message}`),
                isError: true,
              });
              if (executionEnabled && callRow && attempt) {
                const errorBlocks = textBlocks(`Error: ${err.message}`);
                await finalizeToolExecutionAttempt({
                  attemptId: attempt.id,
                  status: 'error',
                  isError: true,
                  errorMessage: err.message,
                  durationMs: Date.now() - attemptStart,
                  responsePayload: { error: err.message },
                });
                await createToolResult({
                  toolCallId: callRow.id,
                  attemptId: attempt.id,
                  isError: true,
                  errorMessage: err.message,
                  parts: blocksToToolResultParts(errorBlocks),
                });
                await updateToolCallStatus(callRow.id, 'failed');
              }
            }
          }
        }

        const toolResults = [...callableResults, ...mcpResults];

        // Build ToolRound for DB storage
        const roundToolCalls: CanonicalToolCall[] = allContinuableCalls.map((tc: any) => ({
          callId: tc.callId,
          providerCallId: tc.providerCallId,
          toolName: tc.toolName,
          input: tc.input,
        }));
        const roundToolResults: CanonicalToolResult[] = toolResults.map((tr) => ({
          toolCallId: tr.toolCallId,
          providerCallId: tr.providerCallId,
          toolName: tr.toolName,
          content: typeof tr.content === 'string' ? textBlocks(tr.content) : (Array.isArray(tr.content) ? tr.content as CanonicalContentBlock[] : textBlocks(JSON.stringify(tr.content))),
          isError: tr.isError,
          metadata: tr.metadata,
        }));
        const roundContentBlocks: CanonicalContentBlock[] = [];
        if (finalTextContent) roundContentBlocks.push({ type: 'text', text: finalTextContent });
        if (roundMediaBlocks.length > 0) roundContentBlocks.push(...roundMediaBlocks);
        toolRounds.push({
          content: roundContentBlocks.length > 0 ? roundContentBlocks : undefined,
          toolCalls: roundToolCalls,
          toolResults: roundToolResults,
        });

        appendPrivateTailItems([{
          kind: 'tool_call_batch',
          conversationId: options?.conversationId,
          sessionId: options?.sessionId,
          turnId,
          scope: 'private',
          surface: 'internal',
          role: 'assistant',
          bundleId: roundBundleId,
          author: {
            memberType: 'actor',
            actorId: actor.id,
            sessionId: options?.sessionId,
            name: actor.name,
            isSelf: true,
          },
          content: roundContentBlocks.length > 0 ? roundContentBlocks : undefined,
          toolCalls: roundToolCalls,
        }, {
          kind: 'tool_result_batch',
          conversationId: options?.conversationId,
          sessionId: options?.sessionId,
          turnId,
          scope: 'private',
          surface: 'internal',
          bundleId: roundBundleId,
          toolResults: roundToolResults,
        }]);

        // If model also produced action calls in the same turn, execute them and finish
        if (actionCalls.length > 0) {
          const actions = toolCallsToActions(actionCalls);
          if (executionEnabled) {
            const actionBundleId = randomUUID();
            for (let actionIndex = 0; actionIndex < actionCalls.length; actionIndex++) {
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
                toolKind: 'action',
                toolName: tc.toolName,
                normalizedInput: tc.input,
              });
              await createToolResult({
                toolCallId: actionRow.id,
                parts: [{ type: 'json', json: tc.input }],
              });
              await updateToolCallStatus(actionRow.id, 'completed');
            }
          }

          const toolHistory: AssistantToolHistory | undefined = toolRounds.length > 0 ? { rounds: toolRounds } : undefined;
          const contentBlocks = await buildResponseContentBlocks(provider, finalTextContent, allSupplementalBlocks);
          return {
            actions,
            reasoning: finalTextContent,
            tokensUsed: totalTokens,
            toolsUsed: allToolsUsed,
            serverToolCalls: allServerToolCalls.length > 0 ? allServerToolCalls : undefined,
            citationSources: Object.keys(allCitationSources).length > 0 ? allCitationSources : undefined,
            toolHistory,
            contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
          };
        }

        // If 'sleep' callable tool was called, the session is now sleeping — stop the loop
        const sleepCalled = callableCalls.some((tc: any) => tc.toolName === 'sleep');
        if (sleepCalled) {
          const actions: ActorAction[] = [];
          const toolHistory: AssistantToolHistory | undefined = toolRounds.length > 0 ? { rounds: toolRounds } : undefined;
          const contentBlocks = await buildResponseContentBlocks(provider, finalTextContent, allSupplementalBlocks);
          return {
            actions,
            reasoning: finalTextContent,
            tokensUsed: totalTokens,
            toolsUsed: allToolsUsed.length > 0 ? allToolsUsed : undefined,
            serverToolCalls: allServerToolCalls.length > 0 ? allServerToolCalls : undefined,
            citationSources: Object.keys(allCitationSources).length > 0 ? allCitationSources : undefined,
            toolHistory,
            contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
          };
        }

        // Otherwise continue to next round
        // Dynamic MCP tool refresh between rounds
        if (options?.mcpRefresh && workspaceId) {
          const latestVersion = await getMcpVersion(workspaceId);
          if (latestVersion !== currentMcpVersion) {
            try {
              const refreshed = await options.mcpRefresh();
              mcpToolDefs = refreshed.tools;
              mcpToolNames = new Set(mcpToolDefs.map(t => t.name));
              const refreshedBuiltin = builtinTools.filter(t => !mcpToolNames.has(t.name));
              allTools = [...refreshedBuiltin, ...mcpToolDefs];
              currentMcpVersion = refreshed.mcpVersion;
              console.log(`[actorThink] MCP tools refreshed: ${mcpToolDefs.length} tools, version=${currentMcpVersion}`);
            } catch (err: any) {
              console.error('[actorThink] MCP refresh failed:', err.message);
            }
          }
        }

        // Inter-round message injection: check for new messages between rounds
        if (options?.checkNewMessages) {
          try {
            const newMsgs = await options.checkNewMessages();
            if (newMsgs && newMsgs.length > 0) {
              appendSharedTailItems(newMsgs);
              console.log(`[actorThink] Injected ${newMsgs.length} new message(s) between rounds`);
            }
          } catch (err: any) {
            console.error('[actorThink] checkNewMessages failed:', err.message);
          }
        }

        continue;
      }

      // No callable calls — process action calls (terminal) and finish
      let actions: ActorAction[];
      if (actionCalls.length > 0) {
        actions = toolCallsToActions(actionCalls).map((action) => (
          action.type === 'respond' && !action.contentBlocks
            ? { ...action, contentBlocks: textBlocks(action.content) }
            : action
        ));
        if (executionEnabled) {
          const actionBundleId = randomUUID();
          for (let actionIndex = 0; actionIndex < actionCalls.length; actionIndex++) {
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
              toolKind: 'action',
              toolName: tc.toolName,
              normalizedInput: tc.input,
            });
            await createToolResult({
              toolCallId: actionRow.id,
              parts: [{ type: 'json', json: tc.input }],
            });
            await updateToolCallStatus(actionRow.id, 'completed');
          }
        }
      } else if (finalTextContent) {
        // Pure text with no tool calls = reasoning only. No visible group message.
        // send_to handles all visible messaging; text here is saved as session_message for audit.
        actions = [];
      } else if (allToolsUsed.length > 0) {
        // Actor used callable tools (e.g. send_to) in earlier rounds but has nothing to say now.
        // Don't generate a fallback — the actor communicated via tools. Worker will auto-sleep.
        actions = [];
      } else {
        actions = [{
          type: 'respond',
          content: 'I could not process this request.',
          contentBlocks: textBlocks('I could not process this request.'),
        }];
      }

      const toolHistory: AssistantToolHistory | undefined = toolRounds.length > 0 ? { rounds: toolRounds } : undefined;
      const contentBlocks = await buildResponseContentBlocks(provider, finalTextContent, allSupplementalBlocks);
      return {
        actions,
        reasoning: finalTextContent,
        tokensUsed: totalTokens,
        toolsUsed: allToolsUsed.length > 0 ? allToolsUsed : undefined,
        serverToolCalls: allServerToolCalls.length > 0 ? allServerToolCalls : undefined,
        citationSources: Object.keys(allCitationSources).length > 0 ? allCitationSources : undefined,
        toolHistory,
        contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
      };
    }

    // Exceeded MAX_TOOL_ROUNDS — fallback respond
    console.warn(`[actorThink] actor=${actor.id} exceeded max tool rounds (${MAX_TOOL_ROUNDS})`);

    return {
      actions: [{
        type: 'respond',
        content: 'I ran into complexity processing this request. Please try again with a simpler question.',
        contentBlocks: textBlocks('I ran into complexity processing this request. Please try again with a simpler question.'),
      }],
      reasoning: 'Exceeded maximum tool rounds',
      tokensUsed: totalTokens,
      toolsUsed: allToolsUsed.length > 0 ? allToolsUsed : undefined,
      serverToolCalls: allServerToolCalls.length > 0 ? allServerToolCalls : undefined,
      citationSources: Object.keys(allCitationSources).length > 0 ? allCitationSources : undefined,
      toolHistory: toolRounds.length > 0 ? { rounds: toolRounds } : undefined,
      contentBlocks: allSupplementalBlocks.length > 0 ? allSupplementalBlocks : undefined,
    };
  } catch (err: any) {
    await recordProviderRound({
      round: currentRound || 1,
      latencyMs: Date.now() - startTime,
      status: 'error',
      requestBody: buildRequestLog(currentRound || 1),
      inputTokens: totalTokens.input,
      outputTokens: totalTokens.output,
      errorMessage: err.message,
    }).catch(() => {});
    throw err;
  }
  } // end _actorThinkInner
}

export async function aiComplete(
  system: string,
  messages: { role: string; content: string }[],
  resolved?: ResolvedModelConfig | null,
  logContext?: { workspaceId?: string; actorId?: string },
): Promise<{ content: string; tokensUsed: { input: number; output: number } }> {
  const provider = getProvider(resolved);
  const contextItems = buildAdHocContextItems(messages.map((message) => ({
    role: message.role as 'user' | 'assistant',
    content: textBlocks(message.content),
  })));
  const contextWindow = buildAdHocProviderContextWindow(contextItems);

  const startTime = Date.now();
  let status = 'success';
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
    status = 'error';
    errorMessage = err.message;
    await logAIRequest({
      workspaceId: logContext?.workspaceId,
      actorId: logContext?.actorId,
      groupId: resolved?.groupId,
      itemId: resolved?.itemId,
      configId: resolved?.configId,
      requestType: 'ai_complete',
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
  const responseText = ctxMsg?.role === 'assistant' ? extractText(ctxMsg.content) : '';

  await logAIRequest({
    workspaceId: logContext?.workspaceId,
    actorId: logContext?.actorId,
    groupId: resolved?.groupId,
    itemId: resolved?.itemId,
    configId: resolved?.configId,
    requestType: 'ai_complete',
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

/**
 * Extract server-side tool calls from the raw assistant message.
 * Handles both Anthropic (server_tool_use + web_search_tool_result / web_fetch_tool_result)
 * and OpenAI (web_search_call) formats.
 */
function extractServerToolCalls(rawMessage: unknown): ServerToolCall[] {
  const calls: ServerToolCall[] = [];

  // Anthropic format: rawMessage is content block array
  if (Array.isArray(rawMessage)) {
    const blocks = rawMessage as any[];
    // Build a map of tool_use_id → ServerToolCall for pairing with results
    const pendingByUseId = new Map<string, ServerToolCall>();

    for (const block of blocks) {
      // server_tool_use: Claude decided to call a server tool
      if (block.type === 'server_tool_use') {
        const call: ServerToolCall = { type: block.name === 'web_fetch' ? 'web_fetch' : 'web_search' };
        if (block.name === 'web_search' && block.input?.query) {
          call.query = block.input.query;
        }
        if (block.name === 'web_fetch' && block.input?.url) {
          call.url = block.input.url;
        }
        if (block.id) pendingByUseId.set(block.id, call);
        calls.push(call);
      }

      // web_search_tool_result: search results from Anthropic
      if (block.type === 'web_search_tool_result' && block.tool_use_id) {
        const parent = pendingByUseId.get(block.tool_use_id);
        if (parent && Array.isArray(block.content)) {
          parent.results = block.content
            .filter((r: any) => r.type === 'web_search_result' && r.url)
            .map((r: any) => ({
              url: r.url,
              title: r.title || '',
              pageAge: r.page_age,
            }));
        }
      }

      // web_fetch_tool_result: fetch result from Anthropic
      if (block.type === 'web_fetch_tool_result' && block.tool_use_id) {
        const parent = pendingByUseId.get(block.tool_use_id);
        if (parent && block.content?.url) {
          parent.url = block.content.url;
        }
      }
    }
  }

  // OpenAI format: rawMessage is a message object with potential web_search_call in output
  if (rawMessage && typeof rawMessage === 'object' && !Array.isArray(rawMessage)) {
    const msg = rawMessage as any;
    if (Array.isArray(msg.output)) {
      for (const item of msg.output) {
        if (item.type === 'web_search_call') {
          calls.push({ type: 'web_search', query: item.action?.query });
        }
      }
    }
  }

  return calls;
}

/**
 * Extract citation index → source mapping from rawAssistantMessage.
 *
 * Anthropic format:
 *   rawMessage is a content block array. <cite index="X-Y"> maps to content
 *   block X, search result Y (0-indexed). Also extracts structured citations
 *   from text blocks. Returns { "3-1": { url, title }, ... }
 *
 * OpenAI Responses API format:
 *   rawMessage is a message object whose content[].annotations contain
 *   url_citation objects with start_index, end_index, url, title.
 *   Returns { "oai-0": { url, title }, ... }
 */
function extractCitationSources(rawMessage: unknown): Record<string, { url: string; title: string }> | undefined {
  const sources: Record<string, { url: string; title: string }> = {};
  let hasSources = false;

  // ── Anthropic format: rawMessage is content block array ──
  if (Array.isArray(rawMessage)) {
    const blocks = rawMessage as any[];

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];

      // Map web_search_tool_result blocks by their index
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        const results = block.content.filter((r: any) => r.type === 'web_search_result');
        for (let j = 0; j < results.length; j++) {
          const r = results[j];
          if (r.url) {
            sources[`${i}-${j}`] = { url: r.url, title: r.title || '' };
            hasSources = true;
          }
        }
      }

      // Also extract structured citations from text blocks
      if (block.type === 'text' && Array.isArray(block.citations)) {
        for (const cit of block.citations) {
          if (cit.url && cit.type === 'web_search_result_location') {
            if (!Object.values(sources).some((s) => s.url === cit.url)) {
              const key = `cit-${cit.url}`;
              sources[key] = { url: cit.url, title: cit.title || '' };
              hasSources = true;
            }
          }
        }
      }
    }
  }

  // ── OpenAI format: rawMessage is a message object ──
  if (rawMessage && typeof rawMessage === 'object' && !Array.isArray(rawMessage)) {
    const msg = rawMessage as any;

    // Responses API: msg.content is array of output_text blocks with annotations
    const contentBlocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of contentBlocks) {
      if (block.type === 'output_text' && Array.isArray(block.annotations)) {
        for (const ann of block.annotations) {
          if (ann.type === 'url_citation' && ann.url) {
            if (!Object.values(sources).some((s) => s.url === ann.url)) {
              const key = `oai-${ann.url}`;
              sources[key] = { url: ann.url, title: ann.title || '' };
              hasSources = true;
            }
          }
        }
      }
    }

    // Responses API: output array contains message items
    if (Array.isArray(msg.output)) {
      for (const item of msg.output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const block of item.content) {
            if (block.type === 'output_text' && Array.isArray(block.annotations)) {
              for (const ann of block.annotations) {
                if (ann.type === 'url_citation' && ann.url) {
                  if (!Object.values(sources).some((s) => s.url === ann.url)) {
                    const key = `oai-${ann.url}`;
                    sources[key] = { url: ann.url, title: ann.title || '' };
                    hasSources = true;
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return hasSources ? sources : undefined;
}

/**
 * Inject citation markers into text content for OpenAI url_citation annotations.
 * Converts OpenAI's positional annotations (start_index/end_index) into
 * Anthropic-compatible <cite> tags so the frontend can render them uniformly.
 *
 * Returns the modified text, or the original text if no annotations found.
 */
function injectOpenAICitationMarkers(
  textContent: string,
  rawMessage: unknown,
  citationSources?: Record<string, { url: string; title: string }> | null,
): string {
  if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) return textContent;
  if (!citationSources) return textContent;

  const msg = rawMessage as any;

  // Collect all url_citation annotations with positions
  interface Annotation { start: number; end: number; url: string }
  const annotations: Annotation[] = [];

  const extractAnnotations = (block: any) => {
    if (block.type === 'output_text' && Array.isArray(block.annotations)) {
      for (const ann of block.annotations) {
        if (ann.type === 'url_citation' && typeof ann.start_index === 'number' && typeof ann.end_index === 'number' && ann.url) {
          annotations.push({ start: ann.start_index, end: ann.end_index, url: ann.url });
        }
      }
    }
  };

  // Check content blocks directly
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) extractAnnotations(block);
  }
  // Check output array
  if (Array.isArray(msg.output)) {
    for (const item of msg.output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const block of item.content) extractAnnotations(block);
      }
    }
  }

  if (annotations.length === 0) return textContent;

  // Sort by start_index descending so we can insert from end without shifting indices
  annotations.sort((a, b) => b.start - a.start);

  // Find the citation source key for each URL
  let result = textContent;
  for (const ann of annotations) {
    const key = Object.entries(citationSources).find(([, v]) => v.url === ann.url)?.[0];
    if (!key || ann.start < 0 || ann.end > result.length) continue;

    const citedText = result.substring(ann.start, ann.end);
    result = result.substring(0, ann.start) + `<cite index="${key}">${citedText}</cite>` + result.substring(ann.end);
  }

  return result;
}
