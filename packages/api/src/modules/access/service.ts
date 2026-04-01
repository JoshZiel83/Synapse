import type { FastifyRequest } from 'fastify';
import {
  buildWorkspaceMemberContextId,
  checkPermission,
  lookupResources,
  type AuthzObjectType,
  type AuthzSubject,
} from '../../infrastructure/authz/index.js';
import { db } from '../../infrastructure/database/kysely.js';
import {
  getAccessActionSpec,
  type AccessAction,
} from './actions.js';

export type AccessSubject = AuthzSubject & {
  type: 'user' | 'actor' | 'workspace_member';
};

export function userSubject(userId: string): AccessSubject {
  return { type: 'user', id: userId };
}

export function actorSubject(actorId: string): AccessSubject {
  return { type: 'actor', id: actorId };
}

export function workspaceMemberSubject(
  workspaceMemberId: string,
): AccessSubject;
export function workspaceMemberSubject(
  workspaceMemberId: string,
): AccessSubject {
  return {
    type: 'workspace_member',
    id: buildWorkspaceMemberContextId(workspaceMemberId),
  };
}

export async function resolveWorkspaceAccessSubject(
  workspaceId: string,
  userId: string,
): Promise<AccessSubject> {
  const member = await db
    .selectFrom('workspace_members')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .limit(1)
    .executeTakeFirst();

  return member ? workspaceMemberSubject(member.id) : userSubject(userId);
}

export function getRequestUserId(request: FastifyRequest): string {
  const userId = (request as any).user?.userId as string | undefined;
  if (!userId) {
    throw new Error('Authenticated user is missing from request');
  }
  return userId;
}

export function getRequestUserSubject(request: FastifyRequest): AccessSubject {
  return userSubject(getRequestUserId(request));
}

export function getRequestAccessSubject(request: FastifyRequest): AccessSubject {
  const workspaceMemberId = (request as any).workspaceMember?.id as
    | string
    | undefined;
  if (workspaceMemberId) {
    return workspaceMemberSubject(workspaceMemberId);
  }
  return userSubject(getRequestUserId(request));
}

export async function authorizeAction(params: {
  subject: AccessSubject;
  action: AccessAction;
  resourceId: string;
}) {
  const spec = getAccessActionSpec(params.action);
  return checkPermission({
    resourceType: spec.resourceType,
    resourceId: params.resourceId,
    permission: spec.permission,
    subject: params.subject,
  });
}

export async function authorizePermission(params: {
  subject: AccessSubject;
  resourceType: AuthzObjectType;
  resourceId: string;
  permission: string;
}) {
  return checkPermission({
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    permission: params.permission,
    subject: params.subject,
  });
}

export async function listAuthorizedResourceIds(params: {
  subject: AccessSubject;
  action: AccessAction;
  limit?: number;
}) {
  const spec = getAccessActionSpec(params.action);
  return lookupResources({
    resourceType: spec.resourceType,
    permission: spec.permission,
    subject: params.subject,
    limit: params.limit,
  });
}

export async function listAuthorizedPermissionResourceIds(params: {
  subject: AccessSubject;
  resourceType: AuthzObjectType;
  permission: string;
  limit?: number;
}) {
  return lookupResources({
    resourceType: params.resourceType,
    permission: params.permission,
    subject: params.subject,
    limit: params.limit,
  });
}
