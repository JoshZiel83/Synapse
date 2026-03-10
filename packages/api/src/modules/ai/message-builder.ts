/**
 * Message Builder: Convert session_messages DB rows → ConversationMessage[]
 * for structured multi-turn conversation passing to AI providers.
 */
import type { ConversationMessage, CanonicalToolCall, CanonicalToolResult, AssistantToolHistory } from '@synapse/shared';

interface SessionMessageRow {
  id: string;
  role: string;
  content: string;
  metadata: Record<string, unknown> | string;
  created_at: string;
}

interface BuildOptions {
  crossTurnToolHistory?: boolean;
  interrupts?: { type: string; content: string }[];
  resumeTrigger?: boolean;
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
        let content = msg.content;
        // Append attachment descriptions
        if (Array.isArray(meta.attachments) && meta.attachments.length > 0) {
          for (const att of meta.attachments) {
            content += `\n[Attached file: ${att.originalName} (${att.mimeType}) - ${att.url}]`;
          }
        }
        messages.push({ role: 'user', content });
        break;
      }

      case 'assistant': {
        // If crossTurnToolHistory is enabled and message has tool history, expand it
        if (options.crossTurnToolHistory && meta.toolHistory) {
          const toolHistory = meta.toolHistory as AssistantToolHistory;
          expandToolHistory(messages, msg.content, toolHistory);
        } else {
          messages.push({ role: 'assistant', content: msg.content });
        }
        break;
      }

      case 'system':
        messages.push({ role: 'user', content: `[Task Instruction]: ${msg.content}` });
        break;

      case 'child_result':
        messages.push({ role: 'user', content: msg.content });
        break;

      case 'tool_result':
        messages.push({ role: 'user', content: `[Tool Result]: ${msg.content}` });
        break;
    }
  }

  // Append interrupts
  if (options.interrupts && options.interrupts.length > 0) {
    let interruptContent = '[System Notice] The following interrupts need your attention:\n';
    for (const interrupt of options.interrupts) {
      interruptContent += `- [${interrupt.type}]: ${interrupt.content}\n`;
    }
    messages.push({ role: 'user', content: interruptContent });
  }

  // Append memory notice
  if (options.memoryNotice) {
    messages.push({ role: 'user', content: options.memoryNotice });
  }

  // Append resume trigger
  if (options.resumeTrigger) {
    messages.push({ role: 'user', content: '[System Notice] Your previously delegated child tasks have all completed. Review the child task results above and continue processing.' });
  }

  // Ensure messages end with user role (required by most APIs)
  ensureEndsWithUser(messages);

  return messages;
}

/**
 * Expand tool history into proper conversation turn structure:
 * For each round in the tool history:
 *   - assistant message with text + toolCalls
 *   - tool_result message with results
 * Final assistant message with the main response text.
 */
function expandToolHistory(
  messages: ConversationMessage[],
  finalText: string,
  toolHistory: AssistantToolHistory,
): void {
  if (!toolHistory.rounds || toolHistory.rounds.length === 0) {
    messages.push({ role: 'assistant', content: finalText });
    return;
  }

  for (const round of toolHistory.rounds) {
    // Assistant message with tool calls
    const toolCalls: CanonicalToolCall[] = round.toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      input: tc.input,
    }));

    messages.push({
      role: 'assistant',
      content: round.textContent || '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    });

    // Tool results
    if (round.toolResults.length > 0) {
      const results: CanonicalToolResult[] = round.toolResults.map((tr) => ({
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        content: tr.content,
        isError: tr.isError,
      }));
      messages.push({ role: 'tool_result', results });
    }
  }

  // Final assistant message with the response text
  if (finalText) {
    messages.push({ role: 'assistant', content: finalText });
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
    messages.push({ role: 'user', content: 'Please continue.' });
  }
}
