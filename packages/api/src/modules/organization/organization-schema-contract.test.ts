import assert from "node:assert/strict"
import test from "node:test"
import {
  SUBJECT_KIND,
  WORKSPACE_RESOURCE_GRANT_PERMISSION,
} from "@synapse/shared"
import {
  ActorListViewSchema,
  ActorPackageInitialGrantTargetSchema,
  ActorPackageInstallInputSchema,
  ActorPackageInstallResultViewSchema,
  ActorPackageListViewSchema,
  ActorPackageListQuerySchema,
  ActorPackageRecordViewSchema,
  ActorTreeViewSchema,
  ActorVersionListViewSchema,
  ActorVersionViewSchema,
} from "@synapse/shared/schemas"

const workspaceId = "00000000-0000-4000-8000-000000000001"
const conversationId = "00000000-0000-4000-8000-000000000002"
const packageId = "00000000-0000-4000-8000-000000000003"
const publisherId = "00000000-0000-4000-8000-000000000004"
const actorId = "00000000-0000-4000-8000-000000000005"
const revisionId = "00000000-0000-4000-8000-000000000006"
const assetId = "00000000-0000-4000-8000-000000000008"
const NOW = "2026-06-14T00:00:00.000Z"

function textBlock(text: string) {
  return {
    type: "text",
    text,
  }
}

function actorDefinition() {
  return {
    displayName: "Package Actor",
    role: "assistant",
    title: "Research helper",
    canRepresentUser: false,
    docs: [
      {
        id: "00000000-0000-4000-8000-000000000007",
        key: "mission",
        title: "Mission",
        content: [textBlock("Help with research.")],
        visibility: "always",
        priority: 0,
      },
    ],
    specialties: ["research"],
    config: {},
  }
}

