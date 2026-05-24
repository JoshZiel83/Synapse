import type { FastifyRequest } from "fastify"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import {
  checkPermission,
  lookupResources,
  type AccessResourceType,
  type PermissionSubject,
} from "./evaluator.js"
import { getAccessActionSpec, type AccessAction } from "./actions.js"

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
  const member = await db
    .selectFrom("workspace_members")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("user_id", "=", userId)
    .limit(1)
    .executeTakeFirst()

  return member ? workspaceMemberSubject(member.id) : userSubject(userId)
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
  }
) {
  const spec = getAccessActionSpec(params.action)
  return checkPermission(db, {
    resourceType: spec.resourceType,
    resourceId: params.resourceId,
    permission: spec.permission,
    subject: params.subject,
  })
}

export async function authorizePermission(
  db: KyselyDb,
  params: {
    subject: PermissionSubject
    resourceType: AccessResourceType
    resourceId: string
    permission: string
  }
) {
  return checkPermission(db, {
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    permission: params.permission,
    subject: params.subject,
  })
}

export async function listAuthorizedResourceIds(
  db: KyselyDb,
  params: {
    subject: AccessSubject
    action: AccessAction
    limit?: number
  }
) {
  const spec = getAccessActionSpec(params.action)
  return lookupResources(db, {
    resourceType: spec.resourceType,
    permission: spec.permission,
    subject: params.subject,
    limit: params.limit,
  })
}

export async function filterAuthorizedPermissionResourceIds(
  db: KyselyDb,
  params: {
    subject: PermissionSubject
    resourceType: AccessResourceType
    permission: string
    resourceIds: string[]
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
      }),
    }))
  )

  return checks
    .filter((entry) => entry.allowed)
    .map((entry) => entry.resourceId)
}
