import type { FastifyRequest } from "fastify"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import {
  checkPermission,
  lookupResources,
  type AccessResourceType,
  type PermissionSubject,
} from "./evaluator.js"
import { getAccessActionSpec, type AccessAction } from "./actions.js"
import { findActiveWorkspaceMemberIdForUser } from "./repo.js"

export type AccessSubject = PermissionSubject & {
  type: "user" | "actor" | "workspace_member"
}

export function userSubject(userId: string): AccessSubject {
  return { type: "user", id: userId }
}

export function actorSubject(actorId: string): AccessSubject {
  return { type: "actor", id: actorId }
}

export function workspaceMemberSubject(
  workspaceMemberId: string
): AccessSubject {
  return {
    type: "workspace_member",
    id: workspaceMemberId,
  }
}

export async function resolveWorkspaceAccessSubject(
  db: KyselyDb,
  workspaceId: string,
  userId: string
): Promise<AccessSubject> {
  const memberId = await findActiveWorkspaceMemberIdForUser(db, {
    workspaceId,
    userId,
  })

  return memberId ? workspaceMemberSubject(memberId) : userSubject(userId)
}

export function getRequestUserId(request: FastifyRequest): string {
  const userId = (request as any).user?.userId as string | undefined
  if (!userId) {
    throw new Error("Authenticated user is missing from request")
  }
  return userId
}

export function getRequestUserSubject(request: FastifyRequest): AccessSubject {
  return userSubject(getRequestUserId(request))
}

export function getRequestAccessSubject(
  request: FastifyRequest
): AccessSubject {
  const workspaceMemberId = (request as any).workspaceMember?.id as
    | string
    | undefined
  if (workspaceMemberId) {
    return workspaceMemberSubject(workspaceMemberId)
  }
  return userSubject(getRequestUserId(request))
}

export async function authorizeAction(
  db: KyselyDb,
  params: {
    subject: AccessSubject
    action: AccessAction
    resourceId: string
    /**
     * Post-D4 P2 fix: same `runtimeSubjectIds` / `runtimeScopeSubjectIds`
     * plumbing as authorizePermission, so callers using the action-named
     * shortcut still benefit from group-subject grant visibility
     * (`subject=conversation C`) and memory_access_grants overlay.
     */
    runtimeSubjectIds?: readonly string[]
    runtimeScopeSubjectIds?: readonly string[]
  }
) {
  const spec = getAccessActionSpec(params.action)
  return checkPermission(db, {
    resourceType: spec.resourceType,
    resourceId: params.resourceId,
    permission: spec.permission,
    subject: params.subject,
    runtimeSubjectIds: params.runtimeSubjectIds,
    runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
  })
}

export async function authorizePermission(
  db: KyselyDb,
  params: {
    subject: PermissionSubject
    resourceType: AccessResourceType
    resourceId: string
    permission: string
    /**
     * PR5 fix: when provided, the evaluator's memory_access_grants overlay
     * is consulted. Pass these through from `buildRuntimePrincipalContext`.
     */
    runtimeSubjectIds?: readonly string[]
    runtimeScopeSubjectIds?: readonly string[]
  }
) {
  return checkPermission(db, {
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    permission: params.permission,
    subject: params.subject,
    runtimeSubjectIds: params.runtimeSubjectIds,
    runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
  })
}

export async function listAuthorizedResourceIds(
  db: KyselyDb,
  params: {
    subject: AccessSubject
    action: AccessAction
    limit?: number
    /**
     * PR-fix-round-3: scope-aware listing. Without it, `lookupResources`
     * falls back to "scope IS NULL only" which hides scoped grants from
     * tool/skill/plugin enumeration even though checkPermission would
     * accept them. Pass through from buildRuntimePrincipalContext.
     */
    runtimeScopeSubjectIds?: readonly string[]
    /**
     * Post-D4 P2 fix: also thread runtimeSubjectIds so `subject=conversation C`
     * RAB grants surface in tool/skill/plugin enumeration the same way
     * they do in checkPermission.
     */
    runtimeSubjectIds?: readonly string[]
  }
) {
  const spec = getAccessActionSpec(params.action)
  return lookupResources(db, {
    resourceType: spec.resourceType,
    permission: spec.permission,
    subject: params.subject,
    limit: params.limit,
    runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
    runtimeSubjectIds: params.runtimeSubjectIds,
  })
}

export async function filterAuthorizedPermissionResourceIds(
  db: KyselyDb,
  params: {
    subject: PermissionSubject
    resourceType: AccessResourceType
    permission: string
    resourceIds: string[]
    /**
     * PR5 fix: propagate runtime context so the memory_access_grants
     * overlay (and the scope-aware RAB filter) sees the same subject set
     * the controller built via buildRuntimePrincipalContext. Without these
     * the explicit grants land in the DB but never affect read paths.
     */
    runtimeSubjectIds?: readonly string[]
    runtimeScopeSubjectIds?: readonly string[]
  }
) {
  const uniqueIds = Array.from(new Set(params.resourceIds.filter(Boolean)))
  const checks = await Promise.all(
    uniqueIds.map(async (resourceId) => ({
      resourceId,
      allowed: await authorizePermission(db, {
        subject: params.subject,
        resourceType: params.resourceType,
        resourceId,
        permission: params.permission,
        runtimeSubjectIds: params.runtimeSubjectIds,
        runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
      }),
    }))
  )

  return checks
    .filter((entry) => entry.allowed)
    .map((entry) => entry.resourceId)
}
