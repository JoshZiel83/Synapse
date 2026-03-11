import type { Actor, ActorSkill, Memory, ThinkingResult, ActorAction, ConversationMessage, ResolvedModelConfig, ServerToolCall, ToolRound, CanonicalToolCall, CanonicalToolResult, AssistantToolHistory, GroupMemberEntry, ToolResolveContext } from '@synapse/shared';
import { randomUUID } from 'crypto';
import { config } from '../../config/index.js';
import { createAIProvider, type AIProvider, type AIProviderConfig } from './providers/index.js';
import { toolCallsToActions } from './tools.js';
import { buildActorPrompt } from './prompt-builder.js';
import { logAIRequest } from '../model-groups/service.js';
import { logToolCall } from '../mcp-plugins/audit.js';
import { resolveBuiltinTools, executeCallableTools, isCallableTool, isActionTool } from './tool-plugins.js';
import { runWithToolContext } from './session-tools.js';
import { getMcpVersion } from '../mcp-plugins/instance-manager.js';
import { adaptAttachments, type Attachment } from './content-adapter.js';
import { ingestToolResultContent, ingestResponseMedia, extractAttachmentsFromBlocks } from './content-ingest.js';

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

interface Subordinate {
  name: string;
  title: string;
  charter: string;
  skills?: ActorSkill[];
}

