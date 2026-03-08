import type { Actor, Memory, ToolDefinition } from '@synapse/shared';

interface Subordinate {
  name: string;
  title: string;
  charter: string;
}

export interface SessionContext {
  sessionId: string;
  isResume: boolean;
  childResults?: { actorName: string; result: string }[];
  channelType: string;
  depth: number;
  parentActorName?: string;
}

export function buildActorPrompt(
  actor: Actor,
  memories: Memory[],
  workContext: string,
  subordinates?: Subordinate[],
  sessionContext?: SessionContext,
  extraTools?: ToolDefinition[],
): { system: string; messages: { role: string; content: string }[] } {
  let system =
    actor.systemPrompt +
    '\n\nYour charter:\n' +
    actor.charter +
    '\n\nRelevant memories:\n' +
    memories.map((m) => `- [${m.category}] ${m.content}`).join('\n');

  if (subordinates && subordinates.length > 0) {
    system +=
      '\n\nYour team:\n' +
      subordinates
        .map((s) => `- ${s.name} (${s.title}): ${s.charter.substring(0, 200)}`)
        .join('\n');

    system +=
      '\n\nDelegation instructions:\n' +
      'To delegate tasks, use the "delegate" tool (which returns a sessionId), then use the "wait" tool with all sessionIds to pause until results come back. ' +
      'You can call delegate multiple times before calling wait once with all sessionIds.';
  } else {
    system +=
      '\n\nYou currently have no subordinates. You MUST handle all tasks yourself directly. ' +
      'Provide complete, thorough responses. Do NOT say you will do something later — do it now in your response. ' +
      'Always include the full content in your respond tool call.';
  }

  // Add session context
  if (sessionContext) {
    if (sessionContext.channelType === 'internal_delegation' && sessionContext.parentActorName) {
      system += `\n\n[会话上下文] 这是一个委派任务。你的上级 ${sessionContext.parentActorName} 委派了这个任务给你。完成后请使用 complete 工具报告结果。`;
    }
    if (sessionContext.depth > 0) {
      system += `\n[委派深度] 当前深度: ${sessionContext.depth}。避免无限委派。`;
    }
    if (sessionContext.isResume) {
      system += '\n\n[恢复通知] 你之前等待的子任务已完成。请查看子任务结果并继续处理。';
    }
  }

  // Add MCP plugin tools section
  if (extraTools && extraTools.length > 0) {
    system += '\n\n[可用插件工具]\n你有以下额外的MCP插件工具可以使用:\n';
    for (const tool of extraTools) {
      system += `- ${tool.name}: ${tool.description}\n`;
    }
    system += '\n当用户的请求需要使用这些工具时，请主动调用它们。工具名称使用命名空间格式（组织__插件__工具名）。';
  }

  const messages = [{ role: 'user', content: workContext }];

  return { system, messages };
}
