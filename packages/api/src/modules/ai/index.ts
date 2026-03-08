import type { Actor, Memory, ThinkingResult, ActorAction, AIMessage, ResolvedModelConfig, ContinuationEntry, ServerToolCall } from '@synapse/shared';
import { config } from '../../config/index.js';
import { createAIProvider, type AIProvider, type AIProviderConfig } from './providers/index.js';
import { ACTOR_TOOLS, toolCallsToActions } from './tools.js';
import { buildActorPrompt } from './prompt-builder.js';
import { logAIRequest } from '../model-groups/service.js';
import { isCallableTool, executeCallableTools, getCallableToolDefinitions } from './callable-tools.js';
import { setToolExecutionContext } from './session-tools.js';
import { getMcpVersion } from '../mcp-plugins/instance-manager.js';

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
}

export async function actorThink(
  actor: Actor,
  memories: Memory[],
  workContext: string,
  subordinates?: Subordinate[],
  resolved?: ResolvedModelConfig | null,
  workspaceId?: string,
  options?: {
    sessionId?: string;
    onStatus?: (status: string) => Promise<void>;
    extraTools?: import('@synapse/shared').ToolDefinition[];
    extraToolExecutor?: (toolName: string, input: Record<string, unknown>) => Promise<string>;
    mcpVersion?: number;
    mcpRefresh?: () => Promise<{ tools: import('@synapse/shared').ToolDefinition[]; mcpVersion: number }>;
  },
): Promise<ThinkingResult> {
  const { system, messages } = buildActorPrompt(actor, memories, workContext, subordinates, undefined, options?.extraTools);
  const provider = getProvider(resolved);

  const aiMessages: AIMessage[] = messages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  // Merge action tools + callable tools + MCP extra tools
  const callableToolDefs = getCallableToolDefinitions();
  let extraToolDefs = options?.extraTools || [];
  let extraToolNames = new Set(extraToolDefs.map(t => t.name));
  let allTools = [...ACTOR_TOOLS, ...callableToolDefs, ...extraToolDefs];
  let currentMcpVersion = options?.mcpVersion ?? 0;

  const startTime = Date.now();
  let totalTokens = { input: 0, output: 0 };
  const continuationHistory: ContinuationEntry[] = [];

  // Capture request context for logging (no API key!)
  const requestLog = {
    provider: resolved?.providerType || config.ai.provider,
    model: resolved?.modelName || config.ai.model,
    system: system.slice(0, 2000), // truncate system prompt for storage
    messages: aiMessages,
    tools: allTools.map((t) => t.name),
    builtinTools: resolved?.builtinTools || null,
  };

  // Collect per-round response snapshots
  const roundLogs: unknown[] = [];
  const allToolsUsed: string[] = []; // track callable tools invoked
  const allServerToolCalls: ServerToolCall[] = []; // track cloud-side tool calls
  let allCitationSources: Record<string, { url: string; title: string }> = {}; // cite index → source
  const onStatus = options?.onStatus;

  // Set tool execution context for session-aware callable tools
  if (options?.sessionId) {
    setToolExecutionContext({
      sessionId: options.sessionId,
      actorId: actor.id,
      workspaceId: workspaceId || '',
    });
  }

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await provider.chat({
        system,
        messages: aiMessages,
        tools: allTools,
        builtinTools: resolved?.builtinTools,
        continuationHistory: continuationHistory.length > 0 ? continuationHistory : undefined,
      });

      totalTokens.input += response.tokensUsed.input;
      totalTokens.output += response.tokensUsed.output;

      // Capture this round's response for logging
      roundLogs.push({
        round: round + 1,
        stopReason: response.stopReason,
        toolCalls: response.toolCalls.map((tc) => ({ id: tc.id, name: tc.name })),
        textContent: response.textContent.slice(0, 2000),
        tokens: response.tokensUsed,
        rawContentBlockTypes: Array.isArray(response.rawAssistantMessage)
          ? (response.rawAssistantMessage as any[]).map((b: any) => b.type)
          : undefined,
      });

      console.log(`[actorThink] actor=${actor.id} round=${round + 1} stopReason=${response.stopReason} toolCalls=[${response.toolCalls.map(tc => tc.name).join(',')}] builtinTools=${JSON.stringify(resolved?.builtinTools || null)} textLen=${response.textContent.length}`);

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
      // (Anthropic already includes <cite> tags in the text)
      if (citations && !Array.isArray(response.rawAssistantMessage)) {
        response.textContent = injectOpenAICitationMarkers(response.textContent, response.rawAssistantMessage, citations);
      }

      // Separate tool calls into action tools vs callable/MCP tools
      const actionCalls = response.toolCalls.filter((tc) => !isCallableTool(tc.name) && !extraToolNames.has(tc.name));
      const callableCalls = response.toolCalls.filter((tc) => isCallableTool(tc.name));
      const mcpCalls = response.toolCalls.filter((tc) => extraToolNames.has(tc.name));
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

        // Execute MCP tools via extraToolExecutor
        const mcpResults: import('@synapse/shared').ToolResult[] = [];
        if (mcpCalls.length > 0 && options?.extraToolExecutor) {
          for (const tc of mcpCalls) {
            try {
              const result = await options.extraToolExecutor(tc.name, tc.input);
              mcpResults.push({ toolCallId: tc.id, toolName: tc.name, content: result });
            } catch (err: any) {
              mcpResults.push({ toolCallId: tc.id, toolName: tc.name, content: `Error: ${err.message}`, isError: true });
            }
          }
        }

        const toolResults = [...callableResults, ...mcpResults];
        continuationHistory.push({
          rawAssistantMessage: response.rawAssistantMessage,
          toolResults,
        });

        // If model also produced action calls in the same turn, execute them and finish
        if (actionCalls.length > 0) {
          const actions = toolCallsToActions(actionCalls);
          const hasRespond = actions.some((a) => a.type === 'respond');
          if (!hasRespond && response.textContent) {
            actions.unshift({ type: 'respond', content: response.textContent });
          }

          await logThinkRequest(workspaceId, actor.id, resolved, totalTokens, startTime, requestLog, roundLogs);

          return { actions, reasoning: response.textContent, tokensUsed: totalTokens, toolsUsed: allToolsUsed, serverToolCalls: allServerToolCalls.length > 0 ? allServerToolCalls : undefined, citationSources: Object.keys(allCitationSources).length > 0 ? allCitationSources : undefined };
        }

        // Otherwise continue to next round
        // Dynamic MCP tool refresh between rounds
        if (options?.mcpRefresh && workspaceId) {
          const latestVersion = await getMcpVersion(workspaceId);
          if (latestVersion !== currentMcpVersion) {
            try {
              const refreshed = await options.mcpRefresh();
              extraToolDefs = refreshed.tools;
              extraToolNames = new Set(extraToolDefs.map(t => t.name));
              allTools = [...ACTOR_TOOLS, ...callableToolDefs, ...extraToolDefs];
              currentMcpVersion = refreshed.mcpVersion;
              console.log(`[actorThink] MCP tools refreshed: ${extraToolDefs.length} tools, version=${currentMcpVersion}`);
            } catch (err: any) {
              console.error('[actorThink] MCP refresh failed:', err.message);
            }
          }
        }
        continue;
      }

      // No callable calls — process action calls (terminal) and finish
      let actions: ActorAction[];
      if (actionCalls.length > 0) {
        actions = toolCallsToActions(actionCalls);
        const hasRespond = actions.some((a) => a.type === 'respond');
        if (!hasRespond && response.textContent) {
          actions.unshift({ type: 'respond', content: response.textContent });
        }
      } else if (response.textContent) {
        actions = [{ type: 'respond', content: response.textContent }];
      } else {
        actions = [{ type: 'respond', content: 'I could not process this request.' }];
      }

      await logThinkRequest(workspaceId, actor.id, resolved, totalTokens, startTime, requestLog, roundLogs);

      return { actions, reasoning: response.textContent, tokensUsed: totalTokens, toolsUsed: allToolsUsed.length > 0 ? allToolsUsed : undefined, serverToolCalls: allServerToolCalls.length > 0 ? allServerToolCalls : undefined, citationSources: Object.keys(allCitationSources).length > 0 ? allCitationSources : undefined };
    }

    // Exceeded MAX_TOOL_ROUNDS — fallback respond
    console.warn(`[actorThink] actor=${actor.id} exceeded max tool rounds (${MAX_TOOL_ROUNDS})`);
    await logThinkRequest(workspaceId, actor.id, resolved, totalTokens, startTime, requestLog, roundLogs);

    return {
      actions: [{ type: 'respond', content: 'I ran into complexity processing this request. Please try again with a simpler question.' }],
      reasoning: 'Exceeded maximum tool rounds',
      tokensUsed: totalTokens,
      toolsUsed: allToolsUsed.length > 0 ? allToolsUsed : undefined,
      serverToolCalls: allServerToolCalls.length > 0 ? allServerToolCalls : undefined,
      citationSources: Object.keys(allCitationSources).length > 0 ? allCitationSources : undefined,
    };
  } catch (err: any) {
    // Log the failed request with request/response context
    await logAIRequest({
      workspaceId,
      actorId: actor.id,
      groupId: resolved?.groupId,
      itemId: resolved?.itemId,
      configId: resolved?.configId,
      requestType: 'actor_think',
      inputTokens: totalTokens.input,
      outputTokens: totalTokens.output,
      latencyMs: Date.now() - startTime,
      status: 'error',
      errorMessage: err.message,
      requestBody: requestLog,
      responseBody: roundLogs.length > 0 ? { rounds: roundLogs } : null,
    });
    throw err;
  } finally {
    // Always clear tool execution context
    setToolExecutionContext(null);
  }
}

