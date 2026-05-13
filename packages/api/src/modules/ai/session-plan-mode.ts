import {
  isPlanAwaitingApprovalCollaborationMode,
  isPlanCollaborationMode,
  isPlanDraftingCollaborationMode,
  isPrivateConversationKind,
} from "@synapse/shared/utils"
import type { SessionCollaborationMode } from "@synapse/shared/types"

const PLAN_MODE_TOOL_NAMES = new Set([
  "enter_plan_mode",
  "update_plan",
  "exit_plan_mode",
])

const PLAN_DRAFTING_ALLOWED_TOOLS = new Set([
  "read_skill",
  "memory_search",
  "current_time",
  "request_user_input",
  "update_plan",
  "exit_plan_mode",
  "list_tasks",
  "get_task_status",
  "tail_task_output",
  "cancel_task",
])

const PLAN_AWAITING_APPROVAL_ALLOWED_TOOLS = new Set([
  "list_tasks",
  "get_task_status",
  "tail_task_output",
  "cancel_task",
])

export function isPlanModeConversationKind(
  conversationKind: string | null | undefined
): boolean {
  return isPrivateConversationKind(conversationKind)
}

export function assertPlanModeConversationKind(
  conversationKind: string | null | undefined
): void {
  if (!isPlanModeConversationKind(conversationKind)) {
    throw new Error("Plan mode is only available in private conversations.")
  }
}

export function canEnterPlanMode(
  collaborationMode: SessionCollaborationMode | string | null | undefined,
  conversationKind: string | null | undefined
): boolean {
  return (
    collaborationMode === "default" &&
    isPlanModeConversationKind(conversationKind)
  )
}

export function canUpdatePlan(
  collaborationMode: SessionCollaborationMode | string | null | undefined,
  conversationKind: string | null | undefined
): boolean {
  return (
    isPlanDraftingCollaborationMode(collaborationMode) &&
    isPlanModeConversationKind(conversationKind)
  )
}

export function canExitPlanMode(
  collaborationMode: SessionCollaborationMode | string | null | undefined,
  conversationKind: string | null | undefined
): boolean {
  return (
    isPlanDraftingCollaborationMode(collaborationMode) &&
    isPlanModeConversationKind(conversationKind)
  )
}

export function isBuiltinToolAllowedInCollaborationMode(
  toolName: string,
  collaborationMode: SessionCollaborationMode | string | null | undefined,
  conversationKind: string | null | undefined
): boolean {
  if (
    !isPlanModeConversationKind(conversationKind) &&
    PLAN_MODE_TOOL_NAMES.has(toolName)
  ) {
    return false
  }

  if (isPlanDraftingCollaborationMode(collaborationMode)) {
    return PLAN_DRAFTING_ALLOWED_TOOLS.has(toolName)
  }

  if (isPlanAwaitingApprovalCollaborationMode(collaborationMode)) {
    return PLAN_AWAITING_APPROVAL_ALLOWED_TOOLS.has(toolName)
  }

  if (isPlanCollaborationMode(collaborationMode)) {
    return false
  }

  return true
}
