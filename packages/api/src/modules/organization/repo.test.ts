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
    workspace_id: workspaceId,
    display_name: "Planner",
    role: "assistant",
    title: "Project planner",
    avatar_file_id: null,
    avatar_emoji: null,
    parent_id: null,
    can_represent_user: false,
    specialties: ["planning"],
    config: {},
    current_version: 1,
    is_active: true,
    is_public_shared: false,
    created_at: now,
    updated_at: now,
    current_actor_version_id: versionId,
    source_catalog_item_id: null,
    source_catalog_version_id: null,
    source_sync_mode: null,
    source_baseline_actor_version: null,
    source_created_at: null,
    source_updated_at: null,
    source_slug: null,
    source_display_name: null,
    source_latest_version_id: null,
    source_publisher_slug: null,
    source_publisher_display_name: null,
    source_imported_version: null,
    source_latest_version: null,
    ...overrides,
  }
}

function actorVersionRow(
  overrides: Partial<ActorVersionRow> = {}
): ActorVersionRow {
  return {
    id: versionId,
    actor_id: actorId,
    version: 2,
    previous_version_id: null,
    display_name: "Planner",
    role: "assistant",
    title: "Project planner",
    parent_id: null,
    can_represent_user: false,
    specialties: ["planning"],
    config: {},
    version_delta: null,
    created_by_workspace_member_id: null,
    source_type: "system",
    source_workspace_member_id: null,
    source_actor_id: null,
    source_session_id: null,
    source_turn_id: null,
    source_conversation_id: null,
    source_reason: null,
    created_at: now,
    ...overrides,
  }
}

function actorPackageRow(
  overrides: Partial<ActorPackageRow> = {}
): ActorPackageRow {
  return {
    package_id: packageId,
    package_workspace_id: null,
    package_slug: "planner",
    package_display_name: "Planner",
    package_icon_file_id: null,
    package_summary: "Planner actor",
    package_long_description: "Planner actor",
    package_source_kind: "builtin",
    package_visibility: "public",
    package_tags: ["planning"],
    package_download_count: 1,
    package_is_active: true,
    package_metadata: {},
    package_created_at: now,
    package_updated_at: now,
    publisher_id: publisherId,
    publisher_slug: "synapse",
    publisher_display_name: "Synapse",
    publisher_description: "Built in packages",
    publisher_owner_user_id: null,
    publisher_workspace_id: null,
    publisher_is_builtin: true,
    publisher_is_verified: true,
    publisher_created_at: now,
    publisher_updated_at: now,
    version_id: versionId,
    version_value: "1.0.0",
    version_status: "active",
    version_changelog: "",
    version_metadata: {},
    version_created_by_user_id: null,
    version_created_at: now,
    actor_role: "assistant",
    actor_display_name: "Planner",
    actor_avatar_file_id: null,
    actor_avatar_emoji: null,
    actor_title: "Project planner",
    actor_can_represent_user: false,
    actor_docs: [],
    actor_specialties: ["planning"],
    actor_config: {},
    actor_metadata: {},
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
      version_delta: JSON.stringify(
        delta
      ) as unknown as ActorVersionRow["version_delta"],
    })
  )

  assert.deepEqual(row.config, {
    model: "planner-large",
  })
  assert.deepEqual(row.version_delta, delta)

  const view = presentActorVersionRow(row, [])
  assert.deepEqual(view.snapshot.config, row.config)
  assert.deepEqual(view.delta, delta)
})

test("normalizeActorVersionRow fails closed on malformed version delta", () => {
  assert.equal(
    normalizeActorVersionRow(
      actorVersionRow({
        version_delta:
          "{not json" as unknown as ActorVersionRow["version_delta"],
      })
    ).version_delta,
    null
  )

  assert.equal(
    normalizeActorVersionRow(
      actorVersionRow({
        version_delta: JSON.stringify({
          fromVersion: 1,
          toVersion: "2",
          changes: "not-an-array",
          summary: [],
        }) as unknown as ActorVersionRow["version_delta"],
      })
    ).version_delta,
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
      package_metadata: JSON.stringify({
        featured: true,
      }) as unknown as ActorPackageRow["package_metadata"],
      version_metadata: JSON.stringify({
        channel: "stable",
        setupGuide: [],
        releaseNotes: [],
      }) as unknown as ActorPackageRow["version_metadata"],
      actor_config: JSON.stringify({
        model: "planner-large",
      }) as unknown as ActorPackageRow["actor_config"],
      actor_metadata: JSON.stringify({
        importedFrom: "seed",
      }) as unknown as ActorPackageRow["actor_metadata"],
    })
  )

  assert.deepEqual(row.package_metadata, {
    featured: true,
  })
  assert.deepEqual(row.version_metadata, {
    channel: "stable",
    setupGuide: [],
    releaseNotes: [],
  })
  assert.deepEqual(row.actor_config, {
    model: "planner-large",
  })
  assert.deepEqual(row.actor_metadata, {
    importedFrom: "seed",
  })

  const record = presentActorPackageRecord(row)
  assert.deepEqual(record.package.metadata, row.package_metadata)
  assert.deepEqual(record.manifest.actor.config, row.actor_config)
  assert.deepEqual(
    record.package.latestRevision?.metadata,
    row.version_metadata
  )
})
