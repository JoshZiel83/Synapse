import type {
  CanonicalContentBlock,
  ConversationEventContextPolicy,
  ConversationEventTimelinePolicy,
} from '@synapse/shared/types';
import { summarizeConversationEvent, textBlocks } from '@synapse/shared';

export interface ConversationEventRenderContext {
  eventType: string;
  payload: Record<string, unknown>;
}

export interface ConversationEventSpec {
  timelinePolicy: ConversationEventTimelinePolicy;
  contextPolicy: ConversationEventContextPolicy;
  renderTimeline(context: ConversationEventRenderContext): CanonicalContentBlock[];
  renderContext?(context: ConversationEventRenderContext): CanonicalContentBlock[] | null;
}

function genericSummary(eventType: string) {
  return `[Event: ${eventType}]`;
}

function noContext(): null {
  return null;
}

function automationNoticeBlocks(payload: Record<string, unknown>): CanonicalContentBlock[] {
  const messageBlocks = Array.isArray(payload.messageBlocks)
    ? payload.messageBlocks.filter((block): block is CanonicalContentBlock => Boolean(block) && typeof block === 'object')
    : [];
  if (messageBlocks.length > 0) {
    return messageBlocks;
  }

  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (message) {
    return textBlocks(message);
  }

  const sourceTitle = typeof payload.sourceTitle === 'string' ? payload.sourceTitle.trim() : '';
  const sourceDescription = typeof payload.sourceDescription === 'string' ? payload.sourceDescription.trim() : '';
  if (sourceTitle && sourceDescription) {
    return textBlocks(`${sourceTitle}\n${sourceDescription}`);
  }
  if (sourceTitle) {
    return textBlocks(sourceTitle);
  }

  return textBlocks('Automation notice');
}

const EVENT_SPECS: Record<string, ConversationEventSpec> = {
  member_joined: {
    timelinePolicy: 'all_members',
    contextPolicy: 'shared',
    renderTimeline: ({ eventType, payload }) => textBlocks(summarizeConversationEvent(eventType, payload)),
    renderContext: ({ eventType, payload }) => textBlocks(summarizeConversationEvent(eventType, payload)),
  },
  member_kicked: {
    timelinePolicy: 'all_members',
    contextPolicy: 'shared',
    renderTimeline: ({ eventType, payload }) => textBlocks(summarizeConversationEvent(eventType, payload)),
    renderContext: ({ eventType, payload }) => textBlocks(summarizeConversationEvent(eventType, payload)),
  },
  member_left: {
    timelinePolicy: 'all_members',
    contextPolicy: 'shared',
    renderTimeline: ({ eventType, payload }) => textBlocks(summarizeConversationEvent(eventType, payload)),
    renderContext: ({ eventType, payload }) => textBlocks(summarizeConversationEvent(eventType, payload)),
  },
  memory_saved: {
    timelinePolicy: 'users_only',
    contextPolicy: 'none',
    renderTimeline: ({ eventType, payload }) => textBlocks(summarizeConversationEvent(eventType, payload)),
    renderContext: noContext,
  },
  memory_updated: {
    timelinePolicy: 'users_only',
    contextPolicy: 'none',
    renderTimeline: ({ eventType, payload }) => textBlocks(summarizeConversationEvent(eventType, payload)),
    renderContext: noContext,
  },
  actor_renamed: {
    timelinePolicy: 'users_only',
    contextPolicy: 'none',
    renderTimeline: ({ eventType, payload }) => textBlocks(summarizeConversationEvent(eventType, payload)),
    renderContext: noContext,
  },
  actor_avatar_changed: {
    timelinePolicy: 'users_only',
    contextPolicy: 'none',
    renderTimeline: ({ eventType, payload }) => textBlocks(summarizeConversationEvent(eventType, payload)),
    renderContext: noContext,
  },
  actor_version_changed: {
    timelinePolicy: 'all_members',
    contextPolicy: 'shared',
    renderTimeline: ({ eventType, payload }) => textBlocks(summarizeConversationEvent(eventType, payload)),
    renderContext: ({ eventType, payload }) => textBlocks(summarizeConversationEvent(eventType, payload)),
  },
  automation_notice: {
    timelinePolicy: 'all_members',
    contextPolicy: 'shared',
    renderTimeline: ({ payload }) => automationNoticeBlocks(payload),
    renderContext: ({ payload }) => automationNoticeBlocks(payload),
  },
  interaction_requested: {
    timelinePolicy: 'targeted_members',
    contextPolicy: 'targeted_members',
    renderTimeline: ({ eventType, payload }) => textBlocks(summarizeConversationEvent(eventType, payload)),
    renderContext: ({ eventType, payload }) => textBlocks(summarizeConversationEvent(eventType, payload)),
  },
};

const DEFAULT_EVENT_SPEC: ConversationEventSpec = {
  timelinePolicy: 'all_members',
  contextPolicy: 'shared',
  renderTimeline: ({ eventType }) => textBlocks(genericSummary(eventType)),
  renderContext: ({ eventType }) => textBlocks(genericSummary(eventType)),
};

function normalizePayload(payload: unknown): Record<string, unknown> {
  if (!payload) return {};
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return payload as Record<string, unknown>;
}

export function getConversationEventSpec(eventType: string): ConversationEventSpec {
  return EVENT_SPECS[eventType] || DEFAULT_EVENT_SPEC;
}

export function renderConversationEventTimelineBlocks(
  eventType: string,
  payload: unknown,
): CanonicalContentBlock[] {
  const eventPayload = normalizePayload(payload);
  return getConversationEventSpec(eventType).renderTimeline({ eventType, payload: eventPayload });
}

export function renderConversationEventContextBlocks(
  eventType: string,
  payload: unknown,
): CanonicalContentBlock[] | null {
  const eventPayload = normalizePayload(payload);
  const spec = getConversationEventSpec(eventType);
  return spec.renderContext
    ? spec.renderContext({ eventType, payload: eventPayload })
    : spec.renderTimeline({ eventType, payload: eventPayload });
}
