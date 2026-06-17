import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import type {
  WorkspaceInviteView,
  WorkspaceInvitePublicView,
  WorkspaceInviteRedeemResult,
} from "@synapse/shared/types"
import { formatValidationDetails } from "../../infrastructure/validation-error.js"
import {
  authMiddleware,
  optionalAuth,
} from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import {
  requireRequestAction,
  authorizeActionDefault,
  resolveWorkspaceAccessSubjectDefault,
} from "../access/guards.js"
import type { AccessAction } from "../access/actions.js"
import {
  createWorkspace,
  listUserWorkspaces,
  getWorkspaceById,
  updateWorkspace,
  deleteWorkspace,
  addMember,
  listMembers,
  getWorkspaceChiefActorPreference,
  updateWorkspaceChiefActorPreference,
  listWorkspaceAccessBindings,
  grantWorkspaceAccess,
  revokeWorkspaceAccess,
  type WorkspaceAccessKey,
} from "./service.js"
import {
  presentActorRow,
  presentMemberRow,
  presentWorkspaceListRow,
  presentWorkspaceRow,
} from "./presenter.js"
import {
  listWorkspaceCapabilityConversationTypePolicies,
  updateWorkspaceCapabilityConversationTypePolicies,
} from "../capabilities/conversation-type-policies.js"
import {
  createInvite,
  getPublicInviteInfo,
  redeemInvite,
  listWorkspaceInvites,
  revokeInvite,
} from "./invite/service.js"
import {
  presentWorkspaceInvite,
  presentWorkspaceInvitePublic,
  presentWorkspaceInviteRedeemResult,
} from "./invite/presenter.js"
import {
  CreateWorkspaceInviteInputSchema,
  WorkspaceAccessGrantInputSchema,
  WorkspaceAccessBindingListViewSchema,
  type WorkspaceAccessBindingListView,
  WorkspaceAccessBindingViewSchema,
  WorkspaceAddMemberInputSchema,
  WorkspaceCapabilityConversationTypePoliciesViewSchema,
  WorkspaceCapabilityConversationTypePolicyUpdateInputSchema,
  WorkspaceChiefActorPreferenceInputSchema,
  WorkspaceChiefActorPreferenceViewSchema,
  WorkspaceCreateInputSchema,
  WorkspaceCreateResultViewSchema,
  WorkspaceInvitePublicViewSchema,
  WorkspaceInviteRedeemResultSchema,
  WorkspaceInviteListViewSchema,
  type WorkspaceInviteListView,
  WorkspaceInviteViewSchema,
  WorkspaceListViewSchema,
  type WorkspaceListView,
  WorkspaceMemberListViewSchema,
  type WorkspaceMemberListView,
  WorkspaceMemberViewSchema,
  WorkspaceNavigationViewSchema,
  WorkspaceUpdateInputSchema,
  WorkspaceViewSchema,
} from "@synapse/shared/schemas"
import { appRoute } from "../../infrastructure/http/route.js"

// ── Helpers ──

type WorkspaceParams = { workspaceId: string }

async function canWorkspacePermission(
  workspaceId: string,
  userId: string,
  action: AccessAction
): Promise<boolean> {
  return authorizeActionDefault({
    subject: await resolveWorkspaceAccessSubjectDefault(workspaceId, userId),
    action,
    resourceId: workspaceId,
  })
}

async function requireWorkspacePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  action: AccessAction,
  errorMessage = "Forbidden"
): Promise<boolean> {
  const { workspaceId } = request.params as WorkspaceParams
  return requireRequestAction(request, reply, action, workspaceId, errorMessage)
}

// ── Handlers ──

export async function handleCreateWorkspace(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const parsed = WorkspaceCreateInputSchema.safeParse(request.body)
  if (!parsed.success) {
    reply.status(400).send({
      error: "Validation failed",
      details: formatValidationDetails(parsed.error),
    })
    return undefined
  }

  const workspace = await createWorkspace({
    name: parsed.data.name,
    description: parsed.data.description,
    userId: (request as any).user!.userId,
  })

  reply.status(201)
  return {
    ...presentWorkspaceRow(workspace.workspace),
    secretary: presentActorRow(workspace.secretary),
  }
}

