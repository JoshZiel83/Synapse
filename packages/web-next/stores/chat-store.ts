'use client';
import { create } from 'zustand';
import { api } from '@/lib/api';
import type { ActorRuntimeState, CanonicalContentBlock } from '@synapse/shared';
import { extractText, normalizeCanonicalContentBlocks, textBlocks } from '@synapse/shared';

export interface GroupParticipant {
  id: string;
  name: string;
  role: string;
  emoji?: string;
  avatarUrl?: string;
  title?: string;
}

export interface GroupMember {
  memberId: string;
  type: 'actor' | 'user';
  id: string;
  name: string;
  role?: string;
  title?: string;
  emoji?: string;
  avatarUrl?: string;
  sessionStatus?: string;
}

export interface Group {
  id: string;
  status: 'active' | 'completed' | 'failed';
  participants: GroupParticipant[];
  members: GroupMember[];
  lastMessage?: { content: string; role: string; actorName?: string; createdAt: string };
  unreadCount: number;
  createdAt: string;
  title?: string;
  name?: string;
  avatarUrl?: string;
  permissions?: {
    canManage?: boolean;
    canManageMembers?: boolean;
  };
}

export interface ServerToolCall {
  type: 'web_search' | 'web_fetch';
  query?: string;
  url?: string;
  results?: { url: string; title: string; pageAge?: string }[];
}

export interface GroupMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  contentBlocks: CanonicalContentBlock[];
  fromActorId?: string;
  fromUserId?: string;
  actorName?: string;
  actorRole?: string;
  actorEmoji?: string;
  createdAt: string;
  status?: 'sending' | 'sent';
  toolsUsed?: string[];
  serverToolCalls?: ServerToolCall[];
  citationSources?: Record<string, { url: string; title: string }>;
  coordination?: boolean; // true for send_to inter-actor messages
  targetActorIds?: string[];
  targetUserIds?: string[];
}

export type ThinkingPhase = 'thinking' | 'tool' | 'responding' | 'error';
export type ActorAvatarStatus = 'idle' | ThinkingPhase;
export type GroupRuntimeMap = Record<string, Record<string, ActorRuntimeState>>;

interface ChatState {
  groups: Group[];
  selectedGroupId: string | null;
  messages: GroupMessage[];
  loadingGroups: boolean;
  loadingMessages: boolean;
  runtimeMap: GroupRuntimeMap; // keyed by groupId -> actorId
  totalUnread: number;

  loadGroups: (workspaceId: string) => Promise<void>;
  selectGroup: (groupId: string | null) => void;
  loadMessages: (workspaceId: string, groupId: string) => Promise<void>;
  sendMessage: (workspaceId: string, groupId: string, contentBlocks: CanonicalContentBlock[], targetActorIds?: string[]) => Promise<void>;
  createGroup: (workspaceId: string, actorIds: string[], content?: string, targetActorId?: string) => Promise<string>;
  markRead: (workspaceId: string, groupId: string) => Promise<void>;

  // WS handlers
  handleNewMessage: (payload: any) => void;
  handleStatusChanged: (payload: any) => void;
  handleThinking: (payload: any) => void;
  handleActorRuntimeUpdated: (payload: any) => void;
  handleGroupUpdated: (payload: any) => void;
  handleMemberJoined: (payload: any) => void;
  handleMemberKicked: (payload: any) => void;
  handleActorVersionChanged: (payload: any) => void;
}

// WS chat events always target a group conversation.
function getGroupId(payload: any): string | undefined {
  return payload.groupId;
}

function normalizeContentBlocks(payload: any): CanonicalContentBlock[] {
  const blocks = payload.contentBlocks;
  if (Array.isArray(blocks)) {
    return normalizeCanonicalContentBlocks(blocks);
  }
  return [];
}

export function runtimePhaseToBadgePhase(runtime?: ActorRuntimeState): ThinkingPhase | undefined {
  if (!runtime) return undefined;
  if (runtime.health === 'error' || runtime.phase === 'error') return 'error';
  if (runtime.phase === 'tool') return 'tool';
  if (runtime.phase === 'responding') return 'responding';
  if (runtime.phase === 'thinking' || runtime.laneState === 'running' || runtime.laneState === 'queued') {
    return 'thinking';
  }
  return undefined;
}

export function runtimeToAvatarStatus(runtime?: ActorRuntimeState): ActorAvatarStatus | undefined {
  if (!runtime) return undefined;
  return runtimePhaseToBadgePhase(runtime) || 'idle';
}

