import { WORK_ITEM_TRANSITIONS, type WorkItemStatus } from '@synapse/shared';

export function validateTransition(from: WorkItemStatus, to: WorkItemStatus): boolean {
  const allowed = WORK_ITEM_TRANSITIONS[from];
  return allowed?.includes(to) ?? false;
}

export function getAvailableTransitions(status: WorkItemStatus): WorkItemStatus[] {
  return WORK_ITEM_TRANSITIONS[status] ?? [];
}