export async function handleListWorkspaces(
  request: FastifyRequest
): Promise<WorkspaceListView> {
  const workspaces = await listUserWorkspaces((request as any).user!.userId)
  return workspaces.map(presentWorkspaceListRow)
}

export async function handleGetWorkspace(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    "workspace.view",
    "Not allowed to view this workspace"
  )
  if (!allowed) return undefined

  const { workspaceId } = request.params as WorkspaceParams
  const workspace = await getWorkspaceById(workspaceId)
  if (!workspace) {
    reply.status(404).send({ error: "Workspace not found" })
    return undefined
  }

  return presentWorkspaceRow(workspace)
}

export async function handleUpdateWorkspace(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    "workspace.manage",
    "Not allowed to manage this workspace"
  )
  if (!allowed) return undefined

  const parsed = WorkspaceUpdateInputSchema.safeParse(request.body)
  if (!parsed.success) {
    reply.status(400).send({
      error: "Validation failed",
      details: formatValidationDetails(parsed.error),
    })
    return undefined
  }

  const { workspaceId } = request.params as WorkspaceParams
  const workspace = await updateWorkspace(workspaceId, parsed.data)
  if (!workspace) {
    reply.status(404).send({ error: "Workspace not found" })
    return undefined
  }

  return presentWorkspaceRow(workspace)
}

export async function handleDeleteWorkspace(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    "workspace.manage",
    "Not allowed to delete this workspace"
  )
  if (!allowed) return undefined

  const { workspaceId } = request.params as WorkspaceParams
  // Soft delete (design §5.5): tenant-level orchestration via markWorkspaceDeleted.
  const deleted = await deleteWorkspace(workspaceId)
  if (!deleted) {
    reply.status(404).send({ error: "Workspace not found" })
    return undefined
  }
  reply.status(204).send()
  return undefined
}

export async function handleAddMember(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    "workspace.manage_members",
    "Not allowed to manage workspace members"
  )
  if (!allowed) return undefined

  const parsed = WorkspaceAddMemberInputSchema.safeParse(request.body)
  if (!parsed.success) {
    reply.status(400).send({
      error: "Validation failed",
      details: formatValidationDetails(parsed.error),
    })
    return undefined
  }

  const { workspaceId } = request.params as WorkspaceParams
  const member = await addMember({
    workspaceId,
    userId: parsed.data.userId,
    trustLevel: parsed.data.trustLevel,
  })

  if (!member) {
    reply
      .status(409)
      .send({ error: "User is already a member of this workspace" })
    return undefined
  }

  reply.status(201)
  return presentMemberRow(member)
}

export async function handleListMembers(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<WorkspaceMemberListView | undefined> {
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    "workspace.manage_members",
    "Not allowed to view workspace members"
  )
  if (!allowed) return undefined

  const { workspaceId } = request.params as WorkspaceParams
  const members = await listMembers(workspaceId)
  return members
}

export async function handleListWorkspaceAccess(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<WorkspaceAccessBindingListView | undefined> {
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    "workspace.manage_members",
    "Not allowed to view workspace access"
  )
  if (!allowed) return undefined

  const { workspaceId } = request.params as WorkspaceParams
  const accessBindings = await listWorkspaceAccessBindings(workspaceId)
  return accessBindings
}

export async function handleGetWorkspaceCapabilityConversationTypePolicies(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    "workspace.manage",
    "Not allowed to view workspace capability policies"
  )
  if (!allowed) return undefined

  const { workspaceId } = request.params as WorkspaceParams
  return listWorkspaceCapabilityConversationTypePolicies(workspaceId)
}

export async function handleUpdateWorkspaceCapabilityConversationTypePolicies(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    "workspace.manage",
    "Not allowed to manage workspace capability policies"
  )
  if (!allowed) return undefined

  const parsed =
    WorkspaceCapabilityConversationTypePolicyUpdateInputSchema.safeParse(
      request.body
    )
  if (!parsed.success) {
    reply.status(400).send({
      error: "Validation failed",
      details: formatValidationDetails(parsed.error),
    })
    return undefined
  }

  const { workspaceId } = request.params as WorkspaceParams
  return updateWorkspaceCapabilityConversationTypePolicies({
    workspaceId,
    policies: parsed.data.policies,
  })
}

