import type { AvailableSkillSummary } from "@synapse/shared"

function skillDiscoveryPriority(skill: AvailableSkillSummary) {
  const slug = skill.slug.trim().toLowerCase()
  if (
    skill.sourceKind === "relay_auto_loaded" &&
    !slug.startsWith("cli-anything-")
  ) {
    return 0
  }
  if (skill.sourceKind !== "relay_auto_loaded") {
    return 1
  }
  return 2
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