function actorPackageRecord(overrides: Record<string, unknown> = {}) {
  const actor = actorDefinition()
  const manifest = {
    actor,
    setupGuide: [textBlock("Install and configure.")],
    releaseNotes: [textBlock("Initial release.")],
  }

  return {
    package: {
      id: packageId,
      publisherId,
      kind: "actor",
      slug: "package-actor",
      displayName: "Package Actor",
      description: "A packaged actor.",
      longDescription: "A packaged actor for research workflows.",
      sourceType: "official",
      tags: ["research"],
      isActive: true,
      isBuiltin: false,
      downloadCount: 0,
      latestRevisionId: revisionId,
      defaultReuseScope: "workspace",
      requiresHandshake: false,
      metadata: {},
      createdAt: NOW,
      updatedAt: NOW,
      publisher: {
        id: publisherId,
        slug: "official",
        displayName: "Official",
        description: "Official publisher",
        isBuiltin: true,
        isVerified: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
      latestRevision: {
        id: revisionId,
        packageId,
        version: "1.0.0",
        status: "active",
        manifest: {
          kind: "actor",
          actorPackage: manifest,
        },
        configSchema: {},
        configFields: [],
        defaultConfig: {},
        toolsManifest: [],
        validationRules: [],
        setupSteps: [],
        authBindings: [],
        metadata: {},
        createdAt: NOW,
        assets: [],
      },
    },
    manifest,
    dependencies: [
      {
        requirementKind: "required",
        targetPackageKind: "plugin",
        targetPackageSlug: "web-search",
        acceptableReuseScopes: ["workspace"],
        description: "Needs web search.",
        notes: [textBlock("Install a web-search plugin.")],
        metadata: {},
      },
    ],
    requirementChecks: [
      {
        requirementId: "web-search",
        requirementKind: "required",
        status: "satisfied",
        message: "Installed",
        matchedInstanceIds: [],
      },
    ],
    ...overrides,
  }
}

function actorPackageRecordWithLatestRevision(
  latestRevision: Record<string, unknown>
) {
  const record = actorPackageRecord()
  return {
    ...record,
    package: {
      ...record.package,
      latestRevision: {
        ...record.package.latestRevision,
        ...latestRevision,
      },
    },
  }
}

function actorView() {
  return {
    id: actorId,
    workspaceId,
    displayName: "Package Actor",
    definition: actorDefinition(),
    currentVersion: 1,
    sourceLink: actorPackageSourceLink(),
    isActive: true,
    isPublicShared: false,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function actorVersionView(overrides: Record<string, unknown> = {}) {
  return {
    id: revisionId,
    actorId,
    version: 2,
    previousVersionId: "00000000-0000-4000-8000-000000000009",
    snapshot: actorDefinition(),
    delta: {
      fromVersion: 1,
      toVersion: 2,
      source: {
        type: "workspace_member",
        workspaceMemberId: "00000000-0000-4000-8000-000000000010",
        reason: "Updated title",
      },
      changes: [
        {
          kind: "field",
          field: "title",
          before: "Research helper",
          after: "Research lead",
          summary: [textBlock("Changed title.")],
        },
        {
          kind: "doc",
          docId: "00000000-0000-4000-8000-000000000011",
          key: "mission",
          title: "Mission",
          changeType: "updated",
          visibility: "always",
          priority: 0,
          fieldChanges: [
            {
              field: "content",
              beforeSummaryText: "Old mission",
              afterSummaryText: "New mission",
            },
          ],
          summary: [textBlock("Updated mission.")],
        },
      ],
      summary: [textBlock("Updated title and mission.")],
    },
    createdByWorkspaceMemberId: "00000000-0000-4000-8000-000000000010",
    source: {
      type: "workspace_member",
      workspaceMemberId: "00000000-0000-4000-8000-000000000010",
    },
    createdAt: NOW,
    ...overrides,
  }
}

function actorPackageSourceLink() {
  return {
    actorId,
    packageId,
    importedRevisionId: revisionId,
    packageSlug: "package-actor",
    packageDisplayName: "Package Actor",
    importedVersion: "1.0.0",
    baselineActorVersion: 1,
    syncMode: "notify",
    hasLocalChanges: false,
    hasUpstreamUpdate: false,
    status: "up_to_date",
    createdAt: NOW,
    updatedAt: NOW,
  }
}

test("ActorPackageListQuerySchema parses app-facing search filter", () => {
  assert.deepEqual(ActorPackageListQuerySchema.parse({ search: " scout " }), {
    search: "scout",
  })
  assert.deepEqual(ActorPackageListQuerySchema.parse({}), {})
  assert.equal(
    ActorPackageListQuerySchema.safeParse({ search: "" }).success,
    false
  )
  assert.equal(
    ActorPackageListQuerySchema.safeParse({ search: ["scout"] }).success,
    false
  )
})

test("ActorPackageInstallInputSchema accepts the app install request body", () => {
  const parsed = ActorPackageInstallInputSchema.safeParse({
    displayName: "Helper Actor",
    title: "Support",
    parentId: null,
    syncMode: "manual_merge",
    grants: [
      {
        target: {
          subject: {
            kind: SUBJECT_KIND.WORKSPACE,
            workspaceId,
          },
          scope: {
            kind: SUBJECT_KIND.CONVERSATION,
            conversationId,
          },
        },
        permissions: [WORKSPACE_RESOURCE_GRANT_PERMISSION.MANAGE],
        conversationTypeMaskOverride: 15,
        reason: "Seed package access",
      },
    ],
  })

  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("ActorPackageInstallInputSchema accepts an empty install body", () => {
  assert.ok(ActorPackageInstallInputSchema.safeParse({}).success)
})

test("ActorPackageInstallInputSchema rejects invalid grants and sync modes", () => {
  assert.equal(
    ActorPackageInstallInputSchema.safeParse({
      syncMode: "auto_apply",
    }).success,
    false
  )

  assert.equal(
    ActorPackageInstallInputSchema.safeParse({
      grants: [
        {
          target: {
            subject: {
              kind: SUBJECT_KIND.WORKSPACE,
              workspaceId,
            },
          },
          permissions: [],
        },
      ],
    }).success,
    false
  )
})

test("ActorPackageInitialGrantTargetSchema rejects snake_case subject fields", () => {
  assert.equal(
    ActorPackageInitialGrantTargetSchema.safeParse({
      subject: {
        kind: SUBJECT_KIND.WORKSPACE,
        workspace_id: workspaceId,
      },
    }).success,
    false
  )
})

test("ActorPackageRecordViewSchema validates package response structure", () => {
  assert.equal(
    ActorPackageRecordViewSchema.safeParse(actorPackageRecord()).success,
    true
  )
})

test("organization list response containers validate app route values", () => {
  assert.ok(ActorListViewSchema.safeParse([actorView()]).success)
  assert.ok(
    ActorTreeViewSchema.safeParse([
      {
        ...actorView(),
        children: [{ ...actorView(), children: [] }],
      },
    ]).success
  )
  assert.ok(
    ActorPackageListViewSchema.safeParse([actorPackageRecord()]).success
  )
  assert.ok(ActorVersionListViewSchema.safeParse([actorVersionView()]).success)

  assert.equal(ActorListViewSchema.safeParse({ actors: [] }).success, false)
  assert.equal(
    ActorPackageListViewSchema.safeParse({ packages: [] }).success,
    false
  )
  assert.equal(
    ActorVersionListViewSchema.safeParse({ versions: [] }).success,
    false
  )
})

test("ActorPackageRecordViewSchema validates marketplace version nested fields", () => {
  const installStep = {
    id: "configure",
    kind: "form",
    titleI18n: { en: "Configure" },
    scope: "plugin",
    fields: ["apiKey"],
  }
  const parsed = ActorPackageRecordViewSchema.safeParse(
    actorPackageRecordWithLatestRevision({
      configFields: [
        {
          key: "apiKey",
          type: "secret",
          titleI18n: { en: "API key" },
          required: true,
          secret: true,
        },
      ],
      toolsManifest: [
        {
          name: "search",
          description: "Search documents",
          inputSchema: { type: "object" },
        },
      ],
      validationRules: [
        {
          field: "apiKey",
          rule: "required",
          message: "API key is required",
        },
      ],
      setupSteps: [installStep],
      installFlow: {
        steps: [installStep],
      },
      transport: "stdio",
      authBindings: [
        {
          key: "oauth",
          driver: "oauth2_authorization_code_pkce",
          fieldKey: "account",
          displayNameI18n: { en: "OAuth account" },
          inputs: {
            clientId: {
              source: "config",
              field: "clientId",
            },
          },
        },
      ],
      assets: [
        {
          id: assetId,
          revisionId,
          path: "README.md",
          assetKind: "text",
          sizeBytes: 128,
          sha256: "sha256:abc",
          metadata: {},
          createdAt: NOW,
        },
      ],
    })
  )

  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("ActorVersionViewSchema validates actor version delta and source", () => {
  const parsed = ActorVersionViewSchema.safeParse(actorVersionView())
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("organization app schemas reject unknown finite enum values", () => {
  assert.equal(
    ActorPackageRecordViewSchema.safeParse(
      actorPackageRecord({
        package: {
          ...actorPackageRecord().package,
          kind: "workflow",
        },
      })
    ).success,
    false
  )

  assert.equal(
    ActorPackageRecordViewSchema.safeParse(
      actorPackageRecord({
        package: {
          ...actorPackageRecord().package,
          sourceType: "external_registry",
        },
      })
    ).success,
    false
  )

  assert.equal(
    ActorPackageRecordViewSchema.safeParse(
      actorPackageRecordWithLatestRevision({
        status: "published",
      })
    ).success,
    false
  )

  assert.equal(
    ActorPackageRecordViewSchema.safeParse(
      actorPackageRecord({
        dependencies: [
          {
            ...actorPackageRecord().dependencies[0],
            requirementKind: "optional",
          },
        ],
      })
    ).success,
    false
  )

  assert.equal(
    ActorPackageInstallResultViewSchema.safeParse({
      actor: actorView(),
      sourcePackage: actorPackageRecord(),
      sourceLink: {
        ...actorPackageSourceLink(),
        status: "synced",
      },
      requirementChecks: [],
    }).success,
    false
  )

  assert.equal(
    ActorVersionViewSchema.safeParse(
      actorVersionView({
        delta: {
          ...actorVersionView().delta,
          changes: [
            {
              ...actorVersionView().delta.changes[1],
              changeType: "renamed",
            },
          ],
        },
      })
    ).success,
    false
  )
})

test("ActorPackageInstallResultViewSchema validates install result structure", () => {
  assert.equal(
    ActorPackageInstallResultViewSchema.safeParse({
      actor: actorView(),
      sourcePackage: actorPackageRecord(),
      sourceLink: actorPackageSourceLink(),
      requirementChecks: [],
    }).success,
    true
  )
})

test("ActorPackage response schemas reject malformed nested structures", () => {
  assert.equal(
    ActorPackageRecordViewSchema.safeParse(
      actorPackageRecord({
        manifest: {
          actor: {
            displayName: "Missing role",
          },
          setupGuide: [],
          releaseNotes: [],
        },
      })
    ).success,
    false
  )

  assert.equal(
    ActorPackageInstallResultViewSchema.safeParse({
      actor: actorView(),
      sourcePackage: actorPackageRecord(),
      sourceLink: {
        ...actorPackageSourceLink(),
        syncMode: "follow_upstream",
      },
      requirementChecks: [],
    }).success,
    false
  )

  assert.equal(
    ActorPackageRecordViewSchema.safeParse(
      actorPackageRecordWithLatestRevision({
        configFields: [
          {
            key: "apiKey",
            type: "not_a_field_type",
            titleI18n: { en: "API key" },
          },
        ],
      })
    ).success,
    false
  )

  assert.equal(
    ActorPackageRecordViewSchema.safeParse(
      actorPackageRecordWithLatestRevision({
        transport: "filesystem",
      })
    ).success,
    false
  )

  assert.equal(
    ActorPackageRecordViewSchema.safeParse(
      actorPackageRecordWithLatestRevision({
        assets: [
          {
            id: assetId,
            revisionId,
            path: "icon.png",
            assetKind: "image",
            sizeBytes: 128,
            sha256: "sha256:abc",
            metadata: {},
            createdAt: NOW,
          },
        ],
      })
    ).success,
    false
  )

  assert.equal(
    ActorVersionViewSchema.safeParse(
      actorVersionView({
        delta: {
          fromVersion: 1,
          toVersion: 2,
          changes: [
            {
              kind: "field",
              field: "unknown_field",
              summary: [],
            },
          ],
          summary: [],
        },
      })
    ).success,
    false
  )

  assert.equal(
    ActorVersionViewSchema.safeParse(
      actorVersionView({
        source: {
          type: "manual",
        },
      })
    ).success,
    false
  )
})
