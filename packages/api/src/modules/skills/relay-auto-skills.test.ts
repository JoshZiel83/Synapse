import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  isRepoSubprojectInitialized,
  resolveRepoSubprojectPath,
} from "../../config/subprojects.js"
import {
  __resetRelayAutoSkillIndexCacheForTests,
  __setRelayAutoSkillManifestPathForTests,
  readRelayAutoLoadedSkill,
} from "./relay-auto-skills.js"

// These tests depend on submodules under subprojects/ being initialized
// (`git submodule update --init`). In lightweight worktrees that skip
// the submodule fetch, the manifest still resolves but the underlying
// files are missing; we skip the suite rather than emit false failures.
const SUBMODULES_READY =
  isRepoSubprojectInitialized("lark-cli") &&
  isRepoSubprojectInitialized("xiaohongshu-cli")

test.afterEach(async () => {
  __setRelayAutoSkillManifestPathForTests()
  __resetRelayAutoSkillIndexCacheForTests()
})

test(
  "readRelayAutoLoadedSkill resolves provider-prefixed child skill",
  { skip: !SUBMODULES_READY },
  async () => {
    const result = await readRelayAutoLoadedSkill({
      skillName: "lark-cli-lark-shared",
    })

    assert.ok(result)
    assert.equal(result.skill.slug, "lark-cli-lark-shared")
    assert.match(result.asset.textContent, /lark-cli|Lark CLI/i)
  }
)

test(
  "readRelayAutoLoadedSkill resolves single-directory provider skill",
  { skip: !SUBMODULES_READY },
  async () => {
    const result = await readRelayAutoLoadedSkill({
      skillName: "xiaohongshu-cli",
    })

    assert.ok(result)
    assert.equal(result.skill.slug, "xiaohongshu-cli")
    assert.match(result.asset.textContent, /xhs|Xiaohongshu/i)
  }
)

test(
  "readRelayAutoLoadedSkill skips broken child skill directories",
  { skip: !SUBMODULES_READY },
  async () => {
    const brokenDir = await mkdtemp(
      join(
        resolveRepoSubprojectPath("lark-cli", "skills"),
        "broken-auto-skill-"
      )
    )

    try {
      __resetRelayAutoSkillIndexCacheForTests()
      const result = await readRelayAutoLoadedSkill({
        skillName: "xiaohongshu-cli",
      })

      assert.ok(result)
      assert.equal(result.skill.slug, "xiaohongshu-cli")
    } finally {
      await rm(brokenDir, { recursive: true, force: true })
      __resetRelayAutoSkillIndexCacheForTests()
    }
  }
)

test(
  "relay auto skill cache retries after manifest load failure",
  { skip: !SUBMODULES_READY },
  async () => {
    const manifestPath = join(
      tmpdir(),
      `relay-auto-skills-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
    )

    __setRelayAutoSkillManifestPathForTests(manifestPath)
    await writeFile(manifestPath, "{", "utf8")

    const failed = await readRelayAutoLoadedSkill({
      skillName: "xiaohongshu-cli",
    })
    assert.equal(failed, null)

    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          version: 1,
          providers: [
            {
              slug: "xiaohongshu-cli",
              displayName: "Xiaohongshu CLI",
              subproject: "xiaohongshu-cli",
              capabilities: [
                {
                  slug: "xhs",
                  command: "xhs",
                },
              ],
              skillSource: {
                type: "single",
                path: ".",
                skillSlug: "xiaohongshu-cli",
                capabilitySlug: "xhs",
              },
            },
          ],
        },
        null,
        2
      )}\n`,
      "utf8"
    )

    const recovered = await readRelayAutoLoadedSkill({
      skillName: "xiaohongshu-cli",
    })
    assert.ok(recovered)
    assert.equal(recovered.skill.slug, "xiaohongshu-cli")

    await rm(manifestPath, { force: true })
  }
)