export async function handleGetWorkspaceChiefActorPreference(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    "workspace.view",
    "Not allowed to view this workspace"
  )
  if (!allowed) return undefined

  const { workspaceId } = request.params as WorkspaceParams
  const userId = (request as any).user!.userId
  const workspaceMemberId = (request as any).workspaceMember?.id as
    | string
    | undefined
  if (!workspaceMemberId) {
    reply.status(403).send({
      error: "Workspace membership required for chief actor preference",
    })
    return undefined
  }
  return getWorkspaceChiefActorPreference(workspaceId, userId)
}

export async function handleUpdateWorkspaceChiefActorPreference(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    "workspace.view",
    "Not allowed to update preferences for this workspace"
  )
  if (!allowed) return undefined

  const parsed = WorkspaceChiefActorPreferenceInputSchema.safeParse(
    request.body
  )
  if (!parsed.success) {
    reply.status(400).send({
      error: "Validation failed",
      details: formatValidationDetails(parsed.error),
    })
    return undefined
  }

  try {
    const { workspaceId } = request.params as WorkspaceParams
    const workspaceMemberId = (request as any).workspaceMember?.id as
      | string
      | undefined
    if (!workspaceMemberId) {
      reply.status(403).send({
        error: "Workspace membership required for chief actor preference",
      })
      return undefined
    }
    return await updateWorkspaceChiefActorPreference(
      workspaceId,
      (request as any).user!.userId,
      parsed.data.chiefActorId
    )
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to update chief actor preference"
    reply.status(400).send({ error: message })
    return undefined
  }
}

export async function handleGetWorkspaceNavigation(request: FastifyRequest) {
  const userId = (request as any).user!.userId
  const { workspaceId } = request.params as WorkspaceParams

  const [canViewWorkspace, canAccessWorkspaceModels, canAccessWorkspaceAccess] =
    await Promise.all([
      canWorkspacePermission(workspaceId, userId, "workspace.view"),
      canWorkspacePermission(workspaceId, userId, "workspace.manage_models"),
      canWorkspacePermission(workspaceId, userId, "workspace.manage_members"),
    ])

  return {
    canViewWorkspace,
    canAccessWorkspaceModels,
    canAccessWorkspaceMemberModels: canViewWorkspace,
    canAccessWorkspaceAccess,
  }
}

export async function handleGrantWorkspaceAccess(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    "workspace.manage_members",
    "Not allowed to manage workspace access"
  )
  if (!allowed) return undefined

  const parsed = WorkspaceAccessGrantInputSchema.safeParse(request.body)
  if (!parsed.success) {
    reply.status(400).send({
      error: "Validation failed",
      details: formatValidationDetails(parsed.error),
    })
    return undefined
  }

  try {
    const { workspaceId } = request.params as WorkspaceParams
    const accessBinding = await grantWorkspaceAccess({
      workspaceId,
      workspaceMemberId: parsed.data.workspaceMemberId,
      accessKey: parsed.data.accessKey as WorkspaceAccessKey,
      assignedByWorkspaceMemberId: (request as any).workspaceMember!.id,
    })
    reply.status(201)
    return accessBinding
  } catch (err: any) {
    const msg = err.message || "Failed to grant workspace access"
    if (msg === "Workspace member is not part of this workspace") {
      reply.status(400).send({ error: msg })
      return undefined
    }
    if (msg === "Access already granted") {
      reply.status(409).send({ error: msg })
      return undefined
    }
    throw err
  }
}

export async function handleRevokeWorkspaceAccess(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    "workspace.manage_members",
    "Not allowed to manage workspace access"
  )
  if (!allowed) return undefined

  const params = request.params as WorkspaceParams & {
    workspaceMemberId: string
    accessKey: WorkspaceAccessKey
  }
  try {
    await revokeWorkspaceAccess(
      params.workspaceId,
      params.workspaceMemberId,
      params.accessKey
    )
    reply.status(204).send()
    return undefined
  } catch (err: any) {
    const msg = err.message || "Failed to revoke workspace access"
    if (msg === "Access grant not found") {
      reply.status(404).send({ error: msg })
      return undefined
    }
    throw err
  }
}

// ── Invite Handlers ──

