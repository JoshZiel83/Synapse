/**
 * Message Converter: ConversationMessage[] → provider-native message arrays.
 * Async because file_ref blocks need disk reads for resolution.
 */
import type { ConversationMessage, MultimodalConfig, CanonicalContentBlock } from '@synapse/shared';
import { resolveContentBlocks } from './content-resolve.js';

/**
 * Convert ConversationMessage[] to Anthropic Messages API format.
 * Handles role alternation requirements and tool_use/tool_result blocks.
 */
export async function convertToAnthropicMessages(
  messages: ConversationMessage[],
  multimodal?: MultimodalConfig,
): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case 'user':
        appendOrMerge(result, 'user', msg.content);
        break;

      case 'assistant': {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          // Build content blocks: text + tool_use blocks
          const contentBlocks: unknown[] = [];
          if (msg.content) {
            contentBlocks.push({ type: 'text', text: msg.content });
          }
          for (const tc of msg.toolCalls) {
            contentBlocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.input,
            });
          }
          appendOrMerge(result, 'assistant', contentBlocks);
        } else {
          appendOrMerge(result, 'assistant', msg.content);
        }
        break;
      }

      case 'tool_result': {
        // Tool results go in a user message with tool_result content blocks
        const toolResultBlocks: unknown[] = [];
        for (const tr of msg.results) {
          let content: unknown;
          if (typeof tr.content === 'string') {
            content = tr.content;
          } else {
            // CanonicalContentBlock[] — resolve to provider format
            const { providerBlocks } = await resolveContentBlocks(
              tr.content as CanonicalContentBlock[],
              'anthropic',
              multimodal,
            );
            content = providerBlocks;
          }
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: tr.toolCallId,
            content,
            is_error: tr.isError || false,
          });
        }
        appendOrMerge(result, 'user', toolResultBlocks);
        break;
      }
    }
  }

  return result;
}

/**
 * Convert ConversationMessage[] to OpenAI Chat Completions API format.
 * System message is prepended.
 */
export async function convertToOpenAIMessages(
  messages: ConversationMessage[],
  systemPrompt: string,
  multimodal?: MultimodalConfig,
): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [
    { role: 'system', content: systemPrompt },
  ];

  for (const msg of messages) {
    switch (msg.role) {
      case 'user':
        result.push({ role: 'user', content: msg.content });
        break;

      case 'assistant': {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          result.push({
            role: 'assistant',
            content: msg.content || null,
            tool_calls: msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input),
              },
            })),
          });
        } else {
          result.push({ role: 'assistant', content: msg.content });
        }
        break;
      }

      case 'tool_result': {
        // Each tool result is a separate role:"tool" message
        for (const tr of msg.results) {
          let content: string;
          if (typeof tr.content === 'string') {
            content = tr.content;
          } else {
            // CanonicalContentBlock[] — resolve to text fallback for OpenAI
            const { textFallback } = await resolveContentBlocks(
              tr.content as CanonicalContentBlock[],
              'openai',
              multimodal,
            );
            content = textFallback;
          }
          result.push({
            role: 'tool',
            tool_call_id: tr.toolCallId,
            content,
          });
        }
        break;
      }
    }
  }

  return result;
}

/**
 * Helper: append a message to the result, or merge with the last message if same role.
 * This enforces Anthropic's strict role alternation requirement.
 */
function appendOrMerge(
  result: Record<string, unknown>[],
  role: string,
  content: string | unknown[],
): void {
  if (result.length > 0) {
    const last = result[result.length - 1];
    if (last.role === role) {
      // Merge: convert both to content block arrays
      const prevContent = normalizeContent(last.content);
      const newContent = normalizeContent(content);
      last.content = [...prevContent, ...newContent];
      return;
    }
  }
  result.push({ role, content });
}

/**
 * Normalize content to an array of content blocks for merging.
 */
function normalizeContent(content: unknown): unknown[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content;
  }
  return [{ type: 'text', text: String(content) }];
}
