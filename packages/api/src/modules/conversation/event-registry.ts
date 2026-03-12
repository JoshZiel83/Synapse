import type {
  CanonicalContentBlock,
  ConversationEventContextPolicy,
  ConversationEventTimelinePolicy,
} from '@synapse/shared/types';
import { textBlocks } from '@synapse/shared';

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

type MembershipEntry = {
  name?: string;
  title?: string;
};

function parseMembershipEntries(payload: Record<string, unknown>): MembershipEntry[] {
  return Array.isArray(payload.members)
    ? payload.members.filter((member): member is MembershipEntry => !!member && typeof member === 'object')
    : [];
}

function membershipSummary(eventType: string, payload: Record<string, unknown>) {
  const members = parseMembershipEntries(payload);
  const names = members.map((member) => member.name || 'Unknown').join(', ') || 'Unknown';

  if (eventType === 'member_joined') {
    const title = members.length === 1 && members[0]?.title ? ` (${members[0].title})` : '';
    return `${names} joined the group${title}`;
  }

  if (eventType === 'member_kicked') {
    return `${names} was removed from the group`;
  }

  if (eventType === 'member_left') {
    return `${names} left the group`;
  }

  return names;
}

function memorySummary(eventType: string, payload: Record<string, unknown>) {
  const textDigest = typeof payload.textDigest === 'string' ? payload.textDigest.trim() : '';
  const scope = typeof payload.memoryScope === 'string' ? payload.memoryScope : 'memory';
  const actionLabel = eventType === 'memory_updated' ? 'updated' : 'saved';
  const summary = textDigest || 'durable memory saved';
  return `Memory ${actionLabel}: ${summary} (${scope})`;
}

function actorRenameSummary(payload: Record<string, unknown>) {
  const newName = typeof payload.newName === 'string' ? payload.newName.trim() : 'Unknown';
  return `Actor renamed: will now be called ${newName}.`;
}

function actorAvatarSummary(payload: Record<string, unknown>) {
  const avatarEmoji = typeof payload.avatarEmoji === 'string' ? payload.avatarEmoji.trim() : '🙂';
  return `Actor avatar updated to ${avatarEmoji}.`;
}

function genericSummary(eventType: string) {
  return `[Event: ${eventType}]`;
}

function noContext(): null {
  return null;
}

const EVENT_SPECS: Record<string, ConversationEventSpec> = {
  member_joined: {
    timelinePolicy: 'all_members',
    contextPolicy: 'shared',
    renderTimeline: ({ eventType, payload }) => textBlocks(membershipSummary(eventType, payload)),
    renderContext: ({ eventType, payload }) => textBlocks(membershipSummary(eventType, payload)),
  },
  member_kicked: {
    timelinePolicy: 'all_members',
    contextPolicy: 'shared',
    renderTimeline: ({ eventType, payload }) => textBlocks(membershipSummary(eventType, payload)),
    renderContext: ({ eventType, payload }) => textBlocks(membershipSummary(eventType, payload)),
  },
  member_left: {
    timelinePolicy: 'all_members',
    contextPolicy: 'shared',
    renderTimeline: ({ eventType, payload }) => textBlocks(membershipSummary(eventType, payload)),
    renderContext: ({ eventType, payload }) => textBlocks(membershipSummary(eventType, payload)),
  },
  memory_saved: {
    timelinePolicy: 'users_only',
    contextPolicy: 'none',
    renderTimeline: ({ eventType, payload }) => textBlocks(memorySummary(eventType, payload)),
    renderContext: noContext,
  },
  memory_updated: {
    timelinePolicy: 'users_only',
    contextPolicy: 'none',
    renderTimeline: ({ eventType, payload }) => textBlocks(memorySummary(eventType, payload)),
    renderContext: noContext,
  },
  actor_renamed: {
    timelinePolicy: 'users_only',
    contextPolicy: 'none',
    renderTimeline: ({ payload }) => textBlocks(actorRenameSummary(payload)),
    renderContext: noContext,
  },
  actor_avatar_changed: {
    timelinePolicy: 'users_only',
    contextPolicy: 'none',
    renderTimeline: ({ payload }) => textBlocks(actorAvatarSummary(payload)),
    renderContext: noContext,
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
