// Access presentation layer: binding domain record → app-facing
// AutomationEventSourceAccessGrant view. Owns the Date→IsoInstantString
// serialization (serializeInstant) so bindings.ts never calls it
// (guard-layering r3). round-6 P1-7. The row→target decoder
// (readAutomationEventSourceAccessBindingTarget) + the joined-row type stay in
// bindings.ts; this presenter calls back into them, the same direction
// automation/presenter.ts already uses.

import type {
  AutomationEventSourceAccessGrant,
  CapabilityAccessTarget,
} from "@synapse/shared/types"
import {
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
import {
  readAutomationEventSourceAccessBindingTarget,
  type AutomationEventSourceBindingJoinedRow,
} from "./bindings.js"

export function mapAutomationEventSourceAccessBindingToGrant(
  row: AutomationEventSourceBindingJoinedRow,
  fallbackReason?: string,
  options?: {
    effectiveConversationTypeMask?: number
  }
): AutomationEventSourceAccessGrant {
  const target = readAutomationEventSourceAccessBindingTarget(row)
  const capabilityTarget: CapabilityAccessTarget = target.scope
    ? { subject: target.subject, scope: target.scope }
    : { subject: target.subject }

  return {
    id: row.id,
    resourceId: row.resourceId,
    workspaceId: row.workspaceId || "",
    target: capabilityTarget,
    status: row.status,
    grantedByWorkspaceMemberId: row.createdByWorkspaceMemberId || undefined,
    reason: row.reason || fallbackReason,
    conversationTypeMaskOverride: row.conversationTypeMaskOverride ?? null,
    effectiveConversationTypeMask: options?.effectiveConversationTypeMask,
    createdAt: serializeInstant(row.createdAt),
    revokedAt: serializeOptionalInstant(row.revokedAt),
  }
}