type InviteParams = { workspaceId: string; inviteId: string }
type TokenParams = { token: string }

export async function handleCreateInvite(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<WorkspaceInviteView | undefined> {
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    "workspace.manage_members",
    "Not allowed to manage workspace invites"
  )
  if (!allowed) return undefined

  const parsed = CreateWorkspaceInviteInputSchema.safeParse(request.body)
  if (!parsed.success) {
    reply.status(400).send({
      error: "Validation failed",
      details: formatValidationDetails(parsed.error),
    })
    return undefined
  }

  const { workspaceId } = request.params as WorkspaceParams
  const invite = await createInvite({
    workspaceId,
    createdByWorkspaceMemberId: (request as any).workspaceMember!.id,
    trustLevel: parsed.data.trustLevel,
    maxUses: parsed.data.maxUses,
    expiresAt: parsed.data.expiresAt,
  })
  if (!invite) {
    reply.status(500).send({ error: "Failed to create invite" })
    return undefined
  }

  reply.status(201)
  return presentWorkspaceInvite(invite)
}

export async function handleListInvites(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<WorkspaceInviteListView | undefined> {
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    "workspace.manage_members",
    "Not allowed to view workspace invites"
  )
  if (!allowed) return undefined

  const { workspaceId } = request.params as WorkspaceParams
  return (await listWorkspaceInvites(workspaceId)).map(presentWorkspaceInvite)
}

