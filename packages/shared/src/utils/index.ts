import type { WorkItemStatus } from '../types/index.js';
import { WORK_ITEM_TRANSITIONS } from '../types/index.js';

export function generateId(): string {
  const cryptoRef = globalThis as typeof globalThis & {
    crypto?: {
      randomUUID?: () => string;
    };
  };

  if (typeof cryptoRef.crypto?.randomUUID === 'function') {
    return cryptoRef.crypto.randomUUID();
  }

  return `id_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

export function isValidTransition(from: WorkItemStatus, to: WorkItemStatus): boolean {
  const allowed = WORK_ITEM_TRANSITIONS[from];
  return allowed?.includes(to) ?? false;
}

export function paginate(page: number, pageSize: number, maxPageSize = 100) {
  const p = Math.max(1, page);
  const ps = Math.min(Math.max(1, pageSize), maxPageSize);
  return { offset: (p - 1) * ps, limit: ps, page: p, pageSize: ps };
}

export function nowISO(): string {
  return new Date().toISOString();
}

export const GROUP_CONVERSATION_KIND = 'group';
export const PRIVATE_CONVERSATION_KIND = 'private';
export const VIRTUAL_CONVERSATION_KIND = 'virtual';
export const THREAD_CONVERSATION_KINDS = [
  GROUP_CONVERSATION_KIND,
  PRIVATE_CONVERSATION_KIND,
] as const;

export type ThreadAddressingMode =
  | 'none'
  | 'implicit_peer'
  | 'explicit_recipients';

export interface ThreadSemantics {
  hasThreadContext: boolean;
  isPrivateConversation: boolean;
  isGroupConversation: boolean;
  otherParticipantCount: number;
  hasAddressablePeer: boolean;
  addressingMode: ThreadAddressingMode;
  requiresVisibleReplyBeforeSleep: boolean;
  allowsSleepWithoutReplyConfirmation: boolean;
}

export function isGroupConversationKind(kind: string | null | undefined): boolean {
  return kind === GROUP_CONVERSATION_KIND;
}

export function isPrivateConversationKind(kind: string | null | undefined): boolean {
  return kind === PRIVATE_CONVERSATION_KIND;
}

export function isThreadConversationKind(kind: string | null | undefined): boolean {
  return kind === GROUP_CONVERSATION_KIND || kind === PRIVATE_CONVERSATION_KIND;
}

export function resolveThreadSemantics(params: {
  kind?: string | null;
  otherParticipantCount?: number;
}): ThreadSemantics {
  const otherParticipantCount = Math.max(
    0,
    Math.trunc(params.otherParticipantCount ?? 0),
  );
  const isPrivateConversation = isPrivateConversationKind(params.kind);
  const isGroupConversation = isGroupConversationKind(params.kind);
  const hasThreadContext = isThreadConversationKind(params.kind);
  const hasAddressablePeer = hasThreadContext && otherParticipantCount > 0;

  let addressingMode: ThreadAddressingMode = 'none';
  if (isPrivateConversation) {
    addressingMode = 'implicit_peer';
  } else if (isGroupConversation) {
    addressingMode = 'explicit_recipients';
  }

  return {
    hasThreadContext,
    isPrivateConversation,
    isGroupConversation,
    otherParticipantCount,
    hasAddressablePeer,
    addressingMode,
    requiresVisibleReplyBeforeSleep: hasAddressablePeer,
    allowsSleepWithoutReplyConfirmation: isGroupConversation && hasAddressablePeer,
  };
}
