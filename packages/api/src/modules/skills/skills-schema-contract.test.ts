import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { SUBJECT_KIND } from "@synapse/shared"
import {
  ImportMarketplaceSkillInputSchema,
  InstalledSkillItemViewSchema,
  InstalledSkillListQuerySchema,
  InstalledSkillListViewSchema,
  PublishMarketplaceSkillInputSchema,
  SkillFrontmatterSchema,
  SkillMarketplaceItemQuerySchema,
  SkillMarketplaceItemViewSchema,
  SkillMarketplaceListQuerySchema,
  SkillMirrorSourceSummarySchema,
} from "@synapse/shared/schemas"
import {
  presentInstalledSkillRecord,
  type InstalledSkillPresentationRecord,
} from "./presenter.js"

const NOW = "2026-06-13T00:00:00.000Z"

function uuid() {
  return crypto.randomUUID()
}

function textBlock(text = "Run the project checklist") {
  return {
    id: uuid(),
    type: "text",
    text,
  }
}

function frontmatter(overrides: Record<string, unknown> = {}) {
  return {
    name: "Project Checklist",
    description: "Run through the project checklist.",
    disableModelInvocation: false,
    userInvocable: true,
    allowedTools: ["shell"],
    hooks: {},
    ...overrides,
  }
}

