import assert from "node:assert/strict"
import test from "node:test"
import {
  CreateWorkspaceInviteInputSchema,
  WorkspaceAccessGrantInputSchema,
  WorkspaceAccessBindingListViewSchema,
  WorkspaceAccessBindingViewSchema,
  WorkspaceAddMemberInputSchema,
  WorkspaceListItemViewSchema,
  WorkspaceListViewSchema,
  WorkspaceInviteListViewSchema,
  WorkspaceMemberViewSchema,
  WorkspaceMemberListViewSchema,
  WorkspaceCapabilityConversationTypePolicyUpdateInputSchema,
  WorkspaceChiefActorPreferenceInputSchema,
  WorkspaceChiefActorPreferenceViewSchema,
  WorkspaceCreateInputSchema,
  WorkspaceCreateResultViewSchema,
  WorkspaceUpdateInputSchema,
} from "@synapse/shared/schemas"

const uuid = "00000000-0000-4000-8000-000000000001"
const actorId = "00000000-0000-4000-8000-000000000002"
const docId = "00000000-0000-4000-8000-000000000003"
const NOW = "2026-06-14T00:00:00.000Z"

function secretaryDefinition(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "Workspace Secretary",
    role: "secretary",
    title: "Workspace Secretary",
    canRepresentUser: false,
    docs: [
      {
        id: docId,
        key: "mission",
        title: "Mission",
        content: [
          {
            type: "text",
            text: "Coordinate workspace work.",
          },
        ],
        visibility: "always",
        priority: 0,
      },
    ],
    specialties: ["coordination"],
    config: {},
    ...overrides,
  }
}

function workspaceCreateResult(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid,
    name: "Acme",
    slug: "acme",
    description: "Workspace",
    ownerId: uuid,
    isTrusted: false,
    createdAt: NOW,
    updatedAt: NOW,
    secretary: {
      id: actorId,
      workspaceId: uuid,
      definition: secretaryDefinition(),
      currentVersion: 1,
      isActive: true,
      isPublicShared: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
    ...overrides,
  }
}

test("workspace app input schemas parse controller request bodies", () => {
  assert.ok(
    WorkspaceCreateInputSchema.safeParse({
      name: "Acme",
      description: "Workspace",
    }).success
  )
  assert.ok(
    WorkspaceUpdateInputSchema.safeParse({
      description: "Updated",
    }).success
  )
  assert.ok(
    WorkspaceAddMemberInputSchema.safeParse({
      userId: uuid,
      trustLevel: "member",
    }).success
  )
  assert.ok(
    WorkspaceAccessGrantInputSchema.safeParse({
      workspaceMemberId: uuid,
      accessKey: "model_admin",
    }).success
  )
  assert.ok(
    WorkspaceChiefActorPreferenceInputSchema.safeParse({
      chiefActorId: null,
    }).success
  )
  assert.ok(
    CreateWorkspaceInviteInputSchema.safeParse({
      trustLevel: "guest",
      maxUses: 3,
      expiresAt: "2026-06-20T00:00:00.000Z",
    }).success
  )
})