export async function handleRevokeInvite(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<WorkspaceInviteView | undefined> {
  const allowed = await requireWorkspacePermission(
    request,
    reply,
    "workspace.manage_members",
    "Not allowed to manage workspace invites"
  )
  if (!allowed) return undefined

  const { workspaceId, inviteId } = request.params as InviteParams

  const revoked = await revokeInvite(inviteId, workspaceId)
  if (!revoked) {
    reply.status(404).send({ error: "Invite not found" })
    return undefined
  }
  return presentWorkspaceInvite(revoked)
}

export async function handleGetInviteInfo(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<WorkspaceInvitePublicView | undefined> {
  const { token } = request.params as TokenParams
  const lookup = await getPublicInviteInfo(token)
  if (!lookup.ok) {
    if (lookup.reason === "not_found") {
      reply.status(404).send({ error: "Invite not found or revoked" })
      return undefined
    }
    if (lookup.reason === "expired") {
      reply.status(410).send({ error: "Invite has expired" })
      return undefined
    }
    reply.status(410).send({ error: "Invite has reached maximum uses" })
    return undefined
  }

  return presentWorkspaceInvitePublic(lookup.record)
}

export async function handleRedeemInvite(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<WorkspaceInviteRedeemResult | undefined> {
  const { token } = request.params as TokenParams
  const userId = (request as any).user!.userId
  try {
    return presentWorkspaceInviteRedeemResult(await redeemInvite(token, userId))
  } catch (err: any) {
    const msg = err.message || "Failed to redeem invite"
    if (msg === "Already a member of this workspace") {
      reply.status(409).send({ error: msg })
      return undefined
    }
    reply.status(400).send({ error: msg })
    return undefined
  }
}

// ── Plugin registration ──

export async function registerWorkspaceRoutes(fastify: FastifyInstance) {
  const authHook = { preHandler: [authMiddleware] }
  const workspaceAuthHook = {
    preHandler: [authMiddleware, workspaceMiddleware],
  }
  const optionalAuthHook = { preHandler: [optionalAuth] }

  // Workspace collection routes
  appRoute(
    fastify,
    "POST",
    "/api/v1/workspaces",
    { schema: WorkspaceCreateResultViewSchema, options: authHook },
    handleCreateWorkspace
  )
  appRoute(
    fastify,
    "GET",
    "/api/v1/workspaces",
    { schema: WorkspaceListViewSchema, options: authHook },
    handleListWorkspaces
  )

  // Workspace instance routes
  appRoute(
    fastify,
    "GET",
    "/api/v1/workspaces/:workspaceId",
    { schema: WorkspaceViewSchema, options: workspaceAuthHook },
    handleGetWorkspace
  )
  appRoute(
    fastify,
    "PUT",
    "/api/v1/workspaces/:workspaceId",
    { schema: WorkspaceViewSchema, options: workspaceAuthHook },
    handleUpdateWorkspace
  )
  appRoute(
    fastify,
    "DELETE",
    "/api/v1/workspaces/:workspaceId",
    { schema: WorkspaceViewSchema, options: workspaceAuthHook },
    handleDeleteWorkspace
  )

  // Workspace member routes
  appRoute(
    fastify,
    "POST",
    "/api/v1/workspaces/:workspaceId/members",
    { schema: WorkspaceMemberViewSchema, options: workspaceAuthHook },
    handleAddMember
  )
  appRoute(
    fastify,
    "GET",
    "/api/v1/workspaces/:workspaceId/members",
    { schema: WorkspaceMemberListViewSchema, options: workspaceAuthHook },
    handleListMembers
  )
  appRoute(
    fastify,
    "GET",
    "/api/v1/workspaces/:workspaceId/navigation",
    { schema: WorkspaceNavigationViewSchema, options: authHook },
    handleGetWorkspaceNavigation
  )
  appRoute(
    fastify,
    "GET",
    "/api/v1/workspaces/:workspaceId/preferences/chief-actor",
    {
      schema: WorkspaceChiefActorPreferenceViewSchema,
      options: workspaceAuthHook,
    },
    handleGetWorkspaceChiefActorPreference
  )
  appRoute(
    fastify,
    "PUT",
    "/api/v1/workspaces/:workspaceId/preferences/chief-actor",
    {
      schema: WorkspaceChiefActorPreferenceViewSchema,
      options: workspaceAuthHook,
    },
    handleUpdateWorkspaceChiefActorPreference
  )
  appRoute(
    fastify,
    "GET",
    "/api/v1/workspaces/:workspaceId/access",
    {
      schema: WorkspaceAccessBindingListViewSchema,
      options: workspaceAuthHook,
    },
    handleListWorkspaceAccess
  )
  appRoute(
    fastify,
    "GET",
    "/api/v1/workspaces/:workspaceId/capability-conversation-type-policies",
    {
      schema: WorkspaceCapabilityConversationTypePoliciesViewSchema,
      options: workspaceAuthHook,
    },
    handleGetWorkspaceCapabilityConversationTypePolicies
  )
  appRoute(
    fastify,
    "PUT",
    "/api/v1/workspaces/:workspaceId/capability-conversation-type-policies",
    {
      schema: WorkspaceCapabilityConversationTypePoliciesViewSchema,
      options: workspaceAuthHook,
    },
    handleUpdateWorkspaceCapabilityConversationTypePolicies
  )
  appRoute(
    fastify,
    "POST",
    "/api/v1/workspaces/:workspaceId/access",
    { schema: WorkspaceAccessBindingViewSchema, options: workspaceAuthHook },
    handleGrantWorkspaceAccess
  )
  appRoute(
    fastify,
    "POST",
    "/api/v1/workspaces/:workspaceId/access/:accessKey/members/:workspaceMemberId/revoke",
    { schema: WorkspaceAccessBindingViewSchema, options: workspaceAuthHook },
    handleRevokeWorkspaceAccess
  )

  // Workspace invite management (requires workspace membership)
  appRoute(
    fastify,
    "POST",
    "/api/v1/workspaces/:workspaceId/invites",
    { schema: WorkspaceInviteViewSchema, options: workspaceAuthHook },
    handleCreateInvite
  )
  appRoute(
    fastify,
    "GET",
    "/api/v1/workspaces/:workspaceId/invites",
    { schema: WorkspaceInviteListViewSchema, options: workspaceAuthHook },
    handleListInvites
  )
  appRoute(
    fastify,
    "DELETE",
    "/api/v1/workspaces/:workspaceId/invites/:inviteId",
    { schema: WorkspaceInviteViewSchema, options: workspaceAuthHook },
    handleRevokeInvite
  )

  // Public invite routes (by token)
  appRoute(
    fastify,
    "GET",
    "/api/v1/invites/:token",
    { schema: WorkspaceInvitePublicViewSchema, options: optionalAuthHook },
    handleGetInviteInfo
  )
  appRoute(
    fastify,
    "POST",
    "/api/v1/invites/:token/redeem",
    { schema: WorkspaceInviteRedeemResultSchema, options: authHook },
    handleRedeemInvite
  )
}
