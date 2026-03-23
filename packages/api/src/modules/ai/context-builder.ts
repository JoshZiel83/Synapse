import type {
  ActorRuntimeWakeup,
  AssistantToolHistory,
  CanonicalContentBlock,
  CanonicalToolCall,
  CanonicalToolResult,
} from '@synapse/shared';
import type {
  CanonicalContextAuthor,
  CanonicalContextItem,
  CanonicalContextTarget,
} from '@synapse/shared/types';
import { fileRefBlock, textBlock, textBlocks } from '@synapse/shared';
import { renderConversationEventContextBlocks } from '../conversation/event-registry.js';
import { getFileUrlById } from '../files/service.js';

function mimeToCategory(mimeType: string): 'image' | 'audio' | 'video' | 'document' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

function parseMetadata(metadata: unknown): Record<string, unknown> {
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata);
    } catch {
      return {};
    }
  }
  return (metadata || {}) as Record<string, unknown>;
}

function parseSizeBytes(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

export function itemPartsToCanonicalBlocks(parts: any[]): CanonicalContentBlock[] {
  const blocks: CanonicalContentBlock[] = [];

  for (const part of parts || []) {
    if (part.part_type === 'text') {
      blocks.push(textBlock(part.text_value || ''));
      continue;
    }

    if (part.part_type === 'file_ref' && part.file_id) {
      const metadata = parseMetadata(part.metadata);
      blocks.push(fileRefBlock({
        fileId: part.file_id,
        storedName: part.stored_name || String(metadata.storedName || ''),
        url: part.file_id ? getFileUrlById(part.file_id) : '',
        mimeType: part.file_mime_type || part.mime_type || 'application/octet-stream',
        originalName: part.original_name || part.name || 'file',
        sizeBytes: parseSizeBytes(part.size_bytes ?? metadata.sizeBytes),
        category: (metadata.category as 'image' | 'audio' | 'video' | 'document') || 'document',
      }));
    }
  }

  return blocks;
}

function buildAuthor(row: any, actorId?: string): CanonicalContextAuthor | undefined {
  if (row.author_actor_id) {
    return {
      memberId: row.author_member_id,
      memberType: 'actor',
      actorId: row.author_actor_id,
      sessionId: row.session_id || undefined,
      name: row.author_name || undefined,
      isSelf: row.author_actor_id === actorId,
    };
  }

  if (row.author_user_id) {
    return {
      memberId: row.author_member_id,
      memberType: 'user',
      userId: row.author_user_id,
      sessionId: row.session_id || undefined,
      name: row.author_name || undefined,
      isSelf: false,
    };
  }

  if (row.author_member_type === 'system' || row.role === 'system') {
    return {
      memberId: row.author_member_id,
      memberType: 'system',
      sessionId: row.session_id || undefined,
      name: row.author_name || 'System',
      isSelf: false,
    };
  }

  return undefined;
}

function buildTargets(targets: any[]): CanonicalContextTarget[] | undefined {
  if (!targets || targets.length === 0) return undefined;
  const built = targets.map((target) => ({
    memberId: target.member_id || target.id || undefined,
    memberType: (target.member_type || 'system') as CanonicalContextTarget['memberType'],
    actorId: target.actor_id || undefined,
    userId: target.user_id || undefined,
    name: target.member_name || undefined,
  }));
  return built.length > 0 ? built : undefined;
}

export function conversationItemToContextItem(item: any, actorId: string): CanonicalContextItem | null {
  const parts = itemPartsToCanonicalBlocks(item.parts || []);
  const metadata = parseMetadata(item.metadata);
  const eventPayload = parseMetadata(item.event_payload);
  const author = buildAuthor(item, actorId);
  const targets = buildTargets(item.context_targets?.length > 0 ? item.context_targets : item.targets || []);

  if (item.item_type === 'event' || item.role === 'system') {
    const contextPolicy = (item.event_context_policy || 'shared') as
      | 'none'
      | 'shared'
      | 'actor_private'
      | 'targeted_members';
    if (contextPolicy === 'none') {
      return null;
    }

    const renderedContextParts = renderConversationEventContextBlocks(item.subtype || 'event', eventPayload);
    const eventParts = renderedContextParts && renderedContextParts.length > 0 ? renderedContextParts : parts;
    return {
      kind: 'event',
      itemId: item.id,
      conversationId: item.conversation_id,
      sessionId: item.session_id || undefined,
      turnId: item.turn_id || undefined,
      sequence: item.sequence,
      scope: item.scope || 'shared',
      surface: item.surface || 'visible',
      eventType: item.subtype || 'event',
      eventPayload,
      timelinePolicy: item.event_timeline_policy || undefined,
      contextPolicy,
      author,
      targets,
      parts: eventParts.length > 0 ? eventParts : textBlocks(''),
      metadata,
    };
  }

  return {
    kind: 'message',
    itemId: item.id,
    conversationId: item.conversation_id,
    sessionId: item.session_id || undefined,
    turnId: item.turn_id || undefined,
    sequence: item.sequence,
    scope: item.scope || 'shared',
    surface: item.surface || 'visible',
    messageType: item.subtype || 'chat',
    role: item.role || 'user',
    author,
    targets,
    parts: parts.length > 0 ? parts : textBlocks(''),
    metadata,
  };
}

function buildInterruptNotice(interrupt: { type: string; content: string }): CanonicalContextItem {
  return {
    kind: 'system_notice',
    noticeType: 'interrupt',
    scope: 'private',
    surface: 'internal',
    parts: textBlocks(`[System Interrupt - ${interrupt.type}]: ${interrupt.content}`),
    metadata: {
      interruptType: interrupt.type,
    },
  };
}

function buildWakeupNotice(wakeup: Pick<ActorRuntimeWakeup, 'wakeupId' | 'sourceType' | 'sourceName' | 'summary' | 'reasonText'>): CanonicalContextItem {
  const title = wakeup.sourceName ? `${wakeup.sourceType} from ${wakeup.sourceName}` : wakeup.sourceType;
  const reason = wakeup.reasonText?.trim() || wakeup.summary.trim();
  return {
    kind: 'system_notice',
    itemId: `wakeup:${wakeup.wakeupId}`,
    scope: 'private',
    surface: 'internal',
    noticeType: 'task_instruction',
    parts: textBlocks(`[Wakeup - ${title}]: ${reason}`),
    metadata: {
      wakeupId: wakeup.wakeupId,
      sourceType: wakeup.sourceType,
      summary: wakeup.summary,
      reasonText: wakeup.reasonText,
    },
  };
}

function expandToolHistoryContextItems(
  items: CanonicalContextItem[],
  messageId: string,
  conversationId: string | undefined,
  sessionId: string,
  sequence: number | undefined,
  finalText: string,
  toolHistory: AssistantToolHistory,
) {
  if (!toolHistory.rounds || toolHistory.rounds.length === 0) {
    if (finalText) {
      items.push({
        kind: 'message',
        itemId: messageId,
        conversationId,
        sessionId,
        sequence,
        scope: 'shared',
        surface: 'visible',
        messageType: 'assistant_message',
        role: 'assistant',
        author: {
          memberType: 'actor',
          sessionId,
          isSelf: true,
        },
        parts: textBlocks(finalText),
      });
    }
    return;
  }

  for (let roundIndex = 0; roundIndex < toolHistory.rounds.length; roundIndex++) {
    const round = toolHistory.rounds[roundIndex];
    const toolCalls: CanonicalToolCall[] = round.toolCalls.map((toolCall) => ({
      callId: toolCall.callId,
      providerCallId: toolCall.providerCallId,
      toolName: toolCall.toolName,
      input: toolCall.input,
      metadata: toolCall.metadata,
    }));
    const toolResults: CanonicalToolResult[] = round.toolResults.map((toolResult) => ({
      toolCallId: toolResult.toolCallId,
      providerCallId: toolResult.providerCallId,
      toolName: toolResult.toolName,
      content: toolResult.content,
      isError: toolResult.isError,
      metadata: toolResult.metadata,
    }));

    items.push({
      kind: 'tool_call_batch',
      itemId: `${messageId}:tool-call:${roundIndex}`,
      conversationId,
      sessionId,
      sequence,
      scope: 'private',
      surface: 'internal',
      role: 'assistant',
      author: {
        memberType: 'actor',
        sessionId,
        isSelf: true,
      },
      content: round.content,
      toolCalls,
    });

    if (toolResults.length > 0) {
      items.push({
        kind: 'tool_result_batch',
        itemId: `${messageId}:tool-result:${roundIndex}`,
        conversationId,
        sessionId,
        sequence,
        scope: 'private',
        surface: 'internal',
        toolResults,
      });
    }
  }

  if (finalText) {
    items.push({
      kind: 'message',
      itemId: messageId,
      conversationId,
      sessionId,
      sequence,
      scope: 'shared',
      surface: 'visible',
      messageType: 'assistant_message',
      role: 'assistant',
      author: {
        memberType: 'actor',
        sessionId,
        isSelf: true,
      },
      parts: textBlocks(finalText),
    });
  }
}

interface SessionMessageRow {
  id: string;
  sessionId: string;
  conversationId?: string;
  sequence?: number;
  role: string;
  content: string;
  contentBlocks?: CanonicalContentBlock[];
  metadata: Record<string, unknown> | string;
}

export function buildSessionContextItems(
  sessionMessages: SessionMessageRow[],
  options: {
    crossTurnToolHistory?: boolean;
    interrupts?: { type: string; content: string }[];
    wakeups?: Pick<ActorRuntimeWakeup, 'wakeupId' | 'sourceType' | 'sourceName' | 'summary' | 'reasonText'>[];
  } = {},
): CanonicalContextItem[] {
  const items: CanonicalContextItem[] = [];

  if (options.wakeups) {
    items.push(...options.wakeups.map(buildWakeupNotice));
  }

  for (const msg of sessionMessages) {
    const meta = parseMetadata(msg.metadata);
    switch (msg.role) {
      case 'user': {
        items.push({
          kind: 'message',
          itemId: msg.id,
          conversationId: msg.conversationId,
          sessionId: msg.sessionId,
          sequence: msg.sequence,
          scope: 'shared',
          surface: 'visible',
          messageType: 'user_message',
          role: 'user',
          author: {
            memberType: 'user',
            sessionId: msg.sessionId,
            isSelf: false,
          },
          parts: Array.isArray(msg.contentBlocks) ? msg.contentBlocks : textBlocks(msg.content),
          metadata: meta,
        });
        break;
      }

      case 'assistant': {
        if (options.crossTurnToolHistory && meta.toolHistory) {
          expandToolHistoryContextItems(
            items,
            msg.id,
            msg.conversationId,
            msg.sessionId,
            msg.sequence,
            msg.content,
            meta.toolHistory as AssistantToolHistory,
          );
        } else {
          items.push({
            kind: 'message',
            itemId: msg.id,
            conversationId: msg.conversationId,
            sessionId: msg.sessionId,
            sequence: msg.sequence,
            scope: 'shared',
            surface: 'visible',
            messageType: 'assistant_message',
            role: 'assistant',
            author: {
              memberType: 'actor',
              sessionId: msg.sessionId,
              isSelf: true,
            },
            parts: Array.isArray(msg.contentBlocks) ? msg.contentBlocks : textBlocks(msg.content),
            metadata: meta,
          });
        }
        break;
      }

      case 'system': {
        items.push({
          kind: 'system_notice',
          itemId: msg.id,
          conversationId: msg.conversationId,
          sessionId: msg.sessionId,
          sequence: msg.sequence,
          scope: 'shared',
          surface: 'visible',
          noticeType: 'task_instruction',
          parts: textBlocks(`[Task Instruction]: ${msg.content}`),
          metadata: meta,
        });
        break;
      }

      case 'child_result': {
        items.push({
          kind: 'system_notice',
          itemId: msg.id,
          conversationId: msg.conversationId,
          sessionId: msg.sessionId,
          sequence: msg.sequence,
          scope: 'private',
          surface: 'internal',
          noticeType: 'generic',
          parts: textBlocks(msg.content),
          metadata: meta,
        });
        break;
      }

      case 'tool_result': {
        items.push({
          kind: 'system_notice',
          itemId: msg.id,
          conversationId: msg.conversationId,
          sessionId: msg.sessionId,
          sequence: msg.sequence,
          scope: 'private',
          surface: 'internal',
          noticeType: 'legacy_tool_result',
          parts: textBlocks(`[Tool Result]: ${msg.content}`),
          metadata: meta,
        });
        break;
      }
    }
  }

  if (options.interrupts) {
    items.push(...options.interrupts.map(buildInterruptNotice));
  }

  return items;
}

export function buildGroupContextItems(params: {
  visibleItems: any[];
  actorId: string;
  sessionMessages: SessionMessageRow[];
  interrupts?: { type: string; content: string }[];
  wakeups?: Pick<ActorRuntimeWakeup, 'wakeupId' | 'sourceType' | 'sourceName' | 'summary' | 'reasonText'>[];
}) {
  const items: CanonicalContextItem[] = [];

  if (params.wakeups) {
    items.push(...params.wakeups.map(buildWakeupNotice));
  }

  if (params.interrupts) {
    items.push(...params.interrupts.map(buildInterruptNotice));
  }

  for (const item of params.visibleItems) {
    const contextItem = conversationItemToContextItem(item, params.actorId);
    if (contextItem) items.push(contextItem);
  }

  for (const sessionMessage of params.sessionMessages) {
    if (sessionMessage.role !== 'tool_result') continue;
    items.push({
      kind: 'system_notice',
      itemId: sessionMessage.id,
      conversationId: sessionMessage.conversationId,
      sessionId: sessionMessage.sessionId,
      sequence: sessionMessage.sequence,
      scope: 'private',
      surface: 'internal',
      noticeType: 'legacy_tool_result',
      parts: textBlocks(`[Tool Result]: ${sessionMessage.content}`),
      metadata: parseMetadata(sessionMessage.metadata),
    });
  }

  const lastSequence = params.visibleItems.length > 0 ? params.visibleItems[params.visibleItems.length - 1].sequence : 0;
  return { items, lastSequence };
}

export function buildAdHocContextItems(
  messages: Array<{ role: 'user' | 'assistant'; content: CanonicalContentBlock[] }>,
): CanonicalContextItem[] {
  return messages.map((message, index) => ({
    kind: 'message',
    itemId: `adhoc:${index}`,
    scope: 'shared',
    surface: 'visible',
    messageType: 'adhoc',
    role: message.role,
    author: {
      memberType: message.role === 'assistant' ? 'actor' : 'user',
      isSelf: message.role === 'assistant',
    },
    parts: message.content,
  }));
}