test("workspace capability policy update accepts non-empty partial updates", () => {
  const parsed =
    WorkspaceCapabilityConversationTypePolicyUpdateInputSchema.safeParse({
      policies: {
        plugin_installation: 3,
      },
    })

  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("workspace capability policy update rejects empty updates", () => {
  const parsed =
    WorkspaceCapabilityConversationTypePolicyUpdateInputSchema.safeParse({
      policies: {},
    })

  assert.equal(parsed.success, false)
})

test("WorkspaceCreateResultViewSchema validates secretary actor definition", () => {
  assert.equal(
    WorkspaceCreateResultViewSchema.safeParse(workspaceCreateResult()).success,
    true
  )
})

test("WorkspaceCreateResultViewSchema rejects legacy secretary definition name field", () => {
  assert.equal(
    WorkspaceCreateResultViewSchema.safeParse(
      workspaceCreateResult({
        secretary: {
          id: actorId,
          workspaceId: uuid,
          definition: secretaryDefinition({
            displayName: undefined,
            name: "Legacy Secretary",
          }),
          currentVersion: 1,
          isActive: true,
          isPublicShared: false,
        },
      })
    ).success,
    false
  )
})

test("workspace response schemas validate finite trust levels", () => {
  const workspaceListItem = {
    id: uuid,
    name: "Acme",
    slug: "acme",
    description: "Workspace",
    ownerId: uuid,
    isTrusted: false,
    trustLevel: "owner",
  }
  assert.ok(WorkspaceListItemViewSchema.safeParse(workspaceListItem).success)

  const workspaceMember = {
    id: uuid,
    workspaceId: uuid,
    userId: uuid,
    trustLevel: "member",
    accessKeys: [],
  }
  assert.ok(WorkspaceMemberViewSchema.safeParse(workspaceMember).success)

  const workspaceAccessBinding = {
    workspaceId: uuid,
    workspaceMemberId: uuid,
    userId: uuid,
    accessKey: "model_admin",
    assignedByWorkspaceMemberId: null,
    trustLevel: "admin",
  }
  assert.ok(
    WorkspaceAccessBindingViewSchema.safeParse(workspaceAccessBinding).success
  )

  assert.ok(WorkspaceListViewSchema.safeParse([workspaceListItem]).success)
  assert.ok(WorkspaceMemberListViewSchema.safeParse([workspaceMember]).success)
  assert.ok(
    WorkspaceAccessBindingListViewSchema.safeParse([workspaceAccessBinding])
      .success
  )

  assert.equal(
    WorkspaceMemberViewSchema.safeParse({
      id: uuid,
      workspaceId: uuid,
      userId: uuid,
      trustLevel: "super_admin",
      accessKeys: [],
    }).success,
    false
  )
})

test("workspace list response containers reject local wrapper shapes", () => {
  const workspaceListItem = {
    id: uuid,
    name: "Acme",
    slug: "acme",
    description: "Workspace",
    ownerId: uuid,
    isTrusted: false,
    trustLevel: "owner",
  }
  const workspaceMember = {
    id: uuid,
    workspaceId: uuid,
    userId: uuid,
    trustLevel: "member",
    accessKeys: [],
  }
  const workspaceAccessBinding = {
    workspaceId: uuid,
    workspaceMemberId: uuid,
    userId: uuid,
    accessKey: "model_admin",
    assignedByWorkspaceMemberId: null,
    trustLevel: "admin",
  }
  const workspaceInvite = {
    id: uuid,
    workspaceId: uuid,
    token: "invite-token",
    createdByWorkspaceMemberId: uuid,
    trustLevel: "member",
    maxUses: null,
    useCount: 0,
    expiresAt: null,
    isRevoked: false,
    createdAt: NOW,
    updatedAt: NOW,
  }

  assert.ok(WorkspaceInviteListViewSchema.safeParse([workspaceInvite]).success)
  assert.equal(
    WorkspaceListViewSchema.safeParse({ data: [workspaceListItem] }).success,
    false
  )
  assert.equal(
    WorkspaceMemberListViewSchema.safeParse({ members: [workspaceMember] })
      .success,
    false
  )
  assert.equal(
    WorkspaceAccessBindingListViewSchema.safeParse({
      access: [workspaceAccessBinding],
    }).success,
    false
  )
  assert.equal(
    WorkspaceInviteListViewSchema.safeParse({ invites: [workspaceInvite] })
      .success,
    false
  )
})

test("workspace chief actor preference validates finite actor roles", () => {
  assert.equal(
    WorkspaceChiefActorPreferenceViewSchema.safeParse({
      workspaceId: uuid,
      workspaceMemberId: uuid,
      chiefActorId: actorId,
      chiefActor: {
        id: actorId,
        displayName: "Workspace Secretary",
        role: "remote_agent",
        title: "Workspace Secretary",
      },
      createdAt: NOW,
      updatedAt: NOW,
    }).success,
    false
  )
})
