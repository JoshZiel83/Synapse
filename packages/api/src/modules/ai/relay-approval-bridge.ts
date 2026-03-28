import path from 'node:path';
import type { RelayAuthorizationScope } from '@synapse/shared';
import type { NormalizedMcpToolResult } from '@synapse/shared/types';
import { actorSubject, authorizeAction } from '../access/service.js';
import { getGroupMembers } from '../group/service.js';
import {
  createRelayAuthorizationInteractionRequest,
  findOpenRelayAuthorizationInteraction,
} from '../interactions/service.js';
import { resolveRelayTargetForNamespacedTool } from '../mcp-plugins/tool-resolver.js';

type ActiveConversationUser = {
  memberId: string;
  userId: string;
  name: string;
};

type AutoBridgeRelayApprovalParams = {
  actorId: string;
  workspaceId?: string;
  sessionId?: string;
  conversationId?: string;
  userId?: string;
  relayToolName: string;
  toolInput: Record<string, unknown>;
  result: NormalizedMcpToolResult;
};

export type AutoBridgeRelayApprovalResult =
  | {
      status: 'created' | 'already_pending' | 'awaiting_apply';
      interactionId: string;
      note: string;
    }
  | {
      status:
        | 'missing_context'
        | 'missing_runtime_session'
        | 'not_allowed'
        | 'no_authorizer'
        | 'unsupported_scope';
      note: string;
    };

const FILESYSTEM_READ_TOOL_NAMES = new Set([
  'ListAllowedDirectories',
  'View',
  'ViewMany',
  'GetFile',
  'LS',
  'DirectoryTree',
  'Stat',
  'GlobTool',
  'GrepTool',
  'SearchFiles',
  'ListBackups',
  'GetBackup',
]);

const FILESYSTEM_WRITE_TOOL_NAMES = new Set([
  'Edit',
  'Replace',
  'Patch',
  'UpdateStructuredData',
  'CreateDirectory',
  'Move',
  'Copy',
  'Delete',
  'RestoreBackup',
]);

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function buildActiveConversationUsers(members: any[]): ActiveConversationUser[] {
  return members
    .filter((member) => member?.state === 'active' && typeof member?.user_id === 'string' && member.user_id.trim().length > 0)
    .map((member) => ({
      memberId: String(member.id),
      userId: String(member.user_id).trim(),
      name: asTrimmedString(member.user_name) || 'User',
    }));
}

