import type { ToolCall, ActorAction } from '@synapse/shared';
import { z } from 'zod';
import { registerToolPlugin } from './tool-plugins.js';
import { throwToolError } from './tool-errors.js';
import { executeActorActions } from '../orchestrator/service.js';
import { getToolExecutionContext } from './session-tools.js';
import { getActor } from '../organization/service.js';

const HEX_COLOR_PATTERN = '^[0-9a-fA-F]{6}$';
const ACCESSORIES_PATTERN = '^variant0[1-4]$';
const CLOTHING_PATTERN = '^variant(0[1-9]|1[0-9]|2[0-3])$';
const EYES_PATTERN = '^variant(0[1-9]|1[0-2])$';
const GLASSES_PATTERN = '^(dark|light)0[1-7]$';
const BEARD_PATTERN = '^variant0[1-8]$';
const MOUTH_PATTERN = '^(happy(0[1-9]|1[0-3])|sad(0[1-9]|10))$';
const HAIR_PATTERN = '^(short(0[1-9]|1[0-9]|2[0-4])|long(0[1-9]|1[0-9]|2[0-1]))$';
const HAT_PATTERN = '^variant(0[1-9]|10)$';
const PIXEL_ART_MODE = 'pixel_art' as const;
const EMOJI_MODE = 'emoji' as const;
const PIXEL_ART_HINT =
  'Use mode="pixel_art" to generate a transparent DiceBear pixel-art SVG. ' +
  'Same seed + same parameters will generate the same avatar.';
const PIXEL_ART_FIELD_NAMES = new Set([
  'seed',
  'accessories',
  'accessoriesProbability',
  'clothing',
  'eyes',
  'glasses',
  'glassesProbability',
  'beard',
  'beardProbability',
  'mouth',
  'hair',
  'hat',
  'hatProbability',
  'accessoriesColor',
  'clothingColor',
  'eyesColor',
  'glassesColor',
  'hairColor',
  'hatColor',
  'mouthColor',
  'skinColor',
]);

function isLikelyEmojiAvatar(value: string) {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 16 &&
    !/\s/.test(trimmed) &&
    /[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u.test(trimmed)
  );
}

const emojiAvatarSchema = z.string()
  .trim()
  .min(1)
  .max(16)
  .refine(isLikelyEmojiAvatar, 'Use a single emoji or short emoji sequence.');

const pixelArtAvatarOptionsSchema = z.object({
  seed: z.string().trim().min(1).max(80).optional(),
  accessories: z.string().trim().regex(new RegExp(ACCESSORIES_PATTERN)).optional(),
  accessoriesProbability: z.coerce.number().int().min(0).max(100).optional(),
  clothing: z.string().trim().regex(new RegExp(CLOTHING_PATTERN)).optional(),
  eyes: z.string().trim().regex(new RegExp(EYES_PATTERN)).optional(),
  glasses: z.string().trim().regex(new RegExp(GLASSES_PATTERN)).optional(),
  glassesProbability: z.coerce.number().int().min(0).max(100).optional(),
  beard: z.string().trim().regex(new RegExp(BEARD_PATTERN)).optional(),
  beardProbability: z.coerce.number().int().min(0).max(100).optional(),
  mouth: z.string().trim().regex(new RegExp(MOUTH_PATTERN)).optional(),
  hair: z.string().trim().regex(new RegExp(HAIR_PATTERN)).optional(),
  hat: z.string().trim().regex(new RegExp(HAT_PATTERN)).optional(),
  hatProbability: z.coerce.number().int().min(0).max(100).optional(),
  accessoriesColor: z.string().trim().regex(new RegExp(HEX_COLOR_PATTERN)).optional(),
  clothingColor: z.string().trim().regex(new RegExp(HEX_COLOR_PATTERN)).optional(),
  eyesColor: z.string().trim().regex(new RegExp(HEX_COLOR_PATTERN)).optional(),
  glassesColor: z.string().trim().regex(new RegExp(HEX_COLOR_PATTERN)).optional(),
  hairColor: z.string().trim().regex(new RegExp(HEX_COLOR_PATTERN)).optional(),
  hatColor: z.string().trim().regex(new RegExp(HEX_COLOR_PATTERN)).optional(),
  mouthColor: z.string().trim().regex(new RegExp(HEX_COLOR_PATTERN)).optional(),
  skinColor: z.string().trim().regex(new RegExp(HEX_COLOR_PATTERN)).optional(),
}).strict();

const changeAvatarToolInputSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal(EMOJI_MODE),
    emoji: emojiAvatarSchema,
  }).strict(),
  z.object({
    mode: z.literal(PIXEL_ART_MODE),
    ...pixelArtAvatarOptionsSchema.shape,
  }).strict(),
]);

type ChangeAvatarToolInput = z.infer<typeof changeAvatarToolInputSchema>;

function normalizeRawChangeAvatarInput(input: Record<string, unknown>) {
  if (input.mode === EMOJI_MODE || input.mode === PIXEL_ART_MODE) {
    return input;
  }

  if (typeof input.emoji === 'string' && input.emoji.trim()) {
    return {
      ...input,
      mode: EMOJI_MODE,
    };
  }

  for (const fieldName of PIXEL_ART_FIELD_NAMES) {
    if (input[fieldName] !== undefined) {
      return {
        ...input,
        mode: PIXEL_ART_MODE,
      };
    }
  }

  return input;
}

function parseChangeAvatarToolInput(input: Record<string, unknown>) {
  return changeAvatarToolInputSchema.safeParse(
    normalizeRawChangeAvatarInput(input),
  );
}

function buildCreateMemoryAction(input: Record<string, any>): ActorAction {
  const tags = input.tags
    ? String(input.tags).split(',').map((t: string) => t.trim()).filter(Boolean)
    : [];
  return {
    type: 'create_memory' as const,
    content: input.content,
    metadata: {
      category: input.category || 'fact',
      scope: input.scope || 'actor_in_conversation',
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

function buildChangeAvatarAction(input: ChangeAvatarToolInput): ActorAction {
  if (input.mode === EMOJI_MODE) {
    return {
      type: 'change_avatar' as const,
      content: input.emoji,
      metadata: {
        avatarMode: EMOJI_MODE,
        emoji: input.emoji,
      },
    };
  }

  const { mode, ...pixelArt } = input;
  return {
    type: 'change_avatar' as const,
    content: input.seed || PIXEL_ART_MODE,
    metadata: {
      avatarMode: mode,
      pixelArt,
    },
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
            description: 'Memory owner scope. actor_in_conversation = private to you inside the current conversation; conversation = shared within the current conversation; actor_global = follows you across conversations.',
            enum: ['actor_in_conversation', 'conversation', 'actor_global'],
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
        throwToolError('No session context available');
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
        throwToolError('No session context available');
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
      description:
        'Change your own avatar. ' +
        'Supports emoji avatars and DiceBear pixel-art transparent SVG avatars. ' +
        'Prefer pixel_art when the request is for a proper portrait, profile picture, or visual refresh. ' +
        'Prefer emoji only for lightweight symbolic avatars.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: [EMOJI_MODE, PIXEL_ART_MODE],
            description:
              `Avatar mode. ${EMOJI_MODE} = switch to an emoji avatar. ` +
              `${PIXEL_ART_MODE} = generate a transparent DiceBear pixel-art SVG avatar file. ` +
              `Do not send both emoji and pixel-art parameters for the same request.`,
          },
          emoji: {
            type: 'string',
            description:
              `Required when mode="${EMOJI_MODE}". Use one emoji or a short emoji sequence, for example 🤖, 🧠, 💼, 🦊.`,
          },
          seed: {
            type: 'string',
            description:
              `Optional when mode="${PIXEL_ART_MODE}". Stable seed for deterministic generation. ` +
              `Use when the Boss wants a repeatable look. ${PIXEL_ART_HINT}`,
          },
          accessories: {
            type: 'string',
            description: 'Optional pixel-art accessory variant. Allowed: variant01 to variant04.',
          },
          accessoriesProbability: {
            type: 'integer',
            description: 'Optional pixel-art accessory probability from 0 to 100.',
          },
          clothing: {
            type: 'string',
            description: 'Optional pixel-art clothing variant. Allowed: variant01 to variant23.',
          },
          clothingColor: {
            type: 'string',
            description: 'Optional clothing color as 6-digit hex without #, for example 428bca.',
          },
          eyes: {
            type: 'string',
            description: 'Optional eye variant. Allowed: variant01 to variant12.',
          },
          eyesColor: {
            type: 'string',
            description: 'Optional eye color as 6-digit hex without #.',
          },
          glasses: {
            type: 'string',
            description: 'Optional glasses variant. Allowed: dark01 to dark07, or light01 to light07.',
          },
          glassesColor: {
            type: 'string',
            description: 'Optional glasses color as 6-digit hex without #.',
          },
          glassesProbability: {
            type: 'integer',
            description: 'Optional glasses probability from 0 to 100.',
          },
          beard: {
            type: 'string',
            description: 'Optional beard variant. Allowed: variant01 to variant08.',
          },
          beardProbability: {
            type: 'integer',
            description: 'Optional beard probability from 0 to 100.',
          },
          mouth: {
            type: 'string',
            description: 'Optional mouth variant. Allowed: happy01 to happy13, or sad01 to sad10.',
          },
          mouthColor: {
            type: 'string',
            description: 'Optional mouth color as 6-digit hex without #.',
          },
          hair: {
            type: 'string',
            description: 'Optional hair variant. Allowed: short01 to short24, or long01 to long21.',
          },
          hairColor: {
            type: 'string',
            description: 'Optional hair color as 6-digit hex without #.',
          },
          hat: {
            type: 'string',
            description: 'Optional hat variant. Allowed: variant01 to variant10.',
          },
          hatColor: {
            type: 'string',
            description: 'Optional hat color as 6-digit hex without #.',
          },
          hatProbability: {
            type: 'integer',
            description: 'Optional hat probability from 0 to 100.',
          },
          skinColor: {
            type: 'string',
            description:
              'Optional skin color as 6-digit hex without #. Pick natural, readable colors unless the Boss explicitly asks for something stylized.',
          },
        },
        required: ['mode'],
      },
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        throwToolError('No session context available');
      }

      const parsed = parseChangeAvatarToolInput(input as Record<string, unknown>);
      if (!parsed.success) {
        throwToolError('Invalid change_avatar input', {
          details: parsed.error.flatten(),
          extra: {
            guidance:
              `Use mode="${EMOJI_MODE}" with one emoji, or mode="${PIXEL_ART_MODE}" with optional DiceBear pixel-art parameters. ` +
              `For pixel_art, only use allowed variant names, 6-digit hex colors without #, and probabilities from 0 to 100.`,
          },
        });
      }

      const action = buildChangeAvatarAction(parsed.data);
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

      const actor = await getActor(context.actorId, context.workspaceId);

      if (parsed.data.mode === EMOJI_MODE) {
        return JSON.stringify({
          success: true,
          avatarMode: EMOJI_MODE,
          emoji: parsed.data.emoji,
          avatarFileId: actor?.definition.avatarFileId || null,
          message: `Your avatar now uses the emoji ${parsed.data.emoji}.`,
        });
      }

      return JSON.stringify({
        success: true,
        avatarMode: PIXEL_ART_MODE,
        avatarFileId: actor?.definition.avatarFileId || null,
        avatarUrl: actor?.avatarUrl || null,
        message: 'Your avatar now uses a generated pixel-art portrait.',
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

      case 'change_avatar': {
        const parsed = parseChangeAvatarToolInput(input);
        return buildChangeAvatarAction(
          parsed.success
            ? parsed.data
            : {
                mode: EMOJI_MODE,
                emoji:
                  typeof input.emoji === 'string' && input.emoji.trim()
                    ? input.emoji.trim()
                    : '🙂',
              },
        );
      }

      default:
        return { type: 'respond' as const, content: `Unknown tool: ${tc.toolName}` };
    }
  });
}
