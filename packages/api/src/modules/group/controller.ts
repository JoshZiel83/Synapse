import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CanonicalContentBlock } from '@synapse/shared';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { checkPermission, lookupResources } from '../../infrastructure/authz/index.js';
import { query } from '../../infrastructure/database/index.js';
import {
  createGroup, getGroup, getGroupsByWorkspace, getGroupMessages,
  sendGroupMessage, markGroupRead, cancelGroup, getGroupMembers,
  addMembersToGroup,
  issueConversationGrant,
  issueConversationMemoryGrant,
  listConversationGrants,
  listConversationMemoryGrants,
  removeActorFromGroup,
  updateGroupProfile,
  revokeConversationGrant,
  revokeConversationMemoryGrant,
} from './service.js';
import { getGroupRuntimeMap } from '../session/runtime.js';

const sendGroupMessageSchema = z.object({
  content: z.string().max(10000).optional().default(''),
  contentBlocks: z.array(z.any()).optional(),
  clientMessageId: z.string().min(1).max(128).optional(),
  targetActorIds: z.array(z.string().uuid()).optional(),
  targetUserIds: z.array(z.string().uuid()).optional(),
}).refine(
  (body) => body.content.trim().length > 0 || (Array.isArray(body.contentBlocks) && body.contentBlocks.length > 0),
  { message: 'content or contentBlocks is required' },
);

const updateGroupSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  avatarFileId: z.string().uuid().nullable().optional(),
}).refine((body) => body.title !== undefined || body.avatarFileId !== undefined, {
  message: 'At least one of title or avatarFileId is required',
});

const addGroupMembersSchema = z.object({
  actorIds: z.array(z.string().uuid()).optional().default([]),
  userIds: z.array(z.string().uuid()).optional().default([]),
}).refine((body) => body.actorIds.length > 0 || body.userIds.length > 0, {
  message: 'At least one actor or user is required',
});

const conversationMemoryGrantPermissionEnum = z.enum([
  'memory_edit',
  'memory_grant',
  'memory_retarget',
  'memory_delete',
]);

const conversationGrantPermissionEnum = z.enum([
  'send',
  'moderate',
  'manage',
  'manage_members',
  'attach_resources',
]);

const issueConversationGrantSchema = z.object({
  permission: conversationGrantPermissionEnum,
  userId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  reason: z.string().max(1000).optional(),
  metadata: z.record(z.unknown()).optional(),
}).superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if ((value.userId && value.actorId) || (!value.userId && !value.actorId)) {
    invalid('Exactly one of userId or actorId is required');
  }
});

const issueConversationMemoryGrantSchema = z.object({
  permission: conversationMemoryGrantPermissionEnum,
  userId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  reason: z.string().max(1000).optional(),
  metadata: z.record(z.unknown()).optional(),
}).superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if ((value.userId && value.actorId) || (!value.userId && !value.actorId)) {
    invalid('Exactly one of userId or actorId is required');
  }
});

async function requireWorkspacePermission(request: any, reply: any, permission: string, errorMessage: string) {
  const { workspaceId } = request.params as { workspaceId: string };
  const userId = (request as any).user!.userId;

  const allowed = await checkPermission({
    resourceType: 'workspace',
    resourceId: workspaceId,
    permission,
    subject: { type: 'user', id: userId },
  });

  if (!allowed) {
    reply.status(403).send({ error: errorMessage });
    return false;
  }

  return true;
}

