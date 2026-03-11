/**
 * Message Builder: Convert session_messages DB rows → ConversationMessage[]
 * for structured multi-turn conversation passing to AI providers.
 */
import type { ConversationMessage, CanonicalContentBlock, CanonicalToolCall, CanonicalToolResult, AssistantToolHistory } from '@synapse/shared';
import { textBlocks } from '@synapse/shared';

interface SessionMessageRow {
  id: string;
  role: string;
  content: string;
  contentBlocks?: CanonicalContentBlock[];
  metadata: Record<string, unknown> | string;
  created_at: string;
}

interface BuildOptions {
  crossTurnToolHistory?: boolean;
  interrupts?: { type: string; content: string }[];
  memoryNotice?: string;
}

/**
 * Build ConversationMessage[] from session message rows.
 * Maps DB roles to proper conversation roles, with optional cross-turn tool history expansion.
 */
export function buildConversationMessages(
  sessionMessages: SessionMessageRow[],
  options: BuildOptions = {},
): ConversationMessage[] {
  const messages: ConversationMessage[] = [];

  for (const msg of sessionMessages) {
    const meta = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : (msg.metadata || {});

    switch (msg.role) {
      case 'user': {
        const blocks: CanonicalContentBlock[] = Array.isArray(msg.contentBlocks) ? msg.contentBlocks : textBlocks(msg.content);
        messages.push({ role: 'user', content: blocks });
        break;
      }

      case 'assistant': {
        // If crossTurnToolHistory is enabled and message has tool history, expand it
        if (options.crossTurnToolHistory && meta.toolHistory) {
          const toolHistory = meta.toolHistory as AssistantToolHistory;
          expandToolHistory(messages, msg.content, toolHistory);
        } else {
          messages.push({
            role: 'assistant',
            content: Array.isArray(msg.contentBlocks) ? msg.contentBlocks : textBlocks(msg.content),
          });
        }
        break;
      }

      case 'system':
        messages.push({ role: 'user', content: textBlocks(`[Task Instruction]: ${msg.content}`) });
        break;

      case 'child_result':
        messages.push({ role: 'user', content: textBlocks(msg.content) });
        break;

      case 'tool_result':
        messages.push({ role: 'user', content: textBlocks(`[Tool Result]: ${msg.content}`) });
        break;
    }
  }

  // Append interrupts
  if (options.interrupts && options.interrupts.length > 0) {
    let interruptContent = '[System Notice] The following interrupts need your attention:\n';
    for (const interrupt of options.interrupts) {
      interruptContent += `- [${interrupt.type}]: ${interrupt.content}\n`;
    }
    messages.push({ role: 'user', content: textBlocks(interruptContent) });
  }

  // Append memory notice
  if (options.memoryNotice) {
    messages.push({ role: 'user', content: textBlocks(options.memoryNotice) });
  }

  // Ensure messages end with user role (required by most APIs)
  ensureEndsWithUser(messages);

  return messages;
}

/**
 * Expand tool history into proper conversation turn structure:
 * For each round in the tool history:
 *   - assistant message with content + toolCalls
 *   - tool_result message with results
 * Final assistant message with the main response text.
 */
function expandToolHistory(
  messages: ConversationMessage[],
  finalText: string,
  toolHistory: AssistantToolHistory,
): void {
  if (!toolHistory.rounds || toolHistory.rounds.length === 0) {
    messages.push({ role: 'assistant', content: textBlocks(finalText) });
    return;
  }

  for (const round of toolHistory.rounds) {
    // Assistant message with tool calls
    const toolCalls: CanonicalToolCall[] = round.toolCalls.map((tc) => ({
      callId: tc.callId,
      providerCallId: tc.providerCallId,
      toolName: tc.toolName,
      input: tc.input,
      metadata: tc.metadata,
    }));

    messages.push({
      role: 'assistant',
      content: round.content || [],
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    });

    // Tool results
    if (round.toolResults.length > 0) {
      const results: CanonicalToolResult[] = round.toolResults.map((tr) => ({
        toolCallId: tr.toolCallId,
        providerCallId: tr.providerCallId,
        toolName: tr.toolName,
        content: tr.content,
        isError: tr.isError,
        metadata: tr.metadata,
      }));
      messages.push({ role: 'tool_result', results });
    }
  }

  // Final assistant message with the response text
  if (finalText) {
    messages.push({ role: 'assistant', content: textBlocks(finalText) });
  }
}

/**
 * Ensure message array ends with a user message.
 * If it ends with assistant, append a minimal user continuation prompt.
 */
function ensureEndsWithUser(messages: ConversationMessage[]): void {
  if (messages.length === 0) return;
  const last = messages[messages.length - 1];
  if (last.role !== 'user') {
    messages.push({ role: 'user', content: textBlocks('Please continue.') });
  }
}
