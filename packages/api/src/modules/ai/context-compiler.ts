import type {
  CanonicalArchiveFrame,
  CanonicalContentBlock,
  ConversationMessage,
  ProviderContextWindow,
} from '@synapse/shared';
import { extractText } from '@synapse/shared';
import type {
  CanonicalContextItem,
  CanonicalContextTarget,
} from '@synapse/shared/types';

function withTextPrefix(prefix: string, blocks: CanonicalContentBlock[]) {
  if (!prefix) return blocks;
  return [{ type: 'text', text: prefix } as const, ...blocks];
}

function targetLabel(targets?: CanonicalContextTarget[]) {
  if (!targets || targets.length === 0) return '';
  const names = targets.map((target) => target.name || 'Unknown');
  return names.join(', ');
}

function authorLabel(item: Extract<CanonicalContextItem, { kind: 'message' | 'event' }>) {
  return item.author?.name || 'Unknown';
}

function normalizeParts(parts?: CanonicalContentBlock[]) {
  return parts && parts.length > 0 ? parts : [{ type: 'text', text: '' } as const];
}

export async function compressContextItems(
  items: CanonicalContextItem[],
): Promise<CanonicalContextItem[]> {
  return items;
}

export async function compressContextWindow(
  window: ProviderContextWindow,
): Promise<ProviderContextWindow> {
  return window;
}

function archiveFramePrefix(frame: CanonicalArchiveFrame, chainLabel: string) {
  const frameLabel = frame.frameType ? `${chainLabel}/${frame.frameType}` : chainLabel;
  return `[Archive ${frameLabel}]: `;
}

function compileArchiveFrameToConversationMessages(
  frame: CanonicalArchiveFrame,
  chainLabel: string,
): ConversationMessage[] {
  const parts = normalizeParts(frame.parts);

  switch (frame.role) {
    case 'assistant':
      return [{
        role: 'assistant',
        content: parts,
        toolCalls: frame.toolCalls && frame.toolCalls.length > 0 ? frame.toolCalls : undefined,
      }];

    case 'tool':
      if (frame.toolResults && frame.toolResults.length > 0) {
        return [{
          role: 'tool_result',
          results: frame.toolResults,
        }];
      }
      return [{
        role: 'user',
        content: withTextPrefix(archiveFramePrefix(frame, chainLabel), parts),
      }];

    case 'system':
      return [{
        role: 'user',
        content: withTextPrefix(archiveFramePrefix(frame, chainLabel), parts),
      }];

    case 'user':
    default:
      return [{
        role: 'user',
        content: parts,
      }];
  }
}

export async function compileContextItemsToConversationMessages(
  items: CanonicalContextItem[],
): Promise<ConversationMessage[]> {
  const messages: ConversationMessage[] = [];

  for (const item of items) {
    switch (item.kind) {
      case 'system_notice': {
        messages.push({
          role: 'user',
          content: normalizeParts(item.parts),
        });
        break;
      }

      case 'event': {
        const parts = normalizeParts(item.parts);
        messages.push({
          role: 'user',
          content: withTextPrefix('[System]: ', parts),
        });
        break;
      }

      case 'message': {
        if (item.role === 'system') {
          messages.push({
            role: 'user',
            content: withTextPrefix('[System]: ', normalizeParts(item.parts)),
          });
          break;
        }

        if (item.role === 'assistant' && item.author?.isSelf) {
          const targetNames = targetLabel(item.targets);
          const prefix = targetNames ? `[→ ${targetNames}] ` : '';
          messages.push({
            role: 'assistant',
            content: withTextPrefix(prefix, normalizeParts(item.parts)),
          });
          break;
        }

        const targets = targetLabel(item.targets);
        const header = `[${authorLabel(item)}${targets ? ` → ${targets}` : ''}]: `;
        messages.push({
          role: 'user',
          content: withTextPrefix(header, normalizeParts(item.parts)),
        });
        break;
      }

      case 'tool_call_batch': {
        messages.push({
          role: 'assistant',
          content: item.content && item.content.length > 0 ? item.content : [],
          toolCalls: item.toolCalls,
        });
        break;
      }

      case 'tool_result_batch': {
        messages.push({
          role: 'tool_result',
          results: item.toolResults,
        });
        break;
      }

      case 'summary': {
        messages.push({
          role: 'user',
          content: withTextPrefix('[Summary]: ', normalizeParts(item.parts)),
        });
        break;
      }

      case 'memory_recall': {
        const content: CanonicalContentBlock[] = [{
          type: 'text',
          text: item.recallType === 'bootstrap' ? '[Recalled Memory / Bootstrap]\n' : '[Recalled Memory / Turn]\n',
        }];

        item.memories.forEach((memory, index) => {
          const fallbackText = extractText(memory.contentBlocks).trim();
          const digest = memory.textDigest || fallbackText;
          content.push({
            type: 'text',
            text: `[${memory.ownerScope}/${memory.category}]${digest ? ` ${digest}` : ''}\n`,
          });

          if (memory.contentBlocks.length > 0) {
            content.push(...memory.contentBlocks);
          }

          if (index < item.memories.length - 1) {
            content.push({ type: 'text', text: '\n' });
          }
        });

        messages.push({
          role: 'user',
          content: normalizeParts(content),
        });
        break;
      }
    }
  }

  return messages;
}

export async function compileContextWindowToConversationMessages(
  window: ProviderContextWindow,
): Promise<ConversationMessage[]> {
  const messages: ConversationMessage[] = [];

  if (window.sharedArchivePoint) {
    for (const frame of window.sharedArchivePoint.frames) {
      messages.push(...compileArchiveFrameToConversationMessages(frame, 'shared'));
    }
  }

  if (window.privateArchivePoint) {
    for (const frame of window.privateArchivePoint.frames) {
      messages.push(...compileArchiveFrameToConversationMessages(frame, 'private'));
    }
  }

  const orderedTailItems = window.orderedTailItems.length > 0
    ? window.orderedTailItems
    : [...window.sharedTailItems, ...window.privateTailItems];

  const tailMessages = await compileContextItemsToConversationMessages(orderedTailItems);
  messages.push(...tailMessages);

  return messages;
}
