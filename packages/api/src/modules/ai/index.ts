import type { Actor, Memory, ThinkingResult, ActorAction, AIMessage, ResolvedModelConfig, ContinuationEntry } from '@synapse/shared';
import { config } from '../../config/index.js';
import { createAIProvider, type AIProvider, type AIProviderConfig } from './providers/index.js';
import { ACTOR_TOOLS, toolCallsToActions } from './tools.js';
import { buildActorPrompt } from './prompt-builder.js';
import { logAIRequest } from '../model-groups/service.js';
import { isCallableTool, executeCallableTools, getCallableToolDefinitions } from './callable-tools.js';

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
): Promise<ThinkingResult> {
  const { system, messages } = buildActorPrompt(actor, memories, workContext, subordinates);
  const provider = getProvider(resolved);

  const aiMessages: AIMessage[] = messages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  // Merge action tools + callable tools
  const callableToolDefs = getCallableToolDefinitions();
  const allTools = [...ACTOR_TOOLS, ...callableToolDefs];

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

      // Separate tool calls into action tools vs callable tools
      const actionCalls = response.toolCalls.filter((tc) => !isCallableTool(tc.name));
      const callableCalls = response.toolCalls.filter((tc) => isCallableTool(tc.name));

      if (callableCalls.length > 0) {
        // Execute callable tools and collect results
        const toolResults = await executeCallableTools(callableCalls);
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

          return { actions, reasoning: response.textContent, tokensUsed: totalTokens };
        }

        // Otherwise continue to next round
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

      return { actions, reasoning: response.textContent, tokensUsed: totalTokens };
    }

    // Exceeded MAX_TOOL_ROUNDS — fallback respond
    console.warn(`[actorThink] actor=${actor.id} exceeded max tool rounds (${MAX_TOOL_ROUNDS})`);
    await logThinkRequest(workspaceId, actor.id, resolved, totalTokens, startTime, requestLog, roundLogs);

    return {
      actions: [{ type: 'respond', content: 'I ran into complexity processing this request. Please try again with a simpler question.' }],
      reasoning: 'Exceeded maximum tool rounds',
      tokensUsed: totalTokens,
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