async function requireGroupPermission(
  request: any,
  reply: any,
  permission: string,
  errorMessage: string,
) {
  const { workspaceId, groupId } = request.params as { workspaceId: string; groupId: string };
  const group = await getGroup(groupId);

  if (!group || group.workspace_id !== workspaceId) {
    reply.status(404).send({ error: 'Group not found' });
    return null;
  }

  const userId = (request as any).user!.userId;
  const allowed = await checkPermission({
    resourceType: 'conversation',
    resourceId: groupId,
    permission,
    subject: { type: 'user', id: userId },
  });

  if (!allowed) {
    reply.status(403).send({ error: errorMessage });
    return null;
  }

  return group;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function mapMember(row: any) {
  if (row.actor_id) {
    return {
      memberId: row.id,
      type: 'actor',
      actorId: row.actor_id,
      id: row.actor_id,
      name: row.actor_name || 'Unknown',
      title: row.actor_title || undefined,
      role: row.actor_role || 'specialist',
      emoji: row.actor_avatar_emoji || undefined,
      avatarUrl: row.actor_avatar_stored_name ? `/files/${row.actor_avatar_stored_name}` : undefined,
      sessionStatus: row.session_status || undefined,
      state: row.state,
    };
  }

  return {
    memberId: row.id,
    type: 'user',
    userId: row.user_id,
    id: row.user_id,
    name: row.user_name || 'User',
    avatarUrl: row.user_avatar_url || undefined,
    state: row.state,
  };
}

export default async function groupController(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // List groups for current user
  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/workspaces/:workspaceId/chat/groups',
    async (request, reply) => {
      const userId = (request as any).user!.userId;
      const { workspaceId } = request.params;
      const allowed = await requireWorkspacePermission(
        request,
        reply,
        'view',
        'Not allowed to access this workspace',
      );
      if (!allowed) return;

      const groupIds = await lookupResources({
        resourceType: 'conversation',
        permission: 'view',
        subject: { type: 'user', id: userId },
      });
      const rawGroups = await getGroupsByWorkspace(workspaceId, userId, groupIds);

      // Transform to frontend format
      const groups = await Promise.all(rawGroups.map(async (row: any) => {
        const members = (await getGroupMembers(row.id))
          .filter((member: any) => member.state === 'active');
        const mappedMembers = members.map(mapMember);
        const participants = mappedMembers.filter((member: any) => member.type === 'actor');

        const hasOpenLane = members.some((m: any) => m.actor_id && m.session_status !== 'closed');
        const metadata = parseMetadata(row.metadata);
        const derivedName = row.title
          || mappedMembers.map((member: any) => member.name).filter(Boolean).join(', ')
          || row.last_message?.substring(0, 100)
          || 'Untitled conversation';
        const [canManage, canManageMembers] = await Promise.all([
          checkPermission({
            resourceType: 'conversation',
            resourceId: row.id,
            permission: 'manage',
            subject: { type: 'user', id: userId },
          }),
          checkPermission({
            resourceType: 'conversation',
            resourceId: row.id,
            permission: 'manage_members',
            subject: { type: 'user', id: userId },
          }),
        ]);

        return {
          id: row.id,
          status: hasOpenLane ? 'active' : 'completed',
          participants,
          members: mappedMembers,
          lastMessage: row.last_message ? {
            content: row.last_message,
            role: row.last_message_sender_type === 'user' ? 'user' : 'assistant',
            actorName: row.last_message_sender_name,
            createdAt: row.last_message_at,
          } : undefined,
          unreadCount: row.unread_count || 0,
          createdAt: row.created_at,
          title: derivedName,
          name: derivedName,
          avatarUrl: typeof metadata.avatarUrl === 'string' ? metadata.avatarUrl : undefined,
          permissions: {
            canManage,
            canManageMembers,
          },
        };
      }));

      const runtimeMap = await getGroupRuntimeMap(groups.map((group: any) => group.id));
      return reply.send({ groups, runtimeMap });
    }
  );

  // Create group — accepts { actorId } or { actorIds }, content is optional
  app.post<{ Params: { workspaceId: string }; Body: any }>(
    '/api/v1/workspaces/:workspaceId/chat/groups',
    async (request, reply) => {
      const allowed = await requireWorkspacePermission(
        request,
        reply,
        'create_conversation',
        'Not allowed to create conversations in this workspace',
      );
      if (!allowed) return;

      const body = request.body as any;
      const userId = (request as any).user!.userId;
      const { workspaceId } = request.params;

      // Support both single-actor and multi-actor formats
      let actorIds: string[];
      let targetActorId: string | undefined;

      if (body.actorIds) {
        actorIds = body.actorIds;
        targetActorId = body.targetActorId || actorIds[0];
      } else if (body.actorId) {
        actorIds = [body.actorId];
        targetActorId = body.actorId;
      } else {
        return reply.status(400).send({ error: 'actorId or actorIds required' });
      }

      const content = body.content && typeof body.content === 'string' ? body.content : undefined;

      const result = await createGroup({
        workspaceId,
        createdBy: userId,
        actorIds,
        initialMessage: content,
        targetActorId: content ? targetActorId : undefined,
      });

      const members = await getGroupMembers(result.group.id);

      return reply.status(201).send({
        id: result.group.id,
        sessionId: result.group.id,
        group: result.group,
        members,
        status: 'active',
      });
    }
  );

  // Get group messages — transformed to frontend format
  app.get<{ Params: { workspaceId: string; groupId: string }; Querystring: { limit?: string; before?: string } }>(
    '/api/v1/workspaces/:workspaceId/chat/groups/:groupId/messages',
    async (request, reply) => {
      const group = await requireGroupPermission(
        request,
        reply,
        'view',
        'Not allowed to view this conversation',
      );
      if (!group) return;

      const userId = (request as any).user!.userId;
      const limit = parseInt(request.query.limit || '100', 10);
      const before = request.query.before;
      const page = await getGroupMessages(group.id, { userId }, limit, before);
      return reply.send(page);
    }
  );

  // Send message to group — explicit targets are optional.
  app.post<{ Params: { workspaceId: string; groupId: string }; Body: any }>(
    '/api/v1/workspaces/:workspaceId/chat/groups/:groupId/messages',
    async (request, reply) => {
      const group = await requireGroupPermission(
        request,
        reply,
        'send',
        'Not allowed to send messages to this conversation',
      );
      if (!group) return;

      const body = sendGroupMessageSchema.parse(request.body) as {
        content: string;
        contentBlocks?: CanonicalContentBlock[];
        clientMessageId?: string;
        targetActorIds?: string[];
        targetUserIds?: string[];
      };
      const userId = (request as any).user!.userId;

      const msg = await sendGroupMessage({
        groupId: group.id,
        senderType: 'user',
        senderUserId: userId,
        clientMessageId: body.clientMessageId,
        targetActorIds: body.targetActorIds,
        targetUserIds: body.targetUserIds,
        content: body.content,
        contentBlocks: body.contentBlocks,
      });

      return reply.status(201).send(msg);
    }
  );

  // Mark group as read
  app.post<{ Params: { workspaceId: string; groupId: string } }>(
    '/api/v1/workspaces/:workspaceId/chat/groups/:groupId/read',
    async (request, reply) => {
      const group = await requireGroupPermission(
        request,
        reply,
        'view',
        'Not allowed to view this conversation',
      );
      if (!group) return;

      const userId = (request as any).user!.userId;
      await markGroupRead(userId, group.id);
      return reply.status(204).send();
    }
  );

  // Cancel group (stop all actors)
  app.delete<{ Params: { workspaceId: string; groupId: string } }>(
    '/api/v1/workspaces/:workspaceId/chat/groups/:groupId',
    async (request, reply) => {
      const group = await requireGroupPermission(
        request,
        reply,
        'manage',
        'Not allowed to manage this conversation',
      );
      if (!group) return;

      await cancelGroup(group.id);
      return reply.status(204).send();
    }
  );

  app.put<{ Params: { workspaceId: string; groupId: string }; Body: unknown }>(
    '/api/v1/workspaces/:workspaceId/chat/groups/:groupId',
    async (request, reply) => {
      const group = await requireGroupPermission(
        request,
        reply,
        'manage',
        'Not allowed to manage this conversation',
      );
      if (!group) return;

      try {
        const body = updateGroupSchema.parse(request.body);
        const updated = await updateGroupProfile({
          groupId: group.id,
          workspaceId: group.workspace_id,
          updatedBy: (request as any).user!.userId,
          title: body.title,
          avatarFileId: body.avatarFileId,
        });
        return reply.send({ group: updated });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.status(400).send({
            error: 'Validation failed',
            details: error.errors.map((item) => ({
              field: item.path.join('.'),
              message: item.message,
            })),
          });
        }
        return reply.status(400).send({ error: error instanceof Error ? error.message : 'Failed to update group' });
      }
    },
  );

  // Get group members
  app.get<{ Params: { workspaceId: string; groupId: string } }>(
    '/api/v1/workspaces/:workspaceId/chat/groups/:groupId/members',
    async (request, reply) => {
      const group = await requireGroupPermission(
        request,
        reply,
        'view',
        'Not allowed to view this conversation',
      );
      if (!group) return;

      const members = (await getGroupMembers(group.id))
        .filter((member: any) => member.state === 'active')
        .map(mapMember);
      return reply.send({ members });
    }
  );

  app.post<{ Params: { workspaceId: string; groupId: string }; Body: unknown }>(
    '/api/v1/workspaces/:workspaceId/chat/groups/:groupId/members',
    async (request, reply) => {
      const group = await requireGroupPermission(
        request,
        reply,
        'manage_members',
        'Not allowed to manage conversation members',
      );
      if (!group) return;

      try {
        const body = addGroupMembersSchema.parse(request.body);
        const result = await addMembersToGroup({
          groupId: group.id,
          workspaceId: group.workspace_id,
          actorIds: body.actorIds,
          userIds: body.userIds,
        });
        return reply.status(201).send(result);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.status(400).send({
            error: 'Validation failed',
            details: error.errors.map((item) => ({
              field: item.path.join('.'),
              message: item.message,
            })),
          });
        }
        return reply.status(400).send({ error: error instanceof Error ? error.message : 'Failed to add members' });
      }
    },
  );

  // Remove actor from group (kick)
  app.delete<{ Params: { workspaceId: string; groupId: string; actorId: string } }>(
    '/api/v1/workspaces/:workspaceId/chat/groups/:groupId/members/:actorId',
    async (request, reply) => {
      const group = await requireGroupPermission(
        request,
        reply,
        'manage_members',
        'Not allowed to manage conversation members',
      );
      if (!group) return;

      const { groupId, actorId } = request.params;
      await removeActorFromGroup(group.id, actorId);
      return reply.status(204).send();
    }
  );

  app.get<{ Params: { workspaceId: string; groupId: string } }>(
    '/api/v1/workspaces/:workspaceId/chat/groups/:groupId/grants',
    async (request, reply) => {
      const group = await requireGroupPermission(
        request,
        reply,
        'manage',
        'Not allowed to manage conversation permissions',
      );
      if (!group) return;

      const { workspaceId, groupId } = request.params;
      const grants = await listConversationGrants(groupId, workspaceId);
      return reply.send({ grants });
    },
  );

  app.post<{ Params: { workspaceId: string; groupId: string }; Body: unknown }>(
    '/api/v1/workspaces/:workspaceId/chat/groups/:groupId/grants',
    async (request, reply) => {
      const group = await requireGroupPermission(
        request,
        reply,
        'manage',
        'Not allowed to manage conversation permissions',
      );
      if (!group) return;

      try {
        const body = issueConversationGrantSchema.parse(request.body);
        const grant = await issueConversationGrant({
          groupId: group.id,
          workspaceId: group.workspace_id,
          permission: body.permission,
          userId: body.userId,
          actorId: body.actorId,
          grantedBy: (request as any).user!.userId,
          reason: body.reason,
          metadata: body.metadata,
        });
        return reply.status(201).send({ grant });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.status(400).send({
            error: 'Validation failed',
            details: error.errors.map((item) => ({
              field: item.path.join('.'),
              message: item.message,
            })),
          });
        }
        return reply.status(400).send({ error: error instanceof Error ? error.message : 'Failed to issue conversation grant' });
      }
    },
  );

  app.post<{ Params: { workspaceId: string; groupId: string; grantId: string } }>(
    '/api/v1/workspaces/:workspaceId/chat/groups/:groupId/grants/:grantId/revoke',
    async (request, reply) => {
      const group = await requireGroupPermission(
        request,
        reply,
        'manage',
        'Not allowed to manage conversation permissions',
      );
      if (!group) return;

      const { groupId, grantId } = request.params;
      const revoked = await revokeConversationGrant({
        groupId,
        workspaceId: group.workspace_id,
        grantId,
      });
      if (!revoked) {
        return reply.status(404).send({ error: 'Conversation grant not found' });
      }
      return reply.send({ grant: revoked });
    },
  );

  app.get<{ Params: { workspaceId: string; groupId: string } }>(
    '/api/v1/workspaces/:workspaceId/chat/groups/:groupId/memory-grants',
    async (request, reply) => {
      const group = await requireGroupPermission(
        request,
        reply,
        'memory_grant',
        'Not allowed to manage conversation memory permissions',
      );
      if (!group) return;

      const { workspaceId, groupId } = request.params;
      const grants = await listConversationMemoryGrants(groupId, workspaceId);
      return reply.send({ grants });
    },
  );

  app.post<{ Params: { workspaceId: string; groupId: string }; Body: unknown }>(
    '/api/v1/workspaces/:workspaceId/chat/groups/:groupId/memory-grants',
    async (request, reply) => {
      const group = await requireGroupPermission(
        request,
        reply,
        'memory_grant',
        'Not allowed to manage conversation memory permissions',
      );
      if (!group) return;

      try {
        const body = issueConversationMemoryGrantSchema.parse(request.body);
        const grant = await issueConversationMemoryGrant({
          groupId: group.id,
          workspaceId: group.workspace_id,
          permission: body.permission,
          userId: body.userId,
          actorId: body.actorId,
          grantedBy: (request as any).user!.userId,
          reason: body.reason,
          metadata: body.metadata,
        });
        return reply.status(201).send({ grant });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.status(400).send({
            error: 'Validation failed',
            details: error.errors.map((item) => ({
              field: item.path.join('.'),
              message: item.message,
            })),
          });
        }
        return reply.status(400).send({ error: error instanceof Error ? error.message : 'Failed to issue conversation memory grant' });
      }
    },
  );

  app.post<{ Params: { workspaceId: string; groupId: string; grantId: string } }>(
    '/api/v1/workspaces/:workspaceId/chat/groups/:groupId/memory-grants/:grantId/revoke',
    async (request, reply) => {
      const group = await requireGroupPermission(
        request,
        reply,
        'memory_grant',
        'Not allowed to manage conversation memory permissions',
      );
      if (!group) return;

      const { groupId, grantId } = request.params;
      const grant = await revokeConversationMemoryGrant({
        groupId,
        workspaceId: group.workspace_id,
        grantId,
      });
      if (!grant) {
        return reply.status(404).send({ error: 'Conversation memory grant not found' });
      }
      return reply.send({ grant });
    },
  );
}
