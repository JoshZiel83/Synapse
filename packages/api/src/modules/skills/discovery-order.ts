import type { AvailableSkillSummary } from "@synapse/shared"

// Device-runtime v3 (PR #20+): the `relay_auto_loaded` source kind has been
// removed alongside the relay subsystem. All visible skills are now
// installed skills. The discovery order is purely alphabetical by display
// name, with instance id as a stable tiebreaker.
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
  const nameOrder = left.name.localeCompare(right.name)
  if (nameOrder !== 0) {
    return nameOrder
  }
  return left.instanceId.localeCompare(right.instanceId)
}

export function sortAvailableSkillsForDiscovery(
  skills: AvailableSkillSummary[]
) {
  return [...skills].sort(compareAvailableSkillDiscoveryOrder)
}
