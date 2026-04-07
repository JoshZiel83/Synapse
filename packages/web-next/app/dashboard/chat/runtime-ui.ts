"use client"

import type { ActorRuntimeState } from "@synapse/shared"
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

export function getRuntimeLabel(runtime?: ActorRuntimeState) {
  if (!runtime) return undefined
  if (runtime.health === "error" || runtime.laneState === "blocked") {
    return "Error"
  }
  if (runtime.laneState === "running") return "Working"
  if (runtime.laneState === "queued") return "Queued"
  return "Idle"
}

export function getRuntimeDetail(runtime?: ActorRuntimeState) {
  if (!runtime) return undefined
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
