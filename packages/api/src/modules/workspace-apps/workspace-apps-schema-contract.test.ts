import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import {
  ACTOR_DOC_VISIBILITIES,
  ACTOR_ROLES,
  SUBJECT_KIND,
  WORKSPACE_APP_GRANT_PERMISSION,
  WORKSPACE_APP_GRANT_REQUEST_DIRECTION,
  WORKSPACE_APP_GRANT_REQUEST_STATUS,
  WORKSPACE_APP_GRANT_SOURCE,
  WORKSPACE_APP_GRANT_STATUS,
  WORKSPACE_APP_KIND,
  WORKSPACE_APP_STATUS,
} from "@synapse/shared"
import {
  CreateWorkspaceAppInputSchema,
  UpdateWorkspaceAppInputSchema,
  WorkspaceAppEnvelopeViewSchema,
  WorkspaceAppGrantListViewSchema,
  WorkspaceAppGrantRequestListQuerySchema,
  WorkspaceAppGrantRequestEnvelopeViewSchema,
  WorkspaceAppGrantRequestListViewSchema,
  WorkspaceAppDiscoverQuerySchema,
  WorkspaceAppListQuerySchema,
  WorkspaceAppListViewSchema,
  WorkspaceAppSuccessViewSchema,
} from "@synapse/shared/schemas"

const NOW = "2026-06-13T00:00:00.000Z"

function uuid() {
  return crypto.randomUUID()
}

function workspaceAppView(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    workspaceId: uuid(),
    kind: WORKSPACE_APP_KIND.ACTOR,
    displayName: "Research Assistant",
    ownerWorkspaceMemberId: uuid(),
    status: WORKSPACE_APP_STATUS.ACTIVE,
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

function workspaceAppGrantView(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    workspaceId: uuid(),
    workspaceAppId: uuid(),
    target: capabilityTarget(),
    permissions: [WORKSPACE_APP_GRANT_PERMISSION.USE],
    status: WORKSPACE_APP_GRANT_STATUS.ACTIVE,
    source: WORKSPACE_APP_GRANT_SOURCE.MANUAL,
    grantedByWorkspaceMemberId: uuid(),
    reason: "Allowed for this workspace",
    createdAt: NOW,
    ...overrides,
  }
}

