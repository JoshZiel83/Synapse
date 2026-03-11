import type { ToolCall, ActorAction } from '@synapse/shared';
import { registerToolPlugin } from './tool-plugins.js';

/**
 * Register action tool plugins.
 * Action tools are terminal — their results are dispatched by the orchestrator,
 * not returned to the model for further reasoning.
 */
export function registerActionToolPlugins(): void {
  registerToolPlugin({
    name: 'create_memory',
    kind: 'action',
    definition: {
      name: 'create_memory',
      description: 'Store an important piece of information for long-term recall. Use when the Boss shares preferences, names, decisions, or any fact worth remembering across conversations.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The information to remember' },
          category: {
            type: 'string',
            description: 'Memory category',
            enum: ['working', 'experiential', 'knowledge', 'procedural', 'relational'],
          },
          scope: {
            type: 'string',
            description: 'Visibility scope of the memory',
            enum: ['private', 'team', 'workspace'],
          },
          importance: {
            type: 'string',
            description: 'Importance score from 0.0 to 1.0',
          },
          tags: {
            type: 'string',
            description: 'Comma-separated tags for this memory',
          },
        },
        required: ['content', 'category'],
      },
    },
  });

  registerToolPlugin({
    name: 'rename_self',
    kind: 'action',
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
  });

  registerToolPlugin({
    name: 'change_avatar',
    kind: 'action',
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
  });
}

export function toolCallsToActions(toolCalls: ToolCall[]): ActorAction[] {
  return toolCalls.map((tc) => {
    const input = tc.input as Record<string, any>;

    switch (tc.name) {
      case 'create_memory': {
        const tags = input.tags
          ? String(input.tags).split(',').map((t: string) => t.trim()).filter(Boolean)
          : [];
        return {
          type: 'create_memory' as const,
          content: input.content,
          metadata: {
            category: input.category || 'knowledge',
            scope: input.scope || 'private',
            importance: parseFloat(input.importance) || 0.5,
            tags,
          },
        };
      }

      case 'rename_self':
        return {
          type: 'rename_self' as const,
          content: input.newName,
        };

      case 'change_avatar':
        return {
          type: 'change_avatar' as const,
          content: input.emoji,
        };

      default:
        return { type: 'respond' as const, content: `Unknown tool: ${tc.name}` };
    }
  });
}
