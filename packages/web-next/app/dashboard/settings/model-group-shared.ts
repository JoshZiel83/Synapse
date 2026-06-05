"use client"

import {
  MODEL_GROUP_GRANT_SCOPE,
  MODEL_GROUP_OWNER_TYPE,
  MODEL_GROUP_ROUTING_STRATEGY,
  type ModelGroupGrantScope,
  type ModelGroupOwnerType,
  type ModelGroupRoutingStrategy,
} from "@synapse/shared"
import { Building2, Globe2, UserRound } from "lucide-react"

export type ModelGroupScope = ModelGroupOwnerType
export type ModelGroupScopeFilter = ModelGroupScope | "all"
export type ModelGroupScopeAuto = ModelGroupScope | "auto"

export type ModelGroupSummaryRecord = {
  workspace_id: string | null
  owner_type?: ModelGroupOwnerType
  routing_strategy: ModelGroupRoutingStrategy
}

export const MODEL_GROUP_ROUTING_OPTIONS: Array<{
  value: ModelGroupRoutingStrategy
  label: string
  desc?: string
}> = [
  {
    value: MODEL_GROUP_ROUTING_STRATEGY.PRIORITY_FAILOVER,
    label: "Priority Failover",
    desc: "Use highest-priority model, fall back on failure",
  },
  {
    value: MODEL_GROUP_ROUTING_STRATEGY.WEIGHTED_RANDOM,
    label: "Weighted Random",
    desc: "Randomly select by weight distribution",
  },
]

export function getModelGroupStrategyLabel(
  value: ModelGroupRoutingStrategy | string
) {
  switch (value) {
    case MODEL_GROUP_ROUTING_STRATEGY.WEIGHTED_RANDOM:
      return "Weighted Random"
    case MODEL_GROUP_ROUTING_STRATEGY.PRIORITY_FAILOVER:
      return "Priority Failover"
    default:
      return value
  }
}

export function resolveModelGroupScope(
  group: Pick<ModelGroupSummaryRecord, "owner_type" | "workspace_id">
): ModelGroupScope {
  if (
    group.owner_type === MODEL_GROUP_OWNER_TYPE.PLATFORM ||
    (!group.owner_type && !group.workspace_id)
  ) {
    return MODEL_GROUP_OWNER_TYPE.PLATFORM
  }
  if (group.owner_type === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER) {
    return MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER
  }
  return MODEL_GROUP_OWNER_TYPE.WORKSPACE
}

export function getModelGroupScopeMeta(scope: ModelGroupScope) {
  switch (scope) {
    case MODEL_GROUP_OWNER_TYPE.PLATFORM:
      return {
        label: "Platform",
        icon: Globe2,
        badgeClassName: "bg-blue-500/10 text-blue-400 border-blue-500/20",
      }
    case MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER:
      return {
        label: "Member",
        icon: UserRound,
        badgeClassName: "bg-violet-500/10 text-violet-400 border-violet-500/20",
      }
    default:
      return {
        label: "Workspace",
        icon: Building2,
        badgeClassName:
          "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
      }
  }
}

export function getModelGroupScopeLabel(scope: ModelGroupScope) {
  return getModelGroupScopeMeta(scope).label
}

export function getModelGroupGrantScopeLabel(scope: ModelGroupGrantScope) {
  switch (scope) {
    case MODEL_GROUP_GRANT_SCOPE.PLATFORM:
      return "platform"
    case MODEL_GROUP_GRANT_SCOPE.WORKSPACE:
      return "workspace"
    case MODEL_GROUP_GRANT_SCOPE.WORKSPACE_MEMBER:
      return "workspace member"
    case MODEL_GROUP_GRANT_SCOPE.ACTOR:
      return "actor"
    default:
      return scope
  }
}
