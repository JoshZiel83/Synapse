"use client"

import type {
  ActorRuntimeState,
  RemoteAgentRuntimeState,
} from "@synapse/shared"
import {
  getActorRuntimeCurrentTool,
  getActorRuntimePriority,
  getActorRuntimeProcessingTargets,
  isActorRuntimeActive,
} from "@synapse/shared"

export {
  getActorRuntimePriority,
  isActorRuntimeActive,
} from "@synapse/shared"

function isActorRuntime(
  runtime: ActorRuntimeState | RemoteAgentRuntimeState | undefined
): runtime is ActorRuntimeState {
  return Boolean(runtime && "actorId" in runtime)
}

export function getRemoteAgentRuntimePriority(runtime?: RemoteAgentRuntimeState) {
  if (!runtime) return 120
  switch (runtime.state) {
    case "waiting_user_input":
    case "waiting_plan_approval":
      return 0
    case "plan_drafting":
      return 1
    case "running":
      return 2
    case "error":
      return 3
    case "idle":
      return 4
    case "offline":
    default:
      return 5
  }
}

export function getRuntimeLabel(
  runtime?: ActorRuntimeState | RemoteAgentRuntimeState
) {
  if (!runtime) return undefined
  if (!isActorRuntime(runtime)) {
    switch (runtime.state) {
      case "running":
        return "Working"
      case "waiting_user_input":
        return "Needs input"
      case "plan_drafting":
        return "Drafting plan"
      case "waiting_plan_approval":
        return "Needs approval"
      case "error":
        return "Error"
      case "offline":
        return "Offline"
      case "idle":
      default:
        return "Idle"
    }
  }
  if (runtime.health === "error" || runtime.laneState === "blocked") {
    return "Error"
  }
  if (runtime.laneState === "running") return "Working"
  if (runtime.laneState === "queued") return "Queued"
  return "Idle"
}

export function getRuntimeDetail(
  runtime?: ActorRuntimeState | RemoteAgentRuntimeState
) {
  if (!runtime) return undefined
  if (!isActorRuntime(runtime)) {
    if (runtime.lastError?.message) return runtime.lastError.message
    if (runtime.statusText) return runtime.statusText
    if (runtime.unreadDeliveryCount > 0) {
      return `${runtime.unreadDeliveryCount} unread message${runtime.unreadDeliveryCount === 1 ? "" : "s"}`
    }
    if (runtime.pendingConversationCount > 0) {
      return `${runtime.pendingConversationCount} active conversation${runtime.pendingConversationCount === 1 ? "" : "s"}`
    }
    return runtime.sessionId ? `Session ${runtime.sessionId}` : undefined
  }
  if (runtime.lastError?.message) return runtime.lastError.message

  const targets = getActorRuntimeProcessingTargets(runtime)
  if (targets.length > 0) {
    return targets
      .slice(0, 2)
      .map((target) => target.name)
      .filter(Boolean)
      .join(", ")
  }

  const tool = getActorRuntimeCurrentTool(runtime)
  if (tool?.displayDetail) return tool.displayDetail
  if (tool?.displayTitle) return tool.displayTitle

  if (runtime.statusText) return runtime.statusText
  if (runtime.pendingWakeupCount > 0) {
    return `${runtime.pendingWakeupCount} queued wakeup${runtime.pendingWakeupCount === 1 ? "" : "s"}`
  }
  return undefined
}

export function summarizeRuntimePreview(
  runtimeByActor?: Record<string, ActorRuntimeState>
) {
  const activeRuntimes = Object.values(runtimeByActor || {})
    .filter((runtime) => isActorRuntimeActive(runtime))
    .sort((left, right) => getActorRuntimePriority(left) - getActorRuntimePriority(right))

  if (activeRuntimes.length === 0) return null

  const names = activeRuntimes.map((runtime) => runtime.actorName)
  const lead = names.slice(0, 2).join(", ")
  const suffix = names.length > 2 ? ` +${names.length - 2}` : ""
  const blocked = activeRuntimes.find(
    (runtime) => runtime.health === "error" || runtime.laneState === "blocked"
  )
  if (blocked) {
    return `${lead}${suffix} · ${blocked.lastError?.message || "Needs attention"}`
  }

  const leadingTool = activeRuntimes
    .map((runtime) => getActorRuntimeCurrentTool(runtime))
    .find((tool) => Boolean(tool))
  if (leadingTool?.displayTitle) {
    return `${lead}${suffix} · ${leadingTool.displayTitle}`
  }

  const targetCount = activeRuntimes.reduce(
    (sum, runtime) =>
      sum +
      Math.max(getActorRuntimeProcessingTargets(runtime).length, runtime.pendingWakeupCount),
    0
  )
  if (targetCount > 0) {
    return `${lead}${suffix} · handling ${targetCount} message${targetCount === 1 ? "" : "s"}`
  }

  const statusText = activeRuntimes[0]?.statusText
  if (statusText) {
    return `${lead}${suffix} · ${statusText}`
  }

  return `${lead}${suffix} · working`
}
