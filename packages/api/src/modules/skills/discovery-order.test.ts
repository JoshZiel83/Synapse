import test from "node:test"
import assert from "node:assert/strict"
import type { AvailableSkillSummary } from "@synapse/shared"
import { sortAvailableSkillsForDiscovery } from "./discovery-order.js"

function buildSkill(slug: string): AvailableSkillSummary {
  return {
    instanceId: slug,
    packageId: slug,
    revisionId: `${slug}@test`,
    slug,
    name: slug,
    description: slug,
    version: "test",
    sourceKind: "installed",
    entryPoint: slug,
    accessTarget: { type: "workspace" },
  }
}

// Device-runtime v3 (PR #20+): the `relay_auto_loaded` source kind was
// removed alongside the relay subsystem. All installed skills now share the
// same discovery priority, so sort order is purely alphabetical by slug.
test("sortAvailableSkillsForDiscovery sorts installed skills alphabetically", () => {
  const sorted = sortAvailableSkillsForDiscovery([
    buildSkill("cli-anything-adguardhome"),
    buildSkill("custom-internal-skill"),
    buildSkill("xiaohongshu-cli"),
    buildSkill("discord-cli"),
  ])

  assert.deepEqual(
    sorted.map((skill) => skill.slug),
    [
      "cli-anything-adguardhome",
      "custom-internal-skill",
      "discord-cli",
      "xiaohongshu-cli",
    ]
  )
})
