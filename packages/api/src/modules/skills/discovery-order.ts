import type { AvailableSkillSummary } from "@synapse/shared"

// Device-runtime v3 (PR #20+): the `relay_auto_loaded` source kind has been
// removed alongside the relay subsystem. All visible skills are now
// installed skills. The discovery order is purely alphabetical by slug
// (cli-anything-* aliases of installed skills already share that prefix).
function skillDiscoveryPriority(_skill: AvailableSkillSummary) {
  return 0
}

export function compareAvailableSkillDiscoveryOrder(
  left: AvailableSkillSummary,
  right: AvailableSkillSummary
) {
  const leftPriority = skillDiscoveryPriority(left)
  const rightPriority = skillDiscoveryPriority(right)
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority
  }
  return left.slug.localeCompare(right.slug)
}

export function sortAvailableSkillsForDiscovery(
  skills: AvailableSkillSummary[]
) {
  return [...skills].sort(compareAvailableSkillDiscoveryOrder)
}
