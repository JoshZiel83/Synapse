import { SUBJECT_KIND } from "@synapse/shared"
import {
  readAutomationEventSourceAccessBindingResourceId,
  type AutomationEventSourceBindingRelation,
  type AutomationEventSourceBindingStorageRow,
} from "./bindings.js"

/**
 * Access data-access layer. Row-normalization helpers live here so the
 * `normalize*Row` naming + row-spread stay inside a repo file (guard-layering
 * r4/r7). Behavior is identical to the previous `bindings.ts` definition.
 */
export function normalizeAutomationEventSourceAccessBindingRow<
  T extends AutomationEventSourceBindingStorageRow & {
    subjectId?: string | null
    scopeSubjectId?: string | null
    subjectKind?: string | null
    subjectWorkspaceIdViaJoin?: string | null
    subjectWorkspaceMemberIdViaJoin?: string | null
    subjectActorIdViaJoin?: string | null
    subjectRemoteAgentIdViaJoin?: string | null
    subjectConversationIdViaJoin?: string | null
    scopeKind?: string | null
    scopeWorkspaceIdViaJoin?: string | null
    scopeConversationIdViaJoin?: string | null
  },
>(
  row: T
): T & { resourceId: string; relation: AutomationEventSourceBindingRelation } {
  // Derive a relation string from subject kind; scope lives in scopeSubjectId.
  let relation: AutomationEventSourceBindingRelation
  switch (row.subjectKind) {
    case SUBJECT_KIND.WORKSPACE:
      relation = "use_workspace"
      break
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      relation = "use_workspace_member"
      break
    case SUBJECT_KIND.CONVERSATION:
      relation = "use_conversation"
      break
    case SUBJECT_KIND.ACTOR:
      relation = "use_actor"
      break
    case SUBJECT_KIND.REMOTE_AGENT:
      relation = "use_remote_agent"
      break
    default:
      relation = "use_scoped"
  }
  const normalized = {
    ...row,
    resourceId: readAutomationEventSourceAccessBindingResourceId(row),
    relation,
  }
  return normalized
}