function workspaceAppGrantRequestView(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    workspaceId: uuid(),
    workspaceAppId: uuid(),
    grantee: capabilityTarget(),
    requestedPermissions: [WORKSPACE_APP_GRANT_PERMISSION.USE],
    requesterWorkspaceMemberId: uuid(),
    status: WORKSPACE_APP_GRANT_REQUEST_STATUS.PENDING,
    reason: "Need access for a task",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

test("WorkspaceAppEnvelopeViewSchema validates single app responses", () => {
  assert.equal(
    WorkspaceAppEnvelopeViewSchema.safeParse({
      app: workspaceAppView(),
    }).success,
    true
  )
})

test("WorkspaceAppListViewSchema validates app collection responses", () => {
  assert.equal(
    WorkspaceAppListViewSchema.safeParse({
      apps: [workspaceAppView()],
    }).success,
    true
  )
})

test("WorkspaceAppGrantListViewSchema validates grant collection responses", () => {
  assert.equal(
    WorkspaceAppGrantListViewSchema.safeParse({
      grants: [workspaceAppGrantView()],
    }).success,
    true
  )
})

test("WorkspaceAppGrantRequest schemas validate request responses", () => {
  const request = workspaceAppGrantRequestView()

  assert.equal(
    WorkspaceAppGrantRequestListViewSchema.safeParse({
      requests: [request],
    }).success,
    true
  )
  assert.equal(
    WorkspaceAppGrantRequestEnvelopeViewSchema.safeParse({
      request,
    }).success,
    true
  )
})

test("WorkspaceAppGrant response schemas reject malformed access targets", () => {
  assert.equal(
    WorkspaceAppGrantListViewSchema.safeParse({
      grants: [
        workspaceAppGrantView({
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
    WorkspaceAppGrantRequestEnvelopeViewSchema.safeParse({
      request: workspaceAppGrantRequestView({
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

test("WorkspaceAppSuccessViewSchema validates boolean outcomes only", () => {
  assert.equal(
    WorkspaceAppSuccessViewSchema.safeParse({ success: true }).success,
    true
  )
  assert.equal(
    WorkspaceAppSuccessViewSchema.safeParse({ success: "true" }).success,
    false
  )
})

test("workspace app query schemas parse app-facing query DTOs", () => {
  const conversationId = uuid()

  assert.deepEqual(
    WorkspaceAppListQuerySchema.parse({ kind: WORKSPACE_APP_KIND.ACTOR }),
    { kind: WORKSPACE_APP_KIND.ACTOR }
  )
  assert.equal(
    WorkspaceAppListQuerySchema.safeParse({ kind: "actor_app" }).success,
    false
  )

  assert.deepEqual(WorkspaceAppDiscoverQuerySchema.parse({ conversationId }), {
    conversationId,
  })
  assert.equal(
    WorkspaceAppDiscoverQuerySchema.safeParse({ conversationId: "bad-id" })
      .success,
    false
  )

  assert.deepEqual(WorkspaceAppGrantRequestListQuerySchema.parse({}), {
    direction: WORKSPACE_APP_GRANT_REQUEST_DIRECTION.INCOMING,
  })
  assert.deepEqual(
    WorkspaceAppGrantRequestListQuerySchema.parse({
      direction: WORKSPACE_APP_GRANT_REQUEST_DIRECTION.OUTGOING,
    }),
    { direction: WORKSPACE_APP_GRANT_REQUEST_DIRECTION.OUTGOING }
  )
  assert.equal(
    WorkspaceAppGrantRequestListQuerySchema.safeParse({
      direction: "incoming_requests",
    }).success,
    false
  )
})

test("workspace app input schemas validate actor docs and custom skill content", () => {
  assert.equal(
    CreateWorkspaceAppInputSchema.safeParse({
      kind: WORKSPACE_APP_KIND.ACTOR,
      displayName: "Research Assistant",
      role: ACTOR_ROLES[0],
      docs: [actorDoc()],
    }).success,
    true
  )
  assert.equal(
    CreateWorkspaceAppInputSchema.safeParse({
      kind: WORKSPACE_APP_KIND.INSTALLED_SKILL,
      sourceType: "custom",
      displayName: "Summarizer",
      description: textBlock("Summarize long threads"),
      attachmentFiles: [skillAttachment()],
    }).success,
    true
  )
  assert.equal(
    UpdateWorkspaceAppInputSchema.safeParse({
      kind: WORKSPACE_APP_KIND.INSTALLED_SKILL,
      description: textBlock("Updated description"),
      attachmentFiles: [skillAttachment({ path: "docs/updated.md" })],
    }).success,
    true
  )
})

test("workspace app input schemas reject malformed actor docs and custom skill content", () => {
  assert.equal(
    CreateWorkspaceAppInputSchema.safeParse({
      kind: WORKSPACE_APP_KIND.ACTOR,
      displayName: "Research Assistant",
      role: ACTOR_ROLES[0],
      docs: [actorDoc({ content: "not content blocks" })],
    }).success,
    false
  )
  assert.equal(
    CreateWorkspaceAppInputSchema.safeParse({
      kind: WORKSPACE_APP_KIND.INSTALLED_SKILL,
      sourceType: "custom",
      displayName: "Summarizer",
      description: { type: "text", text: 42 },
    }).success,
    false
  )
  assert.equal(
    UpdateWorkspaceAppInputSchema.safeParse({
      kind: WORKSPACE_APP_KIND.INSTALLED_SKILL,
      attachmentFiles: [skillAttachment({ path: "" })],
    }).success,
    false
  )
})
