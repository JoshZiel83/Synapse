import type { ToolCall, ActorAction } from '@synapse/shared';
import { registerToolPlugin } from './tool-plugins.js';
import { executeActorActions } from '../orchestrator/service.js';
import { getToolExecutionContext } from './session-tools.js';

function buildCreateMemoryAction(input: Record<string, any>): ActorAction {
  const tags = input.tags
    ? String(input.tags).split(',').map((t: string) => t.trim()).filter(Boolean)
    : [];
  return {
    type: 'create_memory' as const,
    content: input.content,
    metadata: {
      category: input.category || 'fact',
      scope: input.scope || 'actor_conversation',
      importance: parseFloat(input.importance) || 0.5,
      confidence: parseFloat(input.confidence) || 0.8,
      stability: input.stability || 'durable',
      textDigest: input.textDigest || undefined,
      tags,
    },
  };
}

function buildRenameSelfAction(input: Record<string, any>): ActorAction {
  return {
    type: 'rename_self' as const,
    content: input.newName,
  };
}

function buildChangeAvatarAction(input: Record<string, any>): ActorAction {
  return {
    type: 'change_avatar' as const,
    content: input.emoji,
  };
}

/**
 * Register action tool plugins.
 * These state-mutating built-in tools are callable so the model receives the
 * result and can continue reasoning before it explicitly sleeps.
 */
export function registerActionToolPlugins(): void {
  registerToolPlugin({
    name: 'create_memory',
    kind: 'callable',
    definition: {
      name: 'create_memory',
      description: 'Store a stable, established fact for future recall. Use only for durable facts, preferences, decisions, relationships, procedures, or artifacts that should persist beyond the current turn.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The information to remember. May include exact FileRef strings like <FileRef id="..."/>. If you include a FileRef, also include concise natural-language context so the memory can be recalled later.',
          },
          category: {
            type: 'string',
            description: 'Memory category',
            enum: ['fact', 'preference', 'decision', 'relationship', 'procedure', 'artifact', 'summary'],
          },
          scope: {
            type: 'string',
            description: 'Memory owner scope. actor_conversation = private to you inside the current conversation; conversation = shared within the current conversation; actor_global = follows you across conversations.',
            enum: ['actor_conversation', 'conversation', 'actor_global'],
          },
          importance: {
            type: 'string',
            description: 'Importance score from 0.0 to 1.0',
          },
          confidence: {
            type: 'string',
            description: 'Confidence score from 0.0 to 1.0. Use high confidence only for established facts.',
          },
          stability: {
            type: 'string',
            description: 'Whether this memory is ephemeral or durable.',
            enum: ['ephemeral', 'durable'],
          },
          textDigest: {
            type: 'string',
            description: 'Optional one-line digest of the memory for faster future retrieval. Strongly recommended when content includes a FileRef.',
          },
          tags: {
            type: 'string',
            description: 'Comma-separated tags for this memory',
          },
        },
        required: ['content', 'category'],
      },
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        return JSON.stringify({ error: 'No session context available' });
      }

      const action = buildCreateMemoryAction(input as Record<string, any>);
      await executeActorActions(
        context.workspaceId,
        context.actorId,
        [action],
        {
          sessionId: context.sessionId,
          turnId: context.turnId,
          userId: context.userId,
          conversationId: context.conversationId,
        },
      );

      return JSON.stringify({
        success: true,
        message: 'Memory saved.',
        scope: action.metadata?.scope,
        category: action.metadata?.category,
      });
    },
  });

  registerToolPlugin({
    name: 'rename_self',
    kind: 'callable',
    definition: {
      name: 'rename_self',
      description: 'Change your own display name. Use when the Boss asks you to change your name or gives you a new name.',
      parameters: {
        type: 'object',
        properties: {
          newName: { type: 'string', description: 'The new name to use' },
        },
        required: ['newName'],
      },
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        return JSON.stringify({ error: 'No session context available' });
      }

      const action = buildRenameSelfAction(input as Record<string, any>);
      await executeActorActions(
        context.workspaceId,
        context.actorId,
        [action],
        {
          sessionId: context.sessionId,
          turnId: context.turnId,
          userId: context.userId,
          conversationId: context.conversationId,
        },
      );

      return JSON.stringify({
        success: true,
        newName: action.content,
        message: `Your display name is now ${action.content}.`,
      });
    },
  });

  registerToolPlugin({
    name: 'change_avatar',
    kind: 'callable',
    definition: {
      name: 'change_avatar',
      description: 'Change your own avatar. Use when the Boss asks you to change your avatar or profile picture. Provide an emoji that represents your new look.',
      parameters: {
        type: 'object',
        properties: {
          emoji: { type: 'string', description: 'A single emoji character to use as avatar (e.g. 🤖, 🧠, 💼, 🦊)' },
        },
        required: ['emoji'],
      },
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        return JSON.stringify({ error: 'No session context available' });
      }

      const action = buildChangeAvatarAction(input as Record<string, any>);
      await executeActorActions(
        context.workspaceId,
        context.actorId,
        [action],
        {
          sessionId: context.sessionId,
          turnId: context.turnId,
          userId: context.userId,
          conversationId: context.conversationId,
        },
      );

      return JSON.stringify({
        success: true,
        emoji: action.content,
        message: `Your avatar emoji is now ${action.content}.`,
      });
    },
  });
}

export function toolCallsToActions(toolCalls: ToolCall[]): ActorAction[] {
  return toolCalls.map((tc) => {
    const input = tc.input as Record<string, any>;

    switch (tc.toolName) {
      case 'create_memory':
        return buildCreateMemoryAction(input);

      case 'rename_self':
        return buildRenameSelfAction(input);

      case 'change_avatar':
        return buildChangeAvatarAction(input);

      default:
        return { type: 'respond' as const, content: `Unknown tool: ${tc.toolName}` };
    }
  });
}
