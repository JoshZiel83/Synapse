import assert from "node:assert/strict"
import test from "node:test"
import {
  ActorModelGroupAssignmentListViewSchema,
  ModelBindingFeaturesInputSchema,
  ModelBindingFeaturesSchema,
  ActorModelGroupSetInputSchema,
  ModelGroupCreateInputSchema,
  ModelGroupDetailViewSchema,
  ModelGroupGrantIssueInputSchema,
  ModelGroupGrantListViewSchema,
  ModelGroupItemCreateInputSchema,
  ModelGroupItemVersionListViewSchema,
  ModelGroupListViewSchema,
  ModelGroupViewSchema,
} from "@synapse/shared/schemas"

const workspaceId = "00000000-0000-4000-8000-000000000001"
const workspaceMemberId = "00000000-0000-4000-8000-000000000002"
const groupId = "00000000-0000-4000-8000-000000000003"
const actorId = "00000000-0000-4000-8000-000000000004"
const bindingId = "00000000-0000-4000-8000-000000000005"
const itemId = "00000000-0000-4000-8000-000000000006"
const versionId = "00000000-0000-4000-8000-000000000007"
const grantId = "00000000-0000-4000-8000-000000000008"
const isoNow = "2026-06-14T00:00:00.000Z"

const groupView = {
  id: groupId,
  ownerType: "workspace",
  ownerWorkspaceId: workspaceId,
  ownerWorkspaceMemberId: null,
  workspaceId,
  scope: "workspace",
  name: "Workspace Models",
  description: "Default model failover chain",
  routingStrategy: "priority_failover",
  attemptPolicy: { maxAttemptsTotal: 3 },
  isDefault: true,
  isActive: true,
  createdByWorkspaceMemberId: workspaceMemberId,
  createdAt: isoNow,
  updatedAt: isoNow,
}

const itemView = {
  id: itemId,
  groupId,
  bindingId,
  currentVersionId: versionId,
  displayName: "Claude Sonnet",
  priority: 0,
  weight: 100,
  isEnabled: true,
  version: 1,
  providerKind: "anthropic",
  vendor: "anthropic",
  baseUrl: "https://api.anthropic.com",
  modelName: "claude-sonnet-4-20250514",
  maxOutputTokens: 4096,
  capabilityTags: ["chat"],
  features: { apiStyle: "chat" },
  providerOptions: {},
  requestTimeoutMs: 60_000,
  maxRetries: 2,
  createdAt: isoNow,
  updatedAt: isoNow,
}

const grantView = {
  id: grantId,
  groupId,
  grantScope: "workspace",
  workspaceId,
  workspaceMemberId: null,
  actorId: null,
  status: "active",
  createdByWorkspaceMemberId: workspaceMemberId,
  reason: "Workspace default",
  createdAt: isoNow,
  revokedAt: null,
}

