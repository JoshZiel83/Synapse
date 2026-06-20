import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import {
  ACTOR_DOC_VISIBILITIES,
  ACTOR_ROLES,
  SUBJECT_KIND,
  WORKSPACE_RESOURCE_GRANT_PERMISSION,
  WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTION,
  WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS,
  WORKSPACE_RESOURCE_GRANT_SOURCE,
  WORKSPACE_RESOURCE_GRANT_STATUS,
  WORKSPACE_RESOURCE_KIND,
  WORKSPACE_RESOURCE_STATUS,
} from "@synapse/shared"
import {
  CreateWorkspaceResourceInputSchema,
  UpdateWorkspaceResourceInputSchema,
  WorkspaceResourceEnvelopeViewSchema,
  WorkspaceResourceGrantListViewSchema,
  WorkspaceResourceGrantRequestListQuerySchema,
  WorkspaceResourceGrantRequestEnvelopeViewSchema,
  WorkspaceResourceGrantRequestListViewSchema,
  WorkspaceResourceDiscoverQuerySchema,
  WorkspaceResourceListQuerySchema,
  WorkspaceResourceListViewSchema,
  WorkspaceResourceSuccessViewSchema,
} from "@synapse/shared/schemas"

const NOW = "2026-06-13T00:00:00.000Z"

function uuid() {
  return crypto.randomUUID()
}

function workspaceResourceView(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    workspaceId: uuid(),
    kind: WORKSPACE_RESOURCE_KIND.ACTOR,
    displayName: "Research Assistant",
    ownerWorkspaceMemberId: uuid(),
    status: WORKSPACE_RESOURCE_STATUS.ACTIVE,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function capabilityTarget() {
  return {
    subject: {
      kind: SUBJECT_KIND.WORKSPACE,
      workspaceId: uuid(),
    },
  }
}

function textBlock(text = "Use the workspace context before replying") {
  return {
    type: "text",
    text,
  }
}

function actorDoc(overrides: Record<string, unknown> = {}) {
  return {
    key: "custom",
    title: "Operating notes",
    content: [textBlock()],
    visibility: ACTOR_DOC_VISIBILITIES[0],
    priority: 10,
    ...overrides,
  }
}

function skillAttachment(overrides: Record<string, unknown> = {}) {
  return {
    path: "docs/notes.md",
    contentBlocks: [textBlock("Attachment body")],
    mediaType: "text/markdown",
    ...overrides,
  }
}

function workspaceResourceGrantView(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    workspaceId: uuid(),
    workspaceResourceId: uuid(),
    target: capabilityTarget(),
    permissions: [WORKSPACE_RESOURCE_GRANT_PERMISSION.USE],
    status: WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE,
    source: WORKSPACE_RESOURCE_GRANT_SOURCE.MANUAL,
    createdByWorkspaceMemberId: uuid(),
    reason: "Allowed for this workspace",
    createdAt: NOW,
    ...overrides,
  }
}

