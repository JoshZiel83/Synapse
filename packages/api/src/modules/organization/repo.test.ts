import assert from "node:assert/strict"
import test from "node:test"
import type { ActorVersionDelta } from "@synapse/shared"
import {
  normalizeActorPackageRow,
  normalizeActorRow,
  normalizeActorVersionRow,
  parseActorDocContentBlocks,
} from "./repo.js"
import {
  presentActorPackageRecord,
  presentActorRow,
  presentActorVersionRow,
} from "./presenter.js"
import type {
  ActorPackageRow,
  ActorRow,
  ActorVersionRow,
} from "./repo.types.js"

const now = new Date("2026-06-14T00:00:00.000Z")
const actorId = "00000000-0000-4000-8000-000000000001"
const workspaceId = "00000000-0000-4000-8000-000000000002"
const packageId = "00000000-0000-4000-8000-000000000003"
const publisherId = "00000000-0000-4000-8000-000000000004"
const versionId = "00000000-0000-4000-8000-000000000005"

function actorRow(overrides: Partial<ActorRow> = {}): ActorRow {
  return {
    id: actorId,
    workspaceId: workspaceId,
    displayName: "Planner",
    role: "assistant",
    title: "Project planner",
    avatarFileId: null,
    avatarEmoji: null,
    parentId: null,
    canRepresentUser: false,
    specialties: ["planning"],
    config: {},
    currentVersion: 1,
    isActive: true,
    isPublicShared: false,
    createdAt: now,
    updatedAt: now,
    currentActorVersionId: versionId,
    sourceCatalogItemId: null,
    sourceCatalogVersionId: null,
    sourceSyncMode: null,
    sourceBaselineActorVersion: null,
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    sourceSlug: null,
    sourceDisplayName: null,
    sourceLatestVersionId: null,
    sourcePublisherSlug: null,
    sourcePublisherDisplayName: null,
    sourceImportedVersion: null,
    sourceLatestVersion: null,
    ...overrides,
  }
}

function actorVersionRow(
  overrides: Partial<ActorVersionRow> = {}
): ActorVersionRow {
  return {
    id: versionId,
    actorId: actorId,
    version: 2,
    previousVersionId: null,
    displayName: "Planner",
    role: "assistant",
    title: "Project planner",
    parentId: null,
    canRepresentUser: false,
    specialties: ["planning"],
    config: {},
    versionDelta: null,
    createdByWorkspaceMemberId: null,
    sourceType: "system",
    sourceWorkspaceMemberId: null,
    sourceActorId: null,
    sourceSessionId: null,
    sourceTurnId: null,
    sourceConversationId: null,
    sourceReason: null,
    createdAt: now,
    ...overrides,
  }
}

function actorPackageRow(
  overrides: Partial<ActorPackageRow> = {}
): ActorPackageRow {
  return {
    packageId: packageId,
    packageWorkspaceId: null,
    packageSlug: "planner",
    packageDisplayName: "Planner",
    packageIconFileId: null,
    packageSummary: "Planner actor",
    packageLongDescription: "Planner actor",
    packageSourceKind: "builtin",
    packageVisibility: "public",
    packageTags: ["planning"],
    packageDownloadCount: 1,
    packageIsActive: true,
    packageMetadata: {},
    packageCreatedAt: now,
    packageUpdatedAt: now,
    publisherId: publisherId,
    publisherSlug: "synapse",
    publisherDisplayName: "Synapse",
    publisherDescription: "Built in packages",
    publisherOwnerUserId: null,
    publisherWorkspaceId: null,
    publisherIsBuiltin: true,
    publisherIsVerified: true,
    publisherCreatedAt: now,
    publisherUpdatedAt: now,
    versionId: versionId,
    versionValue: "1.0.0",
    versionStatus: "active",
    versionChangelog: "",
    versionMetadata: {},
    versionCreatedByUserId: null,
    versionCreatedAt: now,
    actorRole: "assistant",
    actorDisplayName: "Planner",
    actorAvatarFileId: null,
    actorAvatarEmoji: null,
    actorTitle: "Project planner",
    actorCanRepresentUser: false,
    actorDocs: [],
    actorSpecialties: ["planning"],
    actorConfig: {},
    actorMetadata: {},
    ...overrides,
  }
}