export async function actorThink(
  actor: Actor,
  memories: Memory[],
  conversationMessages: ConversationMessage[],
  subordinates?: Subordinate[],
  resolved?: ResolvedModelConfig | null,
  workspaceId?: string,
  options?: {
    sessionId?: string;
    groupId?: string;
    groupMembers?: GroupMemberEntry[];
    userId?: string;
    onStatus?: (status: string) => Promise<void>;
    mcpTools?: import('@synapse/shared').ToolDefinition[];
    mcpExecutor?: (toolName: string, input: Record<string, unknown>) => Promise<string | unknown[]>;
    mcpVersion?: number;
    mcpRefresh?: () => Promise<{ tools: import('@synapse/shared').ToolDefinition[]; mcpVersion: number }>;
    mcpSetTurnId?: (turnId: string, round?: number) => void;
    attachments?: Attachment[];
    system: string;
    checkNewMessages?: () => Promise<{ role: string; content: string; metadata?: any }[] | null>;
  },
): Promise<ThinkingResult> {
  const system = options?.system || '';
  const provider = getProvider(resolved);

  // If attachments are present, adapt the last user message to include multimodal content blocks
  let multimodalContent: unknown[] | undefined;
  if (options?.attachments && options.attachments.length > 0 && conversationMessages.length > 0) {
    // Find the last user message
    let lastUserIdx = -1;
    for (let i = conversationMessages.length - 1; i >= 0; i--) {
      if (conversationMessages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx >= 0) {
      const lastUserMsg = conversationMessages[lastUserIdx] as { role: 'user'; content: string };
      const { contentBlocks, textFallback } = await adaptAttachments(
        lastUserMsg.content,
        options.attachments,
        resolved?.multimodal,
        resolved?.providerType || (config.ai.provider as any),
      );
      // If we have multimodal blocks (more than just text), use content blocks
      if (contentBlocks.length > 1) {
        multimodalContent = contentBlocks;
        // Update the text content to include fallback descriptions
        (conversationMessages[lastUserIdx] as any).content = textFallback;
      } else {
        (conversationMessages[lastUserIdx] as any).content = textFallback;
      }
    }
  }

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
  let allTools = [...filteredBuiltin, ...mcpToolDefs];
  let currentMcpVersion = options?.mcpVersion ?? 0;

  const startTime = Date.now();
  const turnId = randomUUID();
  let totalTokens = { input: 0, output: 0 };

  // Capture initial request context for logging (no API key!)
  const initialRequestLog = {
    provider: resolved?.providerType || config.ai.provider,
    model: resolved?.modelName || config.ai.model,
    system,
    messages: conversationMessages,
    tools: allTools,
    builtinTools: resolved?.builtinTools || null,
  };

  const allToolsUsed: string[] = []; // track callable tools invoked
  const allServerToolCalls: ServerToolCall[] = []; // track cloud-side tool calls
  let allCitationSources: Record<string, { url: string; title: string }> = {}; // cite index → source
  const onStatus = options?.onStatus;
  let currentRound = 0; // track for error handler

  // Accumulate canonical ToolRound[] for intra-turn continuation
  const canonicalRounds: ToolRound[] = [];
  // Accumulate media attachments from MCP/model responses
  const allMediaAttachments: Attachment[] = [];

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

  // Helper to log tool calls with current round context
  const logToolCallWithRound = (roundNum: number, tc: { name: string; input: Record<string, unknown> }, toolType: 'callable' | 'action', output?: string, isError?: boolean) => {
    logToolCall({
      workspaceId: workspaceId || '',
      sessionId: options?.sessionId,
      turnId,
      round: roundNum,
      actorId: actor.id,
      pluginId: null,
      toolName: tc.name,
      toolType,
      input: tc.input,
      output,
      isError,
      transport: toolType,
    });
  };

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      currentRound = round + 1;
      const roundStartTime = Date.now();

      // Set turn+round context for MCP executor
      if (options?.mcpSetTurnId) options.mcpSetTurnId(turnId, currentRound);

      const response = await provider.chat({
        system,
        messages: conversationMessages,
        tools: allTools,
        builtinTools: resolved?.builtinTools,
        canonicalRounds: canonicalRounds.length > 0 ? canonicalRounds : undefined,
        multimodalContent: round === 0 ? multimodalContent : undefined,
        multimodal: resolved?.multimodal,
      });

      const roundLatencyMs = Date.now() - roundStartTime;
      totalTokens.input += response.tokensUsed.input;
      totalTokens.output += response.tokensUsed.output;

      // Build per-round request/response bodies
      const roundRequestBody = round === 0
        ? initialRequestLog
        : { round: currentRound, continuationToolResults: canonicalRounds[canonicalRounds.length - 1]?.toolResults };
      const roundResponseBody = {
        stopReason: response.stopReason,
        toolCalls: response.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, input: tc.input })),
        textContent: response.textContent,
        rawAssistantMessage: response.rawAssistantMessage,
      };

      // Log this round's AI request immediately
      logAIRequest({
        ...logCommon,
        round: currentRound,
        inputTokens: response.tokensUsed.input,
        outputTokens: response.tokensUsed.output,
        latencyMs: roundLatencyMs,
        status: 'success',
        requestBody: roundRequestBody,
        responseBody: roundResponseBody,
      }).catch(err => console.error('[actorThink] Failed to log AI request:', err.message));

      console.log(`[actorThink] actor=${actor.id} turn=${turnId.slice(0,8)} round=${currentRound} stopReason=${response.stopReason} toolCalls=[${response.toolCalls.map(tc => tc.name).join(',')}] textLen=${response.textContent.length}`);

      // Ingest response media (Phase 5)
      if (response.mediaBlocks && response.mediaBlocks.length > 0 && workspaceId) {
        try {
          const mediaAtts = await ingestResponseMedia(response.mediaBlocks, resolved?.providerType || 'anthropic', workspaceId);
          allMediaAttachments.push(...mediaAtts);
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
      if (citations && !Array.isArray(response.rawAssistantMessage)) {
        response.textContent = injectOpenAICitationMarkers(response.textContent, response.rawAssistantMessage, citations);
      }

      // Dispatch: three-bucket separation
      const actionCalls   = response.toolCalls.filter(tc => isActionTool(tc.name));
      const callableCalls = response.toolCalls.filter(tc => isCallableTool(tc.name));
      const mcpCalls      = response.toolCalls.filter(tc => mcpToolNames.has(tc.name));
      const allContinuableCalls = [...callableCalls, ...mcpCalls];

      if (allContinuableCalls.length > 0) {
        // Track tool names and emit status
        const toolNames = allContinuableCalls.map((tc) => tc.name);
        allToolsUsed.push(...toolNames);
        if (onStatus) {
          await onStatus(`Calling ${toolNames.join(', ')}...`);
        }

        // Execute callable tools (builtin registry)
        const callableResults = callableCalls.length > 0 ? await executeCallableTools(callableCalls) : [];

        // Execute MCP tools via mcpExecutor, with content ingestion
        const mcpResults: import('@synapse/shared').ToolResult[] = [];
        if (mcpCalls.length > 0 && options?.mcpExecutor) {
          for (const tc of mcpCalls) {
            try {
              const rawResult = await options.mcpExecutor(tc.name, tc.input);
              // Ingest MCP result content into platform file storage
              if (workspaceId && typeof rawResult !== 'string') {
                const normalizedContent = await ingestToolResultContent(rawResult, workspaceId);
                mcpResults.push({ toolCallId: tc.id, toolName: tc.name, content: normalizedContent });
                // Extract file_ref attachments for metadata
                if (Array.isArray(normalizedContent)) {
                  const atts = extractAttachmentsFromBlocks(normalizedContent);
                  allMediaAttachments.push(...atts);
                }
              } else {
                mcpResults.push({ toolCallId: tc.id, toolName: tc.name, content: rawResult });
              }
            } catch (err: any) {
              mcpResults.push({ toolCallId: tc.id, toolName: tc.name, content: `Error: ${err.message}`, isError: true });
            }
          }
        }

        const toolResults = [...callableResults, ...mcpResults];

        // Accumulate canonical ToolRound
        const roundToolCalls: CanonicalToolCall[] = allContinuableCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: tc.input,
        }));
        const roundToolResults: CanonicalToolResult[] = toolResults.map((tr) => ({
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          content: tr.content as string | import('@synapse/shared').CanonicalContentBlock[],
          isError: tr.isError,
        }));
        canonicalRounds.push({
          textContent: response.textContent || undefined,
          toolCalls: roundToolCalls,
          toolResults: roundToolResults,
        });

        // Log each callable tool call individually
        for (let ci = 0; ci < callableCalls.length; ci++) {
          const tc = callableCalls[ci];
          const res = callableResults[ci];
          logToolCallWithRound(currentRound, tc, 'callable',
            typeof res?.content === 'string' ? res.content : res?.content ? JSON.stringify(res.content) : undefined,
            res?.isError);
        }

        // If model also produced action calls in the same turn, execute them and finish
        if (actionCalls.length > 0) {
          const actions = toolCallsToActions(actionCalls);

          for (const tc of actionCalls) {
            logToolCallWithRound(currentRound, tc, 'action', JSON.stringify(tc.input));
          }

          const toolHistory: AssistantToolHistory | undefined = canonicalRounds.length > 0 ? { rounds: canonicalRounds } : undefined;
          return {
            actions,
            reasoning: response.textContent,
            tokensUsed: totalTokens,
            toolsUsed: allToolsUsed,
            serverToolCalls: allServerToolCalls.length > 0 ? allServerToolCalls : undefined,
            citationSources: Object.keys(allCitationSources).length > 0 ? allCitationSources : undefined,
            toolHistory,
            mediaAttachments: allMediaAttachments.length > 0 ? allMediaAttachments : undefined,
          };
        }

        // If 'sleep' callable tool was called, the session is now sleeping — stop the loop
        const sleepCalled = callableCalls.some((tc: any) => tc.name === 'sleep');
        if (sleepCalled) {
          const actions: ActorAction[] = [];
          const toolHistory: AssistantToolHistory | undefined = canonicalRounds.length > 0 ? { rounds: canonicalRounds } : undefined;
          return {
            actions,
            reasoning: response.textContent,
            tokensUsed: totalTokens,
            toolsUsed: allToolsUsed.length > 0 ? allToolsUsed : undefined,
            serverToolCalls: allServerToolCalls.length > 0 ? allServerToolCalls : undefined,
            citationSources: Object.keys(allCitationSources).length > 0 ? allCitationSources : undefined,
            toolHistory,
            mediaAttachments: allMediaAttachments.length > 0 ? allMediaAttachments : undefined,
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
              for (const msg of newMsgs) {
                conversationMessages.push({
                  role: 'user',
                  content: `[新消息] ${msg.content}`,
                });
              }
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
        actions = toolCallsToActions(actionCalls);

        for (const tc of actionCalls) {
          logToolCallWithRound(currentRound, tc, 'action', JSON.stringify(tc.input));
        }
      } else if (response.textContent) {
        // Pure text with no tool calls = reasoning only. No visible group message.
        // send_to handles all visible messaging; text here is saved as session_message for audit.
        actions = [];
      } else if (allToolsUsed.length > 0) {
        // Actor used callable tools (e.g. send_to) in earlier rounds but has nothing to say now.
        // Don't generate a fallback — the actor communicated via tools. Worker will auto-sleep.
        actions = [];
      } else {
        actions = [{ type: 'respond', content: 'I could not process this request.' }];
      }

      const toolHistory: AssistantToolHistory | undefined = canonicalRounds.length > 0 ? { rounds: canonicalRounds } : undefined;
      return {
        actions,
        reasoning: response.textContent,
        tokensUsed: totalTokens,
        toolsUsed: allToolsUsed.length > 0 ? allToolsUsed : undefined,
        serverToolCalls: allServerToolCalls.length > 0 ? allServerToolCalls : undefined,
        citationSources: Object.keys(allCitationSources).length > 0 ? allCitationSources : undefined,
        toolHistory,
        mediaAttachments: allMediaAttachments.length > 0 ? allMediaAttachments : undefined,
      };
    }

    // Exceeded MAX_TOOL_ROUNDS — fallback respond
    console.warn(`[actorThink] actor=${actor.id} exceeded max tool rounds (${MAX_TOOL_ROUNDS})`);

    return {
      actions: [{ type: 'respond', content: 'I ran into complexity processing this request. Please try again with a simpler question.' }],
      reasoning: 'Exceeded maximum tool rounds',
      tokensUsed: totalTokens,
      toolsUsed: allToolsUsed.length > 0 ? allToolsUsed : undefined,
      serverToolCalls: allServerToolCalls.length > 0 ? allServerToolCalls : undefined,
      citationSources: Object.keys(allCitationSources).length > 0 ? allCitationSources : undefined,
      toolHistory: canonicalRounds.length > 0 ? { rounds: canonicalRounds } : undefined,
      mediaAttachments: allMediaAttachments.length > 0 ? allMediaAttachments : undefined,
    };
  } catch (err: any) {
    // Log the failed round
    await logAIRequest({
      ...logCommon,
      round: currentRound,
      inputTokens: totalTokens.input,
      outputTokens: totalTokens.output,
      latencyMs: Date.now() - startTime,
      status: 'error',
      errorMessage: err.message,
      requestBody: currentRound <= 1 ? initialRequestLog : { round: currentRound },
    });
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

  // Convert to ConversationMessage[] for the unified interface
  const convMessages: ConversationMessage[] = messages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  const startTime = Date.now();
  let status = 'success';
  let errorMessage: string | undefined;
  let response;

  const requestLog = {
    provider: resolved?.providerType || config.ai.provider,
    model: resolved?.modelName || config.ai.model,
    system,
    messages: convMessages,
  };

  try {
    response = await provider.chat({ system, messages: convMessages });
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
      textContent: response.textContent,
      tokens: response.tokensUsed,
    },
  });

  return {
    content: response.textContent,
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
