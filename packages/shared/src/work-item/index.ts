// Work-item state-machine runtime data.
//
// Migrated out of `types/index.ts` so that `@synapse/shared/types` stays a
// pure type surface (see docs/architecture-boundary-refactor-master-plan.md
// §2.2.1). Re-exported from the package root barrel.

import type { WorkItemStatus } from "../types/index.js"

// Valid state transitions
export const WORK_ITEM_TRANSITIONS: Record<WorkItemStatus, WorkItemStatus[]> = {
  created: ["assigned", "cancelled"],
  assigned: ["accepted", "cancelled"],
  accepted: ["in_progress", "cancelled"],
  in_progress: ["review", "escalated", "blocked", "cancelled", "failed"],
  review: ["completed", "rework", "cancelled"],
  completed: [],
  escalated: ["assigned", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  rework: ["in_progress", "cancelled"],
  cancelled: [],
  failed: [],
}