function inferFilesystemAccess(params: {
  structuredToolName?: string;
  structuredOperation?: string;
  structuredAccess?: string;
  visibleToolName: string;
  toolInput: Record<string, unknown>;
}): 'read' | 'write' | 'read_write' | null {
  const structuredAccess = params.structuredAccess?.trim().toLowerCase();
  if (structuredAccess === 'read' || structuredAccess === 'ro') {
    return 'read';
  }
  if (structuredAccess === 'write') {
    return 'write';
  }
  if (structuredAccess === 'read_write' || structuredAccess === 'rw') {
    return 'read_write';
  }

  const names = [
    params.structuredToolName,
    params.structuredOperation,
    params.visibleToolName,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  if (names.some((value) => FILESYSTEM_WRITE_TOOL_NAMES.has(value))) {
    return 'write';
  }
  if (names.some((value) => FILESYSTEM_READ_TOOL_NAMES.has(value))) {
    return 'read';
  }
  if (
    Object.prototype.hasOwnProperty.call(params.toolInput, 'content') ||
    Object.prototype.hasOwnProperty.call(params.toolInput, 'destination_path') ||
    Object.prototype.hasOwnProperty.call(params.toolInput, 'old_string') ||
    Object.prototype.hasOwnProperty.call(params.toolInput, 'new_string') ||
    Object.prototype.hasOwnProperty.call(params.toolInput, 'operations') ||
    Object.prototype.hasOwnProperty.call(params.toolInput, 'updates') ||
    Object.prototype.hasOwnProperty.call(params.toolInput, 'target_path')
  ) {
    return 'write';
  }
  return null;
}

function inferRelayAuthorizationScope(params: {
  visibleToolName: string;
  toolInput: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
}): RelayAuthorizationScope | null {
  const structuredToolName = asTrimmedString(params.structuredContent?.tool);
  const structuredOperation = asTrimmedString(params.structuredContent?.operation);
  const structuredPath = asTrimmedString(params.structuredContent?.path);
  const structuredCapability = asTrimmedString(params.structuredContent?.capability);
  const structuredAccess = asTrimmedString(params.structuredContent?.access);

  const filesystemAccess = inferFilesystemAccess({
    structuredToolName,
    structuredOperation,
    structuredAccess,
    visibleToolName: params.visibleToolName,
    toolInput: params.toolInput,
  });

  if (filesystemAccess) {
    const inferredPath =
      structuredPath ||
      asTrimmedString(params.toolInput.directory_path) ||
      asTrimmedString(params.toolInput.file_path) ||
      asTrimmedString(params.toolInput.path) ||
      asTrimmedString(params.toolInput.destination_path) ||
      asTrimmedString(params.toolInput.source_path) ||
      asTrimmedString(params.toolInput.target_path);
    if (!inferredPath || !path.isAbsolute(inferredPath)) {
      return null;
    }
    return {
      capability: 'filesystem',
      path: inferredPath,
      access: filesystemAccess,
    };
  }

  if (structuredCapability === 'chrome') {
    return {
      capability: 'chrome',
    };
  }

  const cuaToolName = structuredToolName || structuredOperation || params.visibleToolName;
  if (
    cuaToolName.startsWith('desktop_') ||
    params.structuredContent?.read_only === true
  ) {
    return {
      capability: 'cua',
      mode: 'control',
    };
  }

  return null;
}

function inferRelayAuthorizationDuration(
  structuredContent?: Record<string, unknown>,
  requestedScope?: RelayAuthorizationScope | null,
): 'session' | 'persistent' {
  const structuredDuration = asTrimmedString(structuredContent?.authorization_duration);
  if (structuredDuration === 'persistent') {
    return 'persistent';
  }
  if (requestedScope?.capability === 'chrome') {
    return 'persistent';
  }
  return 'session';
}

function buildAuthorizationReason(params: {
  visibleToolName: string;
  requestedScope: RelayAuthorizationScope;
}) {
  if (params.requestedScope.capability === 'filesystem') {
    const accessLabel =
      params.requestedScope.access === 'read_write'
        ? 'read and write'
        : params.requestedScope.access;
    return `Allow ${accessLabel} access to ${params.requestedScope.path} so the actor can continue ${params.visibleToolName}.`;
  }

  if (params.requestedScope.capability === 'chrome') {
    return `Enable browser access so the actor can continue ${params.visibleToolName}.`;
  }

  return `Allow desktop control so the actor can continue ${params.visibleToolName}.`;
}

export async function maybeAutoBridgeRelayApproval(
  params: AutoBridgeRelayApprovalParams,
): Promise<AutoBridgeRelayApprovalResult | null> {
  const structuredContent =
    params.result.structuredContent && typeof params.result.structuredContent === 'object'
      ? (params.result.structuredContent as Record<string, unknown>)
      : undefined;
  if (!params.result.isError || structuredContent?.requires_user_approval !== true) {
    return null;
  }

  if (!params.workspaceId || !params.sessionId || !params.conversationId) {
    return {
      status: 'missing_context',
      note:
        'This relay tool requires user approval, but no group conversation context is available to create an authorization request automatically.',
    };
  }

  const relayTarget = await resolveRelayTargetForNamespacedTool({
    actorId: params.actorId,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    conversationId: params.conversationId,
    userId: params.userId,
    namespacedToolName: params.relayToolName,
  });
  if (!relayTarget?.runtimeSessionId) {
    return {
      status: 'missing_runtime_session',
      note:
        'This relay tool requires user approval, but the relay runtime session is no longer active. Retry the tool to create a fresh session before requesting authorization.',
    };
  }

  const members = await getGroupMembers(params.conversationId);
  const requesterMember = members.find(
    (member) => member.actor_id === params.actorId && member.state === 'active',
  );
  if (!requesterMember) {
    return {
      status: 'missing_context',
      note:
        'This relay tool requires user approval, but the current actor is not an active member of the conversation anymore.',
    };
  }

  const requesterAllowed = await authorizeAction({
    subject: actorSubject(params.actorId),
    action: 'relay_exposure.request_authorization',
    resourceId: relayTarget.exposureId,
  });
  if (!requesterAllowed) {
    return {
      status: 'not_allowed',
      note:
        'This relay tool requires user approval, but the current actor is not allowed to request authorization for this relay exposure.',
    };
  }

  const requestedScope = inferRelayAuthorizationScope({
    visibleToolName: relayTarget.visibleToolName,
    toolInput: params.toolInput,
    structuredContent,
  });
  if (!requestedScope) {
    return {
      status: 'unsupported_scope',
      note:
        'This relay tool requires user approval, but Synapse could not infer the required relay authorization scope automatically. Use request_relay_authorization with an explicit scope if you still need it.',
    };
  }
  const duration = inferRelayAuthorizationDuration(structuredContent, requestedScope);

  const existing = await findOpenRelayAuthorizationInteraction({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    requesterMemberId: requesterMember.id,
    relayDeviceId: relayTarget.deviceId,
    relayExposureId: relayTarget.exposureId,
    runtimeSessionId: relayTarget.runtimeSessionId,
    duration,
    requestedScope,
  });
  if (existing) {
    if (existing.status === 'approved_pending_apply') {
      return {
        status: 'awaiting_apply',
        interactionId: existing.id,
        note:
          'A matching relay authorization request has already been approved and is waiting for the relay to apply it. Wait for that update instead of creating another request.',
      };
    }
    return {
      status: 'already_pending',
      interactionId: existing.id,
      note:
        'A matching relay authorization request is already pending in this conversation. Wait for an authorized user to approve or reject it instead of creating another request.',
    };
  }

  const activeUsers = buildActiveConversationUsers(members);
  const authorizerCandidates = await Promise.all(
    activeUsers.map(async (candidate) => ({
      candidate,
      allowed: await authorizeAction({
        subject: { type: 'user', id: candidate.userId },
        action: 'relay_device.authorize_runtime_access',
        resourceId: relayTarget.deviceId,
      }),
    })),
  );
  const availableAuthorizers = authorizerCandidates
    .filter((entry) => entry.allowed)
    .map((entry) => entry.candidate);

  if (availableAuthorizers.length === 0) {
    return {
      status: 'no_authorizer',
      note:
        'This relay tool requires user approval, but no active user in this conversation is currently allowed to authorize runtime access for that relay device.',
    };
  }

  const interaction = await createRelayAuthorizationInteractionRequest({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    requesterMemberId: requesterMember.id,
    requesterActorId: params.actorId,
    requesterUserId: params.userId,
    relayDeviceId: relayTarget.deviceId,
    relayExposureId: relayTarget.exposureId,
    runtimeSessionId: relayTarget.runtimeSessionId,
    relayToolName: params.relayToolName,
    duration,
    reason: buildAuthorizationReason({
      visibleToolName: relayTarget.visibleToolName,
      requestedScope,
    }),
    requestedScope,
  });

  const authorizerMessage =
    availableAuthorizers.length === 1
      ? `${availableAuthorizers[0]!.name} can approve or reject it.`
      : `${availableAuthorizers.length} current conversation users can approve or reject it.`;

  return {
    status: 'created',
    interactionId: interaction.id,
    note: `A ${duration === 'persistent' ? 'persistent' : 'session-scoped'} relay authorization request was created automatically in this conversation. ${authorizerMessage} Wait for a decision instead of calling request_relay_authorization again for the same scope unless you need a different path, access level, or duration.`,
  };
}
