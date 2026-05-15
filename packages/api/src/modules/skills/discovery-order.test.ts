import test from "node:test"
import assert from "node:assert/strict"
import type { AvailableSkillSummary } from "@synapse/shared"
import { sortAvailableSkillsForDiscovery } from "./discovery-order.js"

function buildSkill(
  slug: string,
  sourceKind: AvailableSkillSummary["sourceKind"]
): AvailableSkillSummary {
  return {
    instanceId: slug,
    packageId: slug,
    revisionId: `${slug}@test`,
    slug,
    name: slug,
    description: slug,
    version: "test",
    sourceKind,
    entryPoint: slug,
    accessTarget: { type: "workspace" },
  }
}

test("sortAvailableSkillsForDiscovery prioritizes non-cli-anything relay auto-loaded skills", () => {
  const sorted = sortAvailableSkillsForDiscovery([
    buildSkill("cli-anything-adguardhome", "relay_auto_loaded"),
    buildSkill("custom-internal-skill", "workspace_installed"),
    buildSkill("xiaohongshu-cli", "relay_auto_loaded"),
    buildSkill("discord-cli", "relay_auto_loaded"),
  ])

  assert.deepEqual(
    sorted.map((skill) => skill.slug),
    [
      "discord-cli",
      "xiaohongshu-cli",
      "custom-internal-skill",
      "cli-anything-adguardhome",
    ]
  )
})