test("normalizeActorRow decodes actor config at repo exit", () => {
  const row = normalizeActorRow(
    actorRow({
      config: JSON.stringify({
        model: "planner-large",
        temperature: 0.2,
      }) as unknown as ActorRow["config"],
    })
  )

  assert.deepEqual(row.config, {
    model: "planner-large",
    temperature: 0.2,
  })
  assert.deepEqual(presentActorRow(row, []).definition.config, row.config)
})

test("normalizeActorRow rejects non-object actor config drift", () => {
  assert.throws(
    () =>
      normalizeActorRow(
        actorRow({
          config: JSON.stringify([
            "not",
            "an",
            "object",
          ]) as unknown as ActorRow["config"],
        })
      ),
    /actor config must be a JSON object/
  )

  assert.throws(
    () =>
      normalizeActorRow(
        actorRow({
          config: "not-json" as unknown as ActorRow["config"],
        })
      ),
    /actor config must be valid JSON/
  )
})

test("normalizeActorVersionRow decodes config and delta at repo exit", () => {
  const delta: ActorVersionDelta = {
    fromVersion: 1,
    toVersion: 2,
    changes: [],
    summary: [],
  }
  const row = normalizeActorVersionRow(
    actorVersionRow({
      config: JSON.stringify({
        model: "planner-large",
      }) as unknown as ActorVersionRow["config"],
      versionDelta: JSON.stringify(
        delta
      ) as unknown as ActorVersionRow["versionDelta"],
    })
  )

  assert.deepEqual(row.config, {
    model: "planner-large",
  })
  assert.deepEqual(row.versionDelta, delta)

  const view = presentActorVersionRow(row, [])
  assert.deepEqual(view.snapshot.config, row.config)
  assert.deepEqual(view.delta, delta)
})

test("normalizeActorVersionRow rejects non-object config drift", () => {
  assert.throws(
    () =>
      normalizeActorVersionRow(
        actorVersionRow({
          config: "42" as unknown as ActorVersionRow["config"],
        })
      ),
    /actor version config must be a JSON object/
  )
})

test("normalizeActorVersionRow fails closed on malformed version delta", () => {
  assert.equal(
    normalizeActorVersionRow(
      actorVersionRow({
        versionDelta: "{not json" as unknown as ActorVersionRow["versionDelta"],
      })
    ).versionDelta,
    null
  )

  assert.equal(
    normalizeActorVersionRow(
      actorVersionRow({
        versionDelta: JSON.stringify({
          fromVersion: 1,
          toVersion: "2",
          changes: "not-an-array",
          summary: [],
        }) as unknown as ActorVersionRow["versionDelta"],
      })
    ).versionDelta,
    null
  )
})

test("parseActorDocContentBlocks decodes content block arrays at repo exit", () => {
  assert.deepEqual(
    parseActorDocContentBlocks('[{"type":"text","text":"Hi"}]'),
    [{ type: "text", text: "Hi" }]
  )
  assert.deepEqual(parseActorDocContentBlocks([{ type: "text", text: "Hi" }]), [
    { type: "text", text: "Hi" },
  ])
})

test("parseActorDocContentBlocks fails closed for malformed or non-array JSON", () => {
  assert.throws(
    () => parseActorDocContentBlocks('{"type":"text","text":"Hi"}'),
    /must be a JSON array/
  )
  assert.throws(
    () => parseActorDocContentBlocks('"text"'),
    /must be a JSON array/
  )
  assert.throws(
    () => parseActorDocContentBlocks("{"),
    /must be a valid JSON array/
  )
  assert.throws(
    () => parseActorDocContentBlocks([{ type: "text" }]),
    /must contain canonical content blocks/
  )
  assert.deepEqual(parseActorDocContentBlocks(null), [])
})

