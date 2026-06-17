import assert from "node:assert/strict"
import test from "node:test"
import {
  decodeInstalledSkillVersionMetadata,
  decodeSkillMirrorLocator,
  decodeSkillPackageItemMetadata,
  decodeSkillSnapshotHooks,
  normalizeInstalledSkillRow,
  normalizeSkillPackageRow,
} from "./repo.js"
import type {
  InstalledSkillRow,
  SkillPackageRow,
  SkillSnapshotJoinRow,
} from "./repo.types.js"

test("decodeSkillSnapshotHooks decodes snapshot hooks at repo exit", () => {
  const hooks = decodeSkillSnapshotHooks({
    snapshotHooks: JSON.stringify({ before: ["prepare"] }),
  })

  assert.deepEqual(hooks, { before: ["prepare"] })
})

test("decodeSkillSnapshotHooks rejects malformed snapshot hooks at repo exit", () => {
  assert.throws(
    () => decodeSkillSnapshotHooks({ snapshotHooks: "not json" }),
    /skill snapshot hooks must be valid JSON/
  )
})

test("decodeSkillMirrorLocator preserves mirror locator fields", () => {
  const locator = decodeSkillMirrorLocator({
    mirrorLocator: {
      repoUrl: "https://github.com/example/skill",
      path: "skills/demo",
    },
  } as Pick<SkillSnapshotJoinRow, "mirrorLocator">)

  assert.deepEqual(locator, {
    repoUrl: "https://github.com/example/skill",
    path: "skills/demo",
  })
})

test("decodeSkillMirrorLocator rejects non-object mirror locators at repo exit", () => {
  assert.throws(
    () =>
      decodeSkillMirrorLocator({
        mirrorLocator: JSON.stringify(["not-object"]),
      }),
    /skill mirror locator must be a JSON object/
  )
})

test("decodeSkillPackageItemMetadata handles absent marketplace metadata", () => {
  assert.deepEqual(decodeSkillPackageItemMetadata(undefined), {})
})

test("decodeInstalledSkillVersionMetadata decodes version metadata", () => {
  const metadata = decodeInstalledSkillVersionMetadata({
    versionMetadata: JSON.stringify({ importedFrom: "marketplace" }),
  })

  assert.deepEqual(metadata, { importedFrom: "marketplace" })
})

test("decodeInstalledSkillVersionMetadata rejects scalar version metadata at repo exit", () => {
  assert.throws(
    () =>
      decodeInstalledSkillVersionMetadata({
        versionMetadata: JSON.stringify(42),
      }),
    /installed skill version metadata must be a JSON object/
  )
})

test("decodeSkillPackageItemMetadata accepts row-shaped metadata", () => {
  const metadata = decodeSkillPackageItemMetadata({
    itemMetadata: { canonicalSlug: "demo-skill" },
  } as Pick<SkillPackageRow, "itemMetadata">)

  assert.deepEqual(metadata, { canonicalSlug: "demo-skill" })
})

test("normalizeSkillPackageRow decodes marketplace JSON fields at repo exit", () => {
  const row = normalizeSkillPackageRow({
    snapshotHooks: JSON.stringify({ before: ["prepare"] }),
    mirrorLocator: JSON.stringify({
      repoUrl: "https://github.com/example/skill",
      path: "skills/demo",
    }),
    itemMetadata: JSON.stringify({ canonicalSlug: "demo-skill" }),
  } as unknown as SkillPackageRow)

  assert.deepEqual(row.snapshotHooks, { before: ["prepare"] })
  assert.deepEqual(row.mirrorLocator, {
    repoUrl: "https://github.com/example/skill",
    path: "skills/demo",
  })
  assert.deepEqual(row.itemMetadata, { canonicalSlug: "demo-skill" })
})

test("normalizeInstalledSkillRow decodes installed skill JSON fields at repo exit", () => {
  const row = normalizeInstalledSkillRow({
    snapshotHooks: JSON.stringify({ after: ["cleanup"] }),
    mirrorLocator: JSON.stringify({ ownerId: "synapse", slug: "demo" }),
    versionMetadata: JSON.stringify({ importedFrom: "marketplace" }),
  } as unknown as InstalledSkillRow)

  assert.deepEqual(row.snapshotHooks, { after: ["cleanup"] })
  assert.deepEqual(row.mirrorLocator, { ownerId: "synapse", slug: "demo" })
  assert.deepEqual(row.versionMetadata, { importedFrom: "marketplace" })
})