function applyRuntimeToGroupMembers(group: Group, runtime: ActorRuntimeState): Group {
  return {
    ...group,
    members: group.members.map((member) => (
      member.type === 'actor' && member.id === runtime.actorId
        ? { ...member, sessionStatus: runtime.laneState }
        : member
    )),
  };
}

function deriveGroupStatus(group: Group, runtimesForGroup?: Record<string, ActorRuntimeState>) {
  const actorMembers = group.members.filter((member) => member.type === 'actor');
  if (actorMembers.length === 0) return 'completed' as const;
  const hasOpenLane = actorMembers.some((member) => {
    const runtime = runtimesForGroup?.[member.id];
    const laneState = runtime?.laneState || member.sessionStatus;
    return laneState !== 'closed';
  });
  return hasOpenLane ? 'active' as const : 'completed' as const;
}

function applyRuntimeMapToGroup(group: Group, runtimesForGroup?: Record<string, ActorRuntimeState>): Group {
  if (!runtimesForGroup) {
    return {
      ...group,
      status: deriveGroupStatus(group, undefined),
    };
  }

  let nextGroup = group;
  for (const runtime of Object.values(runtimesForGroup)) {
    nextGroup = applyRuntimeToGroupMembers(nextGroup, runtime);
  }

  return {
    ...nextGroup,
    status: deriveGroupStatus(nextGroup, runtimesForGroup),
  };
}

