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

export const MULTI_MEMBER_CONVERSATION_KIND = 'group';

export function isMultiMemberConversationKind(kind: string | null | undefined): boolean {
  return kind === MULTI_MEMBER_CONVERSATION_KIND;
}
