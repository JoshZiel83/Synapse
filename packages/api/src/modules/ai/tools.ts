import type { ToolDefinition, ToolCall, ActorAction } from '@synapse/shared';

export const ACTOR_TOOLS: ToolDefinition[] = [
  {
    name: 'respond',
    description: 'Send a reply to the Boss or the requesting actor. Use this to communicate your answer.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The message to send back' },
      },
      required: ['content'],
    },
  },
  {
    name: 'delegate',
    description: 'Delegate a task to a subordinate actor. Use when a specialist should handle the work.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Description of the task to delegate' },
        targetActorId: { type: 'string', description: 'The UUID of the subordinate actor to delegate to' },
      },
      required: ['content', 'targetActorId'],
    },
  },
  {
    name: 'complete',
    description: 'Mark the current work item as completed with a result summary.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Completion summary / result' },
      },
      required: ['content'],
    },
  },
  {
    name: 'escalate',
    description: 'Escalate an issue to a superior when you cannot handle it yourself.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Description of the issue and why it needs escalation' },
      },
      required: ['content'],
    },
  },
  {
    name: 'request_info',
    description: 'Request additional information from the Boss or another actor before proceeding.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The question or information request' },
      },
      required: ['content'],
    },
  },
  {
    name: 'update_progress',
    description: 'Send a progress update on the current work item.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Progress update message' },
      },
      required: ['content'],
    },
  },
  {
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
  {
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
  {
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
];

export function toolCallsToActions(toolCalls: ToolCall[]): ActorAction[] {
  return toolCalls.map((tc) => {
    const input = tc.input as Record<string, any>;

    switch (tc.name) {
      case 'respond':
        return { type: 'respond' as const, content: input.content };

      case 'delegate':
        return {
          type: 'delegate' as const,
          content: input.content,
          targetActorId: input.targetActorId,
        };

      case 'complete':
        return { type: 'complete' as const, content: input.content };

      case 'escalate':
        return { type: 'escalate' as const, content: input.content };

      case 'request_info':
        return { type: 'request_info' as const, content: input.content };

      case 'update_progress':
        return { type: 'update_progress' as const, content: input.content };

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