export const useChatStore = create<ChatState>((set, get) => ({
  groups: [],
  selectedGroupId: null,
  messages: [],
  loadingGroups: false,
  loadingMessages: false,
  runtimeMap: {},
  totalUnread: 0,

  loadGroups: async (workspaceId) => {
    set({ loadingGroups: true });
    try {
      const res = await api.getGroups(workspaceId);
      const groups = res?.groups || [];
      const totalUnread = groups.reduce((sum: number, g: any) => sum + (g.unreadCount || 0), 0);
      const serverRuntime = res?.runtimeMap || {};
      set((s) => ({
        groups: groups.map((group: Group) => applyRuntimeMapToGroup(group, serverRuntime[group.id] || s.runtimeMap[group.id])),
        totalUnread,
        loadingGroups: false,
        runtimeMap: { ...serverRuntime, ...s.runtimeMap },
      }));
    } catch (err) {
      console.error('Failed to load groups:', err);
      set({ loadingGroups: false });
    }
  },

  selectGroup: (groupId) => {
    const state = get();
    if (state.selectedGroupId === groupId) return;
    set({ selectedGroupId: groupId, messages: [] });
  },

  loadMessages: async (workspaceId, groupId) => {
    set({ loadingMessages: true });
    try {
      const res = await api.getGroupMessages(workspaceId, groupId, 100);
      const messages = (res?.messages || []).map((m: any) => {
        const contentBlocks = normalizeContentBlocks(m);
        return {
          id: m.id,
          sessionId: m.sessionId || '',
          role: m.role,
          contentBlocks,
          content: extractText(contentBlocks),
          fromActorId: m.fromActorId,
          fromUserId: m.fromUserId,
          actorName: m.actorName,
          createdAt: m.createdAt,
          status: 'sent' as const,
          toolsUsed: m.metadata?.toolsUsed,
          serverToolCalls: m.metadata?.serverToolCalls,
          citationSources: m.metadata?.citationSources,
          coordination: !!m.metadata?.coordination,
          targetActorIds: m.targetActorIds,
          targetUserIds: m.targetUserIds,
        };
      });
      set({ messages, loadingMessages: false });
    } catch (err) {
      console.error('Failed to load messages:', err);
      set({ loadingMessages: false });
    }
  },

  sendMessage: async (workspaceId, groupId, contentBlocks, targetActorIds) => {
    // Optimistic insert
    const tempId = `temp-${Date.now()}`;
    const optimisticMsg: GroupMessage = {
      id: tempId,
      sessionId: '',
      role: 'user',
      content: extractText(contentBlocks),
      contentBlocks,
      createdAt: new Date().toISOString(),
      status: 'sending',
      targetActorIds,
    };
    set((state) => ({
      messages: [...state.messages, optimisticMsg],
    }));

    try {
      await api.sendGroupMessage(workspaceId, groupId, contentBlocks, targetActorIds);
      // Update optimistic message status
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === tempId ? { ...m, status: 'sent' as const } : m
        ),
      }));
      // Update group's last message
      set((state) => ({
        groups: state.groups.map((g) =>
          g.id === groupId
            ? {
                ...g,
                lastMessage: { content: extractText(contentBlocks), role: 'user', createdAt: new Date().toISOString() },
                status: deriveGroupStatus(g, state.runtimeMap[groupId]),
              }
            : g
        ),
      }));
    } catch (err) {
      console.error('Failed to send message:', err);
      // Remove optimistic message on failure
      set((state) => ({
        messages: state.messages.filter((m) => m.id !== tempId),
      }));
      throw err;
    }
  },

  createGroup: async (workspaceId, actorIds, content, targetActorId) => {
    const res = await api.createGroup(workspaceId, actorIds, content, targetActorId);
    const groupId = res.id || res.sessionId;
    // Reload groups to get the new group
    await get().loadGroups(workspaceId);
    return groupId;
  },

  markRead: async (workspaceId, groupId) => {
    try {
      await api.markGroupRead(workspaceId, groupId);
      set((state) => {
        const groups = state.groups.map((g) =>
          g.id === groupId ? { ...g, unreadCount: 0 } : g
        );
        const totalUnread = groups.reduce((sum, g) => sum + g.unreadCount, 0);
        return { groups, totalUnread };
      });
    } catch (err) {
      console.error('Failed to mark read:', err);
    }
  },

  handleNewMessage: (payload) => {
    const groupId = getGroupId(payload);
    if (!groupId) return;

    const { sessionId, role, fromActorId, messageId, fromUserId, metadata, actorName } = payload;
    const messageContentBlocks = normalizeContentBlocks(payload);
    const effectiveRole = role;
    const effectiveFromActorId = fromActorId;
    const effectiveFromUserId = fromUserId;
    const effectiveActorName = actorName;

    const state = get();

    if (effectiveRole === 'tool_result' || effectiveRole === 'child_result') {
      return;
    }

    const eventType = (payload as any).eventType as string | undefined;
    const eventPayload = ((payload as any).eventPayload || {}) as Record<string, unknown>;
    const noticeType = eventType || (metadata?.noticeType as string | undefined);
    const noticeActorId = (eventPayload.actorId as string | undefined) || (metadata?.actorId as string | undefined);
    const newActorName = (eventPayload.newName as string | undefined) || (metadata?.newName as string | undefined);
    const avatarEmoji = (eventPayload.avatarEmoji as string | undefined) || (metadata?.avatarEmoji as string | undefined);

    // Extract structured metadata for message chrome
    const toolsUsed = metadata?.toolsUsed as string[] | undefined;
    const serverToolCalls = metadata?.serverToolCalls as ServerToolCall[] | undefined;
    const citationSources = metadata?.citationSources as Record<string, { url: string; title: string }> | undefined;
    const coordination = !!metadata?.coordination;
    const targetActorIds = payload.targetActorIds as string[] | undefined;
    const targetUserIds = payload.targetUserIds as string[] | undefined;

    // If this group is selected, append the message (avoid duplicates)
    if (state.selectedGroupId === groupId) {
      set((s) => {
        const exists = s.messages.some((m) => m.id === messageId);
        if (exists) return s;

        // Remove optimistic temp messages when server confirms the user message
        let messages = s.messages;
        if (effectiveRole === 'user' && effectiveFromUserId) {
          messages = messages.filter((m) => !(m.id.startsWith('temp-') && m.role === 'user'));
        }

        return {
          messages: [
            ...messages,
            {
              id: messageId || `ws-${Date.now()}`,
              sessionId: sessionId || '',
              role: effectiveRole,
              contentBlocks: messageContentBlocks,
              content: extractText(messageContentBlocks),
              fromActorId: effectiveFromActorId,
              fromUserId: effectiveFromUserId,
              actorName: effectiveActorName,
              createdAt: payload.createdAt || new Date().toISOString(),
              status: 'sent' as const,
              toolsUsed,
              serverToolCalls,
              citationSources,
              coordination,
              targetActorIds,
              targetUserIds,
            },
          ],
        };
      });
    }

    // Update group list
    set((s) => {
      let groups = s.groups.map((g) => {
        if (g.id !== groupId) return g;
        const unreadCount = s.selectedGroupId === groupId ? g.unreadCount : g.unreadCount + 1;
        let participants = g.participants;
        let members = g.members;
        if (noticeType === 'actor_renamed' && noticeActorId && newActorName) {
          participants = participants.map((participant) => (
            participant.id === noticeActorId
              ? { ...participant, name: newActorName }
              : participant
          ));
          members = members.map((member) => (
            member.type === 'actor' && member.id === noticeActorId
              ? { ...member, name: newActorName }
              : member
          ));
        }
        if (noticeType === 'actor_avatar_changed' && noticeActorId && avatarEmoji) {
          participants = participants.map((participant) => (
            participant.id === noticeActorId
              ? { ...participant, emoji: avatarEmoji }
              : participant
          ));
          members = members.map((member) => (
            member.type === 'actor' && member.id === noticeActorId
              ? { ...member, emoji: avatarEmoji }
              : member
          ));
        }
        return {
          ...g,
          participants,
          members,
          lastMessage: {
            content: extractText(messageContentBlocks),
            role: effectiveRole,
            actorName: effectiveActorName,
            createdAt: payload.createdAt || new Date().toISOString(),
          },
          status: deriveGroupStatus(g, s.runtimeMap[groupId]),
          unreadCount,
        };
      });
      // Sort by last activity
      groups = groups.sort((a, b) => {
        const aTime = a.lastMessage?.createdAt || a.createdAt;
        const bTime = b.lastMessage?.createdAt || b.createdAt;
        return new Date(bTime).getTime() - new Date(aTime).getTime();
      });
      const totalUnread = groups.reduce((sum, g) => sum + g.unreadCount, 0);
      return { groups, totalUnread };
    });
  },

  handleStatusChanged: (payload) => {
    const groupId = getGroupId(payload);
    if (!groupId) return;
    const { status, errorMessage, actorId, actorName, phase } = payload;
    set((s) => {
      const nextRuntimeForGroup = actorId
        ? {
            ...(s.runtimeMap[groupId] || {}),
            [actorId]: {
              groupId,
              sessionId: payload.sessionId || '',
              actorId,
              actorName: actorName || 'Unknown',
              laneState: status,
              health: status === 'blocked' ? 'error' : 'ok',
              phase: phase || (status === 'blocked' ? 'error' : 'idle'),
              pendingWakeupCount: 0,
              activeWakeups: [],
              updatedAt: payload.createdAt || new Date().toISOString(),
              ...(status === 'blocked' && errorMessage
                ? {
                    lastError: {
                      message: errorMessage,
                      at: payload.createdAt || new Date().toISOString(),
                    },
                  }
                : {}),
            } satisfies ActorRuntimeState,
          }
        : (s.runtimeMap[groupId] || {});
      const runtimeMap = actorId
        ? {
            ...s.runtimeMap,
            [groupId]: nextRuntimeForGroup,
          }
        : s.runtimeMap;
      const groups = s.groups.map((group) => {
        if (group.id !== groupId) return group;
        return applyRuntimeMapToGroup(group, nextRuntimeForGroup);
      });

      if (status !== 'blocked' || s.selectedGroupId !== groupId) {
        return { groups, runtimeMap };
      }

      const errMsg: GroupMessage = {
        id: `error-${Date.now()}`,
        sessionId: '',
        role: 'error',
        content: errorMessage || 'An unexpected error occurred while processing your request.',
        contentBlocks: textBlocks(errorMessage || 'An unexpected error occurred while processing your request.'),
        createdAt: new Date().toISOString(),
      };

      return {
        groups,
        runtimeMap,
        messages: [...s.messages, errMsg],
      };
    });
  },

  handleThinking: (payload) => {
    const groupId = getGroupId(payload);
    if (!groupId) return;
    const { actorId, actorName, status, phase } = payload;
    set((s) => {
      const currentGroupRuntime = { ...(s.runtimeMap[groupId] || {}) };
      const currentRuntime = currentGroupRuntime[actorId] || null;
      currentGroupRuntime[actorId] = {
        groupId,
        sessionId: payload.sessionId || currentRuntime?.sessionId || '',
        actorId,
        actorName: actorName || currentRuntime?.actorName || 'Unknown',
        laneState: currentRuntime?.laneState || 'running',
        health: currentRuntime?.health || 'ok',
        phase: phase || currentRuntime?.phase || 'thinking',
        statusText: status || currentRuntime?.statusText,
        currentTurnId: currentRuntime?.currentTurnId,
        pendingWakeupCount: currentRuntime?.pendingWakeupCount || 0,
        activeWakeups: currentRuntime?.activeWakeups || [],
        latestWakeupAt: currentRuntime?.latestWakeupAt,
        lastError: currentRuntime?.lastError,
        updatedAt: new Date().toISOString(),
      };
      return {
        runtimeMap: {
          ...s.runtimeMap,
          [groupId]: currentGroupRuntime,
        },
        groups: s.groups.map((group) => (
          group.id === groupId
            ? applyRuntimeMapToGroup(group, currentGroupRuntime)
            : group
        )),
      };
    });
  },

  handleActorRuntimeUpdated: (payload) => {
    const groupId = payload.groupId;
    if (!groupId || !payload.actorId) return;

    set((s) => {
      const nextRuntimeForGroup = {
        ...(s.runtimeMap[groupId] || {}),
        [payload.actorId]: payload as ActorRuntimeState,
      };
      const runtimeMap = {
        ...s.runtimeMap,
        [groupId]: nextRuntimeForGroup,
      };
      const groups = s.groups.map((group) => {
        if (group.id !== groupId) return group;
        return applyRuntimeMapToGroup(group, nextRuntimeForGroup);
      });
      return { runtimeMap, groups };
    });
  },

  handleGroupUpdated: (payload) => {
    const groupId = getGroupId(payload);
    if (!groupId) return;
    const { newParticipant, action, title, avatarUrl } = payload;

    if (action === 'profile_updated') {
      set((s) => ({
        groups: s.groups.map((g) => (
          g.id === groupId
            ? {
                ...g,
                title: title || g.title,
                name: title || g.title,
                avatarUrl: avatarUrl === undefined ? g.avatarUrl : avatarUrl || undefined,
              }
            : g
        )),
      }));
      return;
    }

    if (action === 'member_added' && payload.actorId && payload.actorName) {
      // New member added to group
      set((s) => ({
        groups: s.groups.map((g) => {
          if (g.id !== groupId) return g;
          const exists = g.participants.some((p) => p.id === payload.actorId);
          if (exists) return g;
          return {
            ...g,
            participants: [...g.participants, {
              id: payload.actorId,
              name: payload.actorName,
              role: 'specialist',
            }],
          };
        }),
      }));
      return;
    }

    if (!newParticipant) return;

    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== groupId) return g;
        const exists = g.participants.some((p) => p.id === newParticipant.id);
        if (exists) return g;
        return {
          ...g,
          participants: [...g.participants, newParticipant],
        };
      }),
    }));
  },

  handleMemberJoined: (payload) => {
    const groupId = payload.groupId;
    if (!groupId) return;
    const joinedMembers = Array.isArray(payload.members) && payload.members.length > 0
      ? payload.members
      : (payload.actorId ? [{
          type: 'actor',
          actorId: payload.actorId,
          id: payload.actorId,
          name: payload.actorName || 'Unknown',
        }] : []);

    const state = get();

    // Add to participants list if not already present
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== groupId) return g;
        const nextMembers = [...g.members];
        const nextParticipants = [...g.participants];

        for (const member of joinedMembers) {
          const memberId = member.actorId || member.userId || member.id;
          if (!memberId) continue;

          const normalizedMember: GroupMember = {
            memberId: member.memberId || memberId,
            type: member.type === 'user' ? 'user' : 'actor',
            id: memberId,
            name: member.name || 'Unknown',
            role: member.role,
            title: member.title,
            emoji: member.emoji,
            avatarUrl: member.avatarUrl,
            sessionStatus: member.sessionStatus,
          };

          if (!nextMembers.some((existing) => existing.memberId === normalizedMember.memberId || (existing.type === normalizedMember.type && existing.id === normalizedMember.id))) {
            nextMembers.push(normalizedMember);
          }

          if (normalizedMember.type === 'actor' && !nextParticipants.some((participant) => participant.id === normalizedMember.id)) {
            nextParticipants.push({
              id: normalizedMember.id,
              name: normalizedMember.name,
              role: normalizedMember.role || 'specialist',
              emoji: normalizedMember.emoji,
              avatarUrl: normalizedMember.avatarUrl,
              title: normalizedMember.title,
            });
          }
        }

        return {
          ...g,
          members: nextMembers,
          participants: nextParticipants,
          status: deriveGroupStatus({ ...g, members: nextMembers }, s.runtimeMap[groupId]),
        };
      }),
    }));

    // Insert system message if this group is selected
    if (state.selectedGroupId === groupId) {
      const joinedNames = joinedMembers.map((member: any) => member.name).filter(Boolean);
      set((s) => ({
        messages: [
          ...s.messages,
          {
            id: `sys-join-${Date.now()}`,
            sessionId: '',
            role: 'system',
            content: `${joinedNames.join(', ') || 'A member'} joined the group`,
            contentBlocks: textBlocks(`${joinedNames.join(', ') || 'A member'} joined the group`),
            createdAt: new Date().toISOString(),
          },
        ],
      }));
    }
  },

  handleMemberKicked: (payload) => {
    const groupId = payload.groupId;
    if (!groupId) return;
    const removedMembers = Array.isArray(payload.members) && payload.members.length > 0
      ? payload.members
      : (payload.actorId ? [{
          type: 'actor',
          actorId: payload.actorId,
          id: payload.actorId,
          name: payload.actorName || 'Unknown',
        }] : []);

    const state = get();

    // Remove from participants list
    set((s) => {
      const nextRuntimeForGroup = { ...(s.runtimeMap[groupId] || {}) };
      const groups = s.groups.map((g) => {
        if (g.id !== groupId) return g;
        const removedActorIds = new Set<string>(
          removedMembers
            .filter((member: any) => member.type !== 'user')
            .map((member: any) => member.actorId || member.id)
            .filter((value: string | undefined): value is string => Boolean(value)),
        );
        const removedUserIds = new Set<string>(
          removedMembers
            .filter((member: any) => member.type === 'user')
            .map((member: any) => member.userId || member.id)
            .filter((value: string | undefined): value is string => Boolean(value)),
        );
        for (const actorId of removedActorIds) {
          delete nextRuntimeForGroup[actorId];
        }
        const nextGroup = {
          ...g,
          participants: g.participants.filter((p) => !removedActorIds.has(p.id)),
          members: g.members.filter((member) => (
            member.type === 'actor'
              ? !removedActorIds.has(member.id)
              : !removedUserIds.has(member.id)
          )),
        };
        return {
          ...nextGroup,
          status: deriveGroupStatus(nextGroup, nextRuntimeForGroup),
        };
      });
      return {
        groups,
        runtimeMap: {
          ...s.runtimeMap,
          [groupId]: nextRuntimeForGroup,
        },
      };
    });

    // Insert system message if this group is selected
    if (state.selectedGroupId === groupId) {
      const removedNames = removedMembers.map((member: any) => member.name).filter(Boolean);
      set((s) => ({
        messages: [
          ...s.messages,
          {
            id: `sys-kick-${Date.now()}`,
            sessionId: '',
            role: 'system',
            content: `${removedNames.join(', ') || 'A member'} was removed from the group`,
            contentBlocks: textBlocks(`${removedNames.join(', ') || 'A member'} was removed from the group`),
            createdAt: new Date().toISOString(),
          },
        ],
      }));
    }
  },

  handleActorVersionChanged: (payload) => {
    const { actorId, name: actorName, avatarUrl, avatarEmoji } = payload;
    const state = get();

    set((s) => ({
      runtimeMap: Object.fromEntries(
        Object.entries(s.runtimeMap).map(([groupId, runtimeByActor]) => [
          groupId,
          Object.fromEntries(
            Object.entries(runtimeByActor).map(([runtimeActorId, runtime]) => [
              runtimeActorId,
              runtimeActorId === actorId
                ? {
                    ...runtime,
                    actorName: actorName || runtime.actorName,
                  }
                : runtime,
            ]),
          ),
        ]),
      ),
      groups: s.groups.map((group) => ({
        ...group,
        participants: group.participants.map((participant) => (
          participant.id === actorId
            ? {
                ...participant,
                name: actorName || participant.name,
                avatarUrl: avatarUrl || participant.avatarUrl,
                emoji: avatarEmoji === undefined ? participant.emoji : avatarEmoji,
              }
            : participant
        )),
        members: group.members.map((member) => (
          member.type === 'actor' && member.id === actorId
            ? {
                ...member,
                name: actorName || member.name,
                avatarUrl: avatarUrl || member.avatarUrl,
                emoji: avatarEmoji === undefined ? member.emoji : avatarEmoji,
              }
            : member
        )),
      })),
    }));

    // Find which groups this actor is in and insert a system message if selected
    const relevantGroup = state.groups.find(
      (g) => g.id === state.selectedGroupId && g.participants.some((p) => p.id === actorId)
    );

    if (relevantGroup) {
      set((s) => ({
        messages: [
          ...s.messages,
          {
            id: `sys-version-${Date.now()}`,
            sessionId: '',
            role: 'system',
            content: `${actorName || 'An actor'}'s profile has been updated`,
            contentBlocks: textBlocks(`${actorName || 'An actor'}'s profile has been updated`),
            createdAt: new Date().toISOString(),
          },
        ],
      }));
    }
  },
}));
