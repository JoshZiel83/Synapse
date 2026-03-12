import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CanonicalContentBlock } from '@synapse/shared';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { query } from '../../infrastructure/database/index.js';
import { redis } from '../../infrastructure/redis/index.js';
import {
  createGroup, getGroupsByWorkspace, getGroupMessages,
  sendGroupMessage, markGroupRead, cancelGroup, getGroupMembers,
  removeActorFromGroup,
} from './service.js';

const sendGroupMessageSchema = z.object({
  content: z.string().max(10000).optional().default(''),
  contentBlocks: z.array(z.any()).optional(),
  targetActorIds: z.array(z.string().uuid()).optional(),
}).refine(
  (body) => body.content.trim().length > 0 || (Array.isArray(body.contentBlocks) && body.contentBlocks.length > 0),
  { message: 'content or contentBlocks is required' },
);

export default async function groupController(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // List groups for current user
  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/workspaces/:workspaceId/chat/groups',
    async (request, reply) => {
      const userId = (request as any).user!.userId;
      const { workspaceId } = request.params;
      const rawGroups = await getGroupsByWorkspace(workspaceId, userId);

      // Transform to frontend format
      const groups = await Promise.all(rawGroups.map(async (row: any) => {
        // Get participants
        const members = await getGroupMembers(row.id);
        const participants = members
          .filter((m: any) => m.actor_id)
          .map((m: any) => ({
            id: m.actor_id,
            name: m.actor_name || 'Unknown',
            role: m.actor_role || 'specialist',
            emoji: undefined as string | undefined, // will be populated below
          }));

        // Get emojis
        if (participants.length > 0) {
          const actorIds = participants.map((p: any) => p.id);
          const actorResult = await query(
            `SELECT id, config->>'avatar_emoji' as emoji FROM actors WHERE id = ANY($1)`,
            [actorIds]
          );
          for (const a of actorResult.rows) {
            const p = participants.find((pp: any) => pp.id === a.id);
            if (p) p.emoji = a.emoji;
          }
        }

        const hasActive = members.some((m: any) => m.session_status === 'active');
        const hasSleeping = members.some((m: any) => m.session_status === 'sleeping');
        const derivedName = row.title
          || participants.map((participant: any) => participant.name).filter(Boolean).join(', ')
          || row.last_message?.substring(0, 100)
          || 'Untitled conversation';

        return {
          id: row.id,
          status: hasActive ? 'active' : hasSleeping ? 'active' : 'completed',
          participants,
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
        };
      }));

      // Recover thinking states from Redis
      const activeGroupIds = groups.filter((g: any) => g.status === 'active').map((g: any) => g.id);
      const thinkingMap: Record<string, any> = {};
      if (activeGroupIds.length > 0) {
        const keys = activeGroupIds.map((id: string) => `thinking:${id}`);
        const values = await redis.mget(...keys);
        for (let i = 0; i < activeGroupIds.length; i++) {
          if (values[i]) {
            try {
              thinkingMap[activeGroupIds[i]] = JSON.parse(values[i]!);
            } catch { /* ignore */ }
          }
        }
      }

      return reply.send({ groups, thinkingMap });
    }
  );

  // Create group — accepts { actorId } or { actorIds }, content is optional
  app.post<{ Params: { workspaceId: string }; Body: any }>(
    '/api/v1/workspaces/:workspaceId/chat/groups',
    async (request, reply) => {
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
      const userId = (request as any).user!.userId;
      const limit = parseInt(request.query.limit || '100', 10);
      const before = request.query.before;
      const messages = await getGroupMessages(request.params.groupId, { userId }, limit, before);
      return reply.send({ messages });
    }
  );

  // Send message to group — targetActorIds optional (defaults to all actors)
  app.post<{ Params: { workspaceId: string; groupId: string }; Body: any }>(
    '/api/v1/workspaces/:workspaceId/chat/groups/:groupId/messages',
    async (request, reply) => {
      const body = sendGroupMessageSchema.parse(request.body) as {
        content: string;
        contentBlocks?: CanonicalContentBlock[];
        targetActorIds?: string[];
      };
      const userId = (request as any).user!.userId;
      const { groupId } = request.params;

      const msg = await sendGroupMessage({
        groupId,
        senderType: 'user',
        senderUserId: userId,
        targetActorIds: body.targetActorIds,
        targetUserIds: [],
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
      const userId = (request as any).user!.userId;
      await markGroupRead(userId, request.params.groupId);
      return reply.status(204).send();
    }
  );

  // Cancel group (stop all actors)
  app.delete<{ Params: { workspaceId: string; groupId: string } }>(
    '/api/v1/workspaces/:workspaceId/chat/groups/:groupId',
    async (request, reply) => {
      await cancelGroup(request.params.groupId);
      return reply.status(204).send();
    }
  );

  // Get group members
  app.get<{ Params: { workspaceId: string; groupId: string } }>(
    '/api/v1/workspaces/:workspaceId/chat/groups/:groupId/members',
    async (request, reply) => {
      const members = await getGroupMembers(request.params.groupId);
      return reply.send({ members });
    }
  );

  // Remove actor from group (kick)
  app.delete<{ Params: { workspaceId: string; groupId: string; actorId: string } }>(
    '/api/v1/workspaces/:workspaceId/chat/groups/:groupId/members/:actorId',
    async (request, reply) => {
      const { groupId, actorId } = request.params;
      await removeActorFromGroup(groupId, actorId);
      return reply.status(204).send();
    }
  );
}