test("ModelGroupCreateInputSchema accepts app create bodies", () => {
  const parsed = ModelGroupCreateInputSchema.safeParse({
    name: "Workspace Models",
    description: "Default model failover chain",
    routingStrategy: "priority_failover",
    attemptPolicy: {
      maxAttemptsTotal: 3,
      customPolicyKey: true,
    },
    isDefault: true,
  })

  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("ModelGroupItemCreateInputSchema validates provider and vendor fields", () => {
  const parsed = ModelGroupItemCreateInputSchema.safeParse({
    displayName: "Claude Sonnet",
    providerKind: "anthropic",
    vendor: "anthropic",
    apiKey: "sk-test",
    baseUrl: "https://api.anthropic.com",
    modelName: "claude-sonnet-4-20250514",
    features: {
      apiStyle: "chat",
      serverTools: ["web_search"],
    },
  })

  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  assert.equal(
    ModelGroupItemCreateInputSchema.safeParse({
      displayName: "Unknown",
      vendor: "not-a-vendor",
      apiKey: "sk-test",
      baseUrl: "https://example.com",
      modelName: "unknown",
    }).success,
    false
  )
})

test("ModelBindingFeatures schemas validate finite API style and server tools", () => {
  assert.ok(
    ModelBindingFeaturesSchema.safeParse({
      apiStyle: "responses",
      serverTools: ["web_search", "web_fetch"],
    }).success
  )
  assert.ok(
    ModelBindingFeaturesInputSchema.safeParse({
      apiStyle: "chat",
      serverTools: ["web_search"],
    }).success
  )

  assert.equal(
    ModelBindingFeaturesSchema.safeParse({
      apiStyle: "legacy_completions",
    }).success,
    false
  )
  assert.equal(
    ModelBindingFeaturesInputSchema.safeParse({
      serverTools: ["browser_search"],
    }).success,
    false
  )
})

test("ActorModelGroupSetInputSchema rejects snake_case group fields", () => {
  assert.equal(
    ActorModelGroupSetInputSchema.safeParse({
      groups: [{ group_id: groupId, priority: 1 }],
    }).success,
    false
  )

  assert.ok(
    ActorModelGroupSetInputSchema.safeParse({
      groups: [{ groupId, priority: 1 }],
    }).success
  )
})

test("ModelGroupGrantIssueInputSchema validates shared grant scope body", () => {
  assert.ok(
    ModelGroupGrantIssueInputSchema.safeParse({
      grantScope: "workspace",
      workspaceId,
      reason: "Workspace default",
    }).success
  )

  assert.equal(
    ModelGroupGrantIssueInputSchema.safeParse({
      grantScope: "team",
    }).success,
    false
  )
})

test("ModelGroupViewSchema is the strict create response contract", () => {
  assert.ok(ModelGroupViewSchema.safeParse(groupView).success)

  assert.equal(
    ModelGroupViewSchema.safeParse({
      ...groupView,
      items: [],
      grants: [],
    }).success,
    false
  )

  assert.equal(
    ModelGroupViewSchema.safeParse({
      ...groupView,
      owner_type: "workspace",
    }).success,
    false
  )
})

test("model group list/detail/grant/version route schemas validate app payloads", () => {
  assert.ok(ModelGroupListViewSchema.safeParse([groupView]).success)
  assert.ok(ModelGroupGrantListViewSchema.safeParse([grantView]).success)
  assert.ok(
    ModelGroupItemVersionListViewSchema.safeParse([
      {
        id: versionId,
        bindingId,
        version: 1,
        providerKind: "anthropic",
        vendor: "anthropic",
        baseUrl: "https://api.anthropic.com",
        modelName: "claude-sonnet-4-20250514",
        maxOutputTokens: 4096,
        capabilityTags: ["chat"],
        features: { apiStyle: "chat" },
        providerOptions: {},
        requestTimeoutMs: 60_000,
        maxRetries: 2,
        createdAt: isoNow,
      },
    ]).success
  )
  assert.ok(
    ModelGroupDetailViewSchema.safeParse({
      ...groupView,
      items: [itemView],
      grants: [grantView],
    }).success
  )

  assert.equal(
    ModelGroupDetailViewSchema.safeParse({
      ...groupView,
      items: [{ ...itemView, providerKind: "custom_runtime" }],
      grants: [grantView],
    }).success,
    false
  )

  assert.equal(
    ModelGroupItemVersionListViewSchema.safeParse([
      {
        id: versionId,
        bindingId,
        version: 1,
        providerKind: "custom_runtime",
        vendor: "anthropic",
        baseUrl: "https://api.anthropic.com",
        modelName: "claude-sonnet-4-20250514",
        maxOutputTokens: 4096,
        capabilityTags: ["chat"],
        features: { apiStyle: "chat" },
        providerOptions: {},
        requestTimeoutMs: 60_000,
        maxRetries: 2,
        createdAt: isoNow,
      },
    ]).success,
    false
  )
})

test("ActorModelGroupAssignmentListViewSchema validates actor assignment responses", () => {
  assert.ok(
    ActorModelGroupAssignmentListViewSchema.safeParse([
      {
        actorId,
        groupId,
        priority: 0,
        createdAt: isoNow,
        groupName: "Workspace Models",
        routingStrategy: "priority_failover",
        isDefault: true,
        workspaceId,
        ownerType: "workspace",
        ownerWorkspaceMemberId: null,
      },
    ]).success
  )
})