async function logThinkRequest(
  workspaceId: string | undefined,
  actorId: string,
  resolved: ResolvedModelConfig | null | undefined,
  totalTokens: { input: number; output: number },
  startTime: number,
  requestBody?: unknown,
  responseBody?: unknown[],
): Promise<void> {
  await logAIRequest({
    workspaceId,
    actorId,
    groupId: resolved?.groupId,
    itemId: resolved?.itemId,
    configId: resolved?.configId,
    requestType: 'actor_think',
    inputTokens: totalTokens.input,
    outputTokens: totalTokens.output,
    latencyMs: Date.now() - startTime,
    status: 'success',
    requestBody,
    responseBody: responseBody ? { rounds: responseBody } : null,
  });
}

export async function aiComplete(
  system: string,
  messages: { role: string; content: string }[],
  resolved?: ResolvedModelConfig | null,
  logContext?: { workspaceId?: string; actorId?: string },
): Promise<{ content: string; tokensUsed: { input: number; output: number } }> {
  const provider = getProvider(resolved);

  const aiMessages: AIMessage[] = messages.map((m) => ({
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
    system: system.slice(0, 2000),
    messages: aiMessages,
  };

  try {
    response = await provider.chat({ system, messages: aiMessages });
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
      textContent: response.textContent.slice(0, 2000),
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