function attachmentFile(overrides: Record<string, unknown> = {}) {
  return {
    id: "snapshot:entry",
    path: "SKILL.md",
    mediaType: "text/markdown",
    contentBlocks: [textBlock("Skill instructions")],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function mirrorSource(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    sourceType: "github",
    locatorKey: "github:example/skills:skills/project-checklist",
    locator: {
      repoUrl: "https://github.com/example/skills",
      path: "skills/project-checklist",
    },
    requestedRef: "main",
    resolvedRevision: "abc123",
    refreshMode: "manual",
    lastSyncStatus: "synced",
    sourceWarnings: [],
    lastSyncedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function marketplaceSkill(overrides: Record<string, unknown> = {}) {
  const skillId = uuid()
  const versionId = uuid()
  const files = [attachmentFile()]

  return {
    id: skillId,
    slug: "project-checklist",
    name: "Project Checklist",
    frontmatter: frontmatter(),
    bodyBlocks: [textBlock()],
    description: textBlock("Checklist helper"),
    iconUrl: "/api/v1/files/icon",
    tags: ["project"],
    authorUserId: uuid(),
    authorName: "Example Author",
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    defaultConversationTypeMask: 15,
    latestVersionId: versionId,
    latestVersion: {
      id: versionId,
      skillId,
      version: "1.0.0",
      changelog: "Initial release",
      frontmatter: frontmatter(),
      bodyBlocks: [textBlock()],
      entryPath: "SKILL.md",
      contentHash: "sha256:demo",
      sourceWarnings: [],
      resolvedRevision: "abc123",
      description: textBlock("Checklist helper"),
      defaultConversationTypeMask: 15,
      createdByUserId: uuid(),
      createdAt: NOW,
      files,
      attachmentFiles: files,
    },
    mirrorSource: mirrorSource(),
    workspaceInstallation: {
      installed: true,
      installedSkillId: uuid(),
      installedCount: 1,
    },
    ...overrides,
  }
}

function installedSkill(overrides: Record<string, unknown> = {}) {
  const files = [attachmentFile()]
  return {
    id: uuid(),
    workspaceId: uuid(),
    displayName: "Project Checklist",
    frontmatter: frontmatter(),
    bodyBlocks: [textBlock()],
    entryPath: "SKILL.md",
    contentHash: "sha256:installed",
    sourceWarnings: [],
    description: textBlock("Installed checklist helper"),
    iconUrl: "/api/v1/files/icon",
    tags: ["project"],
    accessTarget: {
      subject: {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId: uuid(),
      },
    },
    isEnabled: true,
    sourceDefaultConversationTypeMask: 15,
    workspaceConversationTypeMask: 15,
    conversationTypeMaskOverride: 7,
    effectiveConversationTypeMask: 7,
    isCustomized: false,
    ownerWorkspaceMemberId: uuid(),
    createdAt: NOW,
    updatedAt: NOW,
    sourceSkillId: uuid(),
    sourcePackageSlug: "project-checklist",
    sourceVersionId: uuid(),
    sourceVersion: "1.0.0",
    upgradeAvailable: false,
    latestSourceVersion: "1.0.0",
    files,
    attachmentFiles: files,
    mirrorSource: mirrorSource(),
    ...overrides,
  }
}

test("PublishMarketplaceSkillInputSchema parses canonical content-block inputs", () => {
  const parsed = PublishMarketplaceSkillInputSchema.parse({
    skillId: crypto.randomUUID(),
    slug: "daily-summary",
    name: "Daily Summary",
    description: { type: "text", text: "Summarize today's work" },
    iconFileId: null,
    tags: ["productivity"],
    version: "1.0.0",
    changelog: "Initial release",
    isActive: true,
    defaultConversationTypeMask: 15,
    metadata: { source: "test" },
    attachmentFiles: [
      {
        path: "README.md",
        contentBlocks: [{ type: "text", text: "Usage notes" }],
        mediaType: "text/markdown",
      },
      {
        path: "empty.md",
      },
    ],
  })

  assert.equal(parsed.attachmentFiles?.[1]?.contentBlocks.length, 0)
})

test("PublishMarketplaceSkillInputSchema rejects invalid conversation type masks", () => {
  const result = PublishMarketplaceSkillInputSchema.safeParse({
    slug: "daily-summary",
    name: "Daily Summary",
    version: "1.0.0",
    defaultConversationTypeMask: 0,
  })

  assert.equal(result.success, false)
})

test("ImportMarketplaceSkillInputSchema parses both marketplace mirror sources", () => {
  assert.equal(
    ImportMarketplaceSkillInputSchema.safeParse({
      sourceType: "github",
      repoUrl: "https://github.com/example/skills",
      path: "skills/daily-summary",
      ref: "main",
    }).success,
    true
  )

  assert.equal(
    ImportMarketplaceSkillInputSchema.safeParse({
      sourceType: "clawhub",
      ownerId: "example",
      slug: "daily-summary",
      version: "1.0.0",
    }).success,
    true
  )
})

test("skill response schemas validate finite mirror and frontmatter enums", () => {
  assert.equal(
    SkillFrontmatterSchema.safeParse(
      frontmatter({
        effort: "extreme",
      })
    ).success,
    false
  )

  assert.equal(
    SkillMirrorSourceSummarySchema.safeParse(
      mirrorSource({
        sourceType: "gitlab",
      })
    ).success,
    false
  )

  assert.equal(
    SkillMirrorSourceSummarySchema.safeParse(
      mirrorSource({
        lastSyncStatus: "stale",
      })
    ).success,
    false
  )
})

test("SkillMarketplace query schemas parse app-facing filters", () => {
  const workspaceId = crypto.randomUUID()

  assert.deepEqual(
    SkillMarketplaceListQuerySchema.parse({
      search: " daily ",
      tags: "agent, productivity,, ",
      workspaceId,
    }),
    {
      search: "daily",
      tags: ["agent", "productivity"],
      workspaceId,
    }
  )
  assert.deepEqual(
    SkillMarketplaceListQuerySchema.parse({
      tags: ["agent", " productivity "],
    }).tags,
    ["agent", "productivity"]
  )
  assert.equal(
    SkillMarketplaceListQuerySchema.safeParse({ workspaceId: "not-a-uuid" })
      .success,
    false
  )

  assert.deepEqual(SkillMarketplaceItemQuerySchema.parse({ workspaceId }), {
    workspaceId,
  })
  assert.equal(
    SkillMarketplaceItemQuerySchema.safeParse({ workspaceId: "not-a-uuid" })
      .success,
    false
  )
})

test("InstalledSkillListQuerySchema validates shared capability filter inputs", () => {
  const workspaceMemberId = crypto.randomUUID()
  const sourceSkillId = crypto.randomUUID()

  assert.deepEqual(
    InstalledSkillListQuerySchema.parse({
      accessTargetType: "workspace_member",
      workspaceMemberId,
      sourceSkillId,
    }),
    {
      accessTargetType: "workspace_member",
      workspaceMemberId,
      sourceSkillId,
    }
  )

  assert.equal(
    InstalledSkillListQuerySchema.safeParse({
      accessTargetType: "workspace_member",
      workspace_member_id: workspaceMemberId,
    }).success,
    false
  )

  assert.equal(
    InstalledSkillListQuerySchema.safeParse({
      accessTargetType: "remote_agent",
      remoteAgentId: crypto.randomUUID(),
    }).success,
    true
  )

  assert.equal(
    InstalledSkillListQuerySchema.safeParse({
      accessTargetType: "remote_agent",
    }).success,
    false
  )

  assert.equal(
    InstalledSkillListQuerySchema.safeParse({
      accessTargetType: "team",
    }).success,
    false
  )
})

test("SkillMarketplaceItemViewSchema validates full marketplace skill payloads", () => {
  assert.equal(
    SkillMarketplaceItemViewSchema.safeParse({
      skill: marketplaceSkill(),
    }).success,
    true
  )
})

test("InstalledSkill response schemas validate full installed skill payloads", () => {
  const skill = installedSkill()

  assert.equal(
    InstalledSkillListViewSchema.safeParse({
      skills: [skill],
    }).success,
    true
  )
  assert.equal(
    InstalledSkillItemViewSchema.safeParse({
      skill,
    }).success,
    true
  )
})

test("presentInstalledSkillRecord output parses InstalledSkillItemViewSchema", () => {
  const skillId = uuid()
  const workspaceId = uuid()
  const snapshotId = uuid()
  const now = new Date(NOW)
  const record = {
    id: skillId,
    workspaceConversationTypeMask: 15,
    binding: undefined,
    files: [
      {
        id: uuid(),
        skillSnapshotId: snapshotId,
        path: "README.md",
        mediaType: "text/markdown",
        contentBlocks: [textBlock("Additional notes")],
        createdAt: now,
        updatedAt: now,
      },
    ],
    row: {
      skillId,
      workspaceId,
      displayName: "Project Checklist",
      iconFileId: null,
      tags: ["project"],
      currentVersion: 1,
      skillStatus: "active",
      conversationTypeMaskOverride: null,
      ownerWorkspaceMemberId: null,
      createdAt: now,
      updatedAt: now,
      currentSnapshotId: snapshotId,
      currentSkillVersionId: uuid(),
      currentSkillSnapshotId: snapshotId,
      versionMetadata: {},
      sourceCatalogItemId: null,
      sourceCatalogVersionId: null,
      sourceSyncMode: null,
      sourceIsCustomized: null,
      sourceSlug: null,
      sourceLatestVersionId: null,
      sourceVersionValue: null,
      latestSourceVersion: null,
      sourceDefaultConversationTypeMask: null,
      snapshotId,
      snapshotEntryPath: "SKILL.md",
      snapshotDisplayName: "Project Checklist",
      snapshotDescription: "Installed checklist helper",
      snapshotArgumentHint: null,
      snapshotDisableModelInvocation: false,
      snapshotUserInvocable: true,
      snapshotAllowedTools: ["shell"],
      snapshotModel: null,
      snapshotEffort: null,
      snapshotContext: null,
      snapshotAgent: null,
      snapshotHooks: {},
      snapshotBodyBlocks: [textBlock()],
      snapshotContentHash: "sha256:installed",
      snapshotSourceWarnings: [],
      snapshotResolvedRevision: null,
      snapshotCreatedAt: now,
      mirrorSourceId: null,
      mirrorSourceType: null,
      mirrorLocatorKey: null,
      mirrorLocator: {},
      mirrorRequestedRef: null,
      mirrorResolvedRevision: null,
      mirrorRefreshMode: null,
      mirrorLastSyncStatus: null,
      mirrorSourceWarnings: null,
      mirrorLastError: null,
      mirrorLastSyncedAt: null,
      mirrorCreatedAt: null,
      mirrorUpdatedAt: null,
    },
  } satisfies InstalledSkillPresentationRecord

  const skill = presentInstalledSkillRecord(record)

  assert.equal(InstalledSkillItemViewSchema.safeParse({ skill }).success, true)
  assert.equal(
    skill.files?.some((file) => file.path === "README.md"),
    true
  )
})

test("SkillMarketplaceItemViewSchema rejects invalid nested skill payloads", () => {
  const skill = marketplaceSkill({
    frontmatter: {
      name: "Project Checklist",
      description: "Missing required boolean fields",
      allowedTools: [],
    },
  })

  assert.equal(
    SkillMarketplaceItemViewSchema.safeParse({
      skill,
    }).success,
    false
  )
})