function workspaceResourceGrantRequestView(
  overrides: Record<string, unknown> = {}
) {
  return {
    id: uuid(),
    workspaceId: uuid(),
    workspaceResourceId: uuid(),
    grantee: capabilityTarget(),
    requestedPermissions: [WORKSPACE_RESOURCE_GRANT_PERMISSION.USE],
    requesterWorkspaceMemberId: uuid(),
    status: WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS.PENDING,
    reason: "Need access for a task",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

test("WorkspaceResourceEnvelopeViewSchema validates single resource responses", () => {
  assert.equal(
    WorkspaceResourceEnvelopeViewSchema.safeParse({
      resource: workspaceResourceView(),
    }).success,
    true
  )
})

test("WorkspaceResourceListViewSchema validates resource collection responses", () => {
  assert.equal(
    WorkspaceResourceListViewSchema.safeParse({
      resources: [workspaceResourceView()],
    }).success,
    true
  )
})

test("WorkspaceResourceGrantListViewSchema validates grant collection responses", () => {
  assert.equal(
    WorkspaceResourceGrantListViewSchema.safeParse({
      grants: [workspaceResourceGrantView()],
    }).success,
    true
  )
})

test("WorkspaceResourceGrantRequest schemas validate request responses", () => {
  const request = workspaceResourceGrantRequestView()

  assert.equal(
    WorkspaceResourceGrantRequestListViewSchema.safeParse({
      requests: [request],
    }).success,
    true
  )
  assert.equal(
    WorkspaceResourceGrantRequestEnvelopeViewSchema.safeParse({
      request,
    }).success,
    true
  )
})

test("WorkspaceResourceGrant response schemas reject malformed access targets", () => {
  assert.equal(
    WorkspaceResourceGrantListViewSchema.safeParse({
      grants: [
        workspaceResourceGrantView({
          target: {
            subject: {
              kind: SUBJECT_KIND.WORKSPACE,
            },
          },
        }),
      ],
    }).success,
    false
  )

  assert.equal(
    WorkspaceResourceGrantRequestEnvelopeViewSchema.safeParse({
      request: workspaceResourceGrantRequestView({
        grantee: {
          subject: {
            kind: SUBJECT_KIND.ACTOR,
            workspaceId: uuid(),
          },
        },
      }),
    }).success,
    false
  )
})

test("WorkspaceResourceSuccessViewSchema validates boolean outcomes only", () => {
  assert.equal(
    WorkspaceResourceSuccessViewSchema.safeParse({ success: true }).success,
    true
  )
  assert.equal(
    WorkspaceResourceSuccessViewSchema.safeParse({ success: "true" }).success,
    false
  )
})

test("workspace resource query schemas parse client-facing query DTOs", () => {
  const conversationId = uuid()

  assert.deepEqual(
    WorkspaceResourceListQuerySchema.parse({
      kind: WORKSPACE_RESOURCE_KIND.ACTOR,
    }),
    { kind: WORKSPACE_RESOURCE_KIND.ACTOR }
  )
  assert.equal(
    WorkspaceResourceListQuerySchema.safeParse({ kind: "actor_app" }).success,
    false
  )

  assert.deepEqual(
    WorkspaceResourceDiscoverQuerySchema.parse({ conversationId }),
    {
      conversationId,
    }
  )
  assert.equal(
    WorkspaceResourceDiscoverQuerySchema.safeParse({ conversationId: "bad-id" })
      .success,
    false
  )

  assert.deepEqual(WorkspaceResourceGrantRequestListQuerySchema.parse({}), {
    direction: WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTION.INCOMING,
  })
  assert.deepEqual(
    WorkspaceResourceGrantRequestListQuerySchema.parse({
      direction: WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTION.OUTGOING,
    }),
    { direction: WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTION.OUTGOING }
  )
  assert.equal(
    WorkspaceResourceGrantRequestListQuerySchema.safeParse({
      direction: "incoming_requests",
    }).success,
    false
  )
})

test("workspace resource input schemas validate actor docs and custom skill content", () => {
  assert.equal(
    CreateWorkspaceResourceInputSchema.safeParse({
      kind: WORKSPACE_RESOURCE_KIND.ACTOR,
      displayName: "Research Assistant",
      role: ACTOR_ROLES[0],
      docs: [actorDoc()],
    }).success,
    true
  )
  assert.equal(
    CreateWorkspaceResourceInputSchema.safeParse({
      kind: WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL,
      sourceType: "custom",
      displayName: "Summarizer",
      description: textBlock("Summarize long threads"),
      attachmentFiles: [skillAttachment()],
    }).success,
    true
  )
  assert.equal(
    UpdateWorkspaceResourceInputSchema.safeParse({
      kind: WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL,
      description: textBlock("Updated description"),
      attachmentFiles: [skillAttachment({ path: "docs/updated.md" })],
    }).success,
    true
  )
})

test("workspace resource input schemas reject malformed actor docs and custom skill content", () => {
  assert.equal(
    CreateWorkspaceResourceInputSchema.safeParse({
      kind: WORKSPACE_RESOURCE_KIND.ACTOR,
      displayName: "Research Assistant",
      role: ACTOR_ROLES[0],
      docs: [actorDoc({ content: "not content blocks" })],
    }).success,
    false
  )
  assert.equal(
    CreateWorkspaceResourceInputSchema.safeParse({
      kind: WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL,
      sourceType: "custom",
      displayName: "Summarizer",
      description: { type: "text", text: 42 },
    }).success,
    false
  )
  assert.equal(
    UpdateWorkspaceResourceInputSchema.safeParse({
      kind: WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL,
      attachmentFiles: [skillAttachment({ path: "" })],
    }).success,
    false
  )
})