test("normalizeActorPackageRow decodes package JSON fields at repo exit", () => {
  const row = normalizeActorPackageRow(
    actorPackageRow({
      packageMetadata: JSON.stringify({
        featured: true,
      }) as unknown as ActorPackageRow["packageMetadata"],
      versionMetadata: JSON.stringify({
        channel: "stable",
        setupGuide: [],
        releaseNotes: [],
      }) as unknown as ActorPackageRow["versionMetadata"],
      actorConfig: JSON.stringify({
        model: "planner-large",
      }) as unknown as ActorPackageRow["actorConfig"],
      actorMetadata: JSON.stringify({
        importedFrom: "seed",
      }) as unknown as ActorPackageRow["actorMetadata"],
    })
  )

  assert.deepEqual(row.packageMetadata, {
    featured: true,
  })
  assert.deepEqual(row.versionMetadata, {
    channel: "stable",
    setupGuide: [],
    releaseNotes: [],
  })
  assert.deepEqual(row.actorConfig, {
    model: "planner-large",
  })
  assert.deepEqual(row.actorMetadata, {
    importedFrom: "seed",
  })

  const record = presentActorPackageRecord(row)
  assert.deepEqual(record.package.metadata, row.packageMetadata)
  assert.deepEqual(record.manifest.actor.config, row.actorConfig)
  assert.deepEqual(record.package.latestRevision?.metadata, row.versionMetadata)
})

test("normalizeActorPackageRow rejects non-object package JSON drift", () => {
  assert.throws(
    () =>
      normalizeActorPackageRow(
        actorPackageRow({
          packageMetadata: JSON.stringify([
            "not",
            "an",
            "object",
          ]) as unknown as ActorPackageRow["packageMetadata"],
        })
      ),
    /actor package metadata must be a JSON object/
  )

  assert.throws(
    () =>
      normalizeActorPackageRow(
        actorPackageRow({
          versionMetadata:
            "not-json" as unknown as ActorPackageRow["versionMetadata"],
        })
      ),
    /actor package version metadata must be valid JSON/
  )

  assert.throws(
    () =>
      normalizeActorPackageRow(
        actorPackageRow({
          actorConfig: "42" as unknown as ActorPackageRow["actorConfig"],
        })
      ),
    /actor package actor config must be a JSON object/
  )

  assert.throws(
    () =>
      normalizeActorPackageRow(
        actorPackageRow({
          actorMetadata: JSON.stringify([
            "not",
            "an",
            "object",
          ]) as unknown as ActorPackageRow["actorMetadata"],
        })
      ),
    /actor package actor metadata must be a JSON object/
  )
})

test("presentActorRow reads camelCase raw-SQL rows directly (convention A)", () => {
  // CamelCasePlugin.transformResult unconditionally camelCases raw
  // CompiledQuery.raw result rows, so the organization *Row types and presenter
  // read camelCase keys directly (no re-snake). Regression for the
  // GET /workspaces/:id/actors 500 ("Expected a valid Date when converting to
  // IsoInstantString"): the Date-valued createdAt/updatedAt must arrive under
  // their camelCase keys and reach serializeInstant intact. Nested JSONB keys
  // are NOT recursed (maintainNestedObjectKeys), so config keeps snake inner
  // keys untouched.
  const camelRow = actorRow({
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    isPublicShared: true,
    config: {
      is_chief_actor: true,
      nestedCamel: "keep",
    } as unknown as ActorRow["config"],
  })

  const actor = presentActorRow(normalizeActorRow(camelRow), [])

  assert.equal(actor.createdAt, "2026-01-01T00:00:00.000Z")
  assert.equal(actor.updatedAt, "2026-01-02T00:00:00.000Z")
  assert.equal(actor.workspaceId, workspaceId)
  assert.equal(actor.displayName, "Planner")
  assert.equal(actor.isPublicShared, true)
  // top-level only: JSONB value object is passed through untouched (its inner
  // keys are NOT recursed/rewritten).
  assert.deepEqual(actor.definition.config, {
    is_chief_actor: true,
    nestedCamel: "keep",
  })
})
