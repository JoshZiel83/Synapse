import { redis } from '../../infrastructure/redis/index.js';
import {
  createGroup as createGroupService,
  getGroupsByWorkspace,
  getGroupMessages as getGroupMessagesService,
  sendGroupMessage,
  markGroupRead,
  cancelGroup as cancelGroupService,
} from '../group/service.js';
import type { CanonicalContentBlock, UUID } from '@synapse/shared';

/**
 * Chat service — thin wrapper around group service for backward compatibility.
 * All chat functionality now goes through the group model.
 */

export async function listGroups(workspaceId: UUID, userId: UUID) {
  const groups = await getGroupsByWorkspace(workspaceId, userId);

  // Transform to the format expected by the frontend
  const transformedGroups = groups.map((row: any) => ({
    id: row.id,
    status: row.active_count > 0 ? 'active' : 'completed',
    participants: [], // TODO: populate from group_members
    lastMessage: row.last_message ? {
      content: row.last_message,
      createdAt: row.last_message_at,
    } : undefined,
    unreadCount: row.unread_count || 0,
    createdAt: row.created_at,
    title: row.title || row.last_message?.substring(0, 100),
  }));

  // Recover thinking states from Redis for active groups
  const activeGroupIds = transformedGroups.filter((g: any) => g.status === 'active').map((g: any) => g.id);
  const thinkingMap: Record<string, any> = {};
  if (activeGroupIds.length > 0) {
    const keys = activeGroupIds.map((id: string) => `thinking:${id}`);
    const values = await redis.mget(...keys);
    for (let i = 0; i < activeGroupIds.length; i++) {
      if (values[i]) {
        try {
          thinkingMap[activeGroupIds[i]] = JSON.parse(values[i]!);
        } catch { /* ignore parse errors */ }
      }
    }
  }

  return { groups: transformedGroups, thinkingMap };
}

export async function getGroupMessages(groupId: UUID, userId: UUID, limit = 50, before?: string) {
  return getGroupMessagesService(groupId, { userId }, limit, before);
}

export async function sendMessageToGroup(
  workspaceId: UUID,
  groupId: UUID,
  userId: UUID,
  content: string,
  contentBlocks?: CanonicalContentBlock[],
  targetActorIds?: string[],
) {
  return sendGroupMessage({
    groupId,
    senderType: 'user',
    senderUserId: userId,
    targetActorIds,
    targetUserIds: [],
    content,
    contentBlocks,
  });
}

export async function markGroupAsRead(userId: UUID, groupId: UUID) {
  await markGroupRead(userId, groupId);
}

export async function createGroup(
  workspaceId: UUID,
  actorId: UUID,
  userId: UUID,
  content?: string
) {
  const result = await createGroupService({
    workspaceId,
    createdBy: userId,
    actorIds: [actorId],
    initialMessage: content,
    targetActorId: content ? actorId : undefined,
  });

  return {
    id: result.group.id,
    sessionId: result.group.id,
    status: 'active',
  };
}

export async function cancelGroup(groupId: UUID, workspaceId: UUID) {
  await cancelGroupService(groupId);
}
