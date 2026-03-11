'use client';
import { create } from 'zustand';
import { api } from '@/lib/api';

export interface GroupParticipant {
  id: string;
  name: string;
  role: string;
  emoji?: string;
}

export interface Group {
  id: string;
  status: 'active' | 'completed' | 'failed';
  participants: GroupParticipant[];
  lastMessage?: { content: string; role: string; actorName?: string; createdAt: string };
  unreadCount: number;
  createdAt: string;
  title?: string;
}

export interface ServerToolCall {
  type: 'web_search' | 'web_fetch';
  query?: string;
  url?: string;
  results?: { url: string; title: string; pageAge?: string }[];
}

export interface Attachment {
  id: string;
  url: string;
  fullUrl?: string;
  storedName?: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface GroupMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
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
  attachments?: Attachment[];
  coordination?: boolean; // true for send_to inter-actor messages
  targetActorNames?: string[]; // names of @mentioned actors
}

interface ThinkingState {
  actorId: string;
  actorName: string;
  status?: string;
}

interface ChatState {
  groups: Group[];
  selectedGroupId: string | null;
  messages: GroupMessage[];
  loadingGroups: boolean;
  loadingMessages: boolean;
  thinkingMap: Record<string, ThinkingState>; // keyed by groupId
  totalUnread: number;

  loadGroups: (workspaceId: string) => Promise<void>;
  selectGroup: (groupId: string | null) => void;
  loadMessages: (workspaceId: string, groupId: string) => Promise<void>;
  sendMessage: (workspaceId: string, groupId: string, content: string, attachments?: Attachment[], targetActorIds?: string[]) => Promise<void>;
  createGroup: (workspaceId: string, actorIds: string[], content?: string, targetActorId?: string) => Promise<string>;
  markRead: (workspaceId: string, groupId: string) => Promise<void>;

  // WS handlers
  handleNewMessage: (payload: any) => void;
  handleStatusChanged: (payload: any) => void;
  handleThinking: (payload: any) => void;
  handleGroupUpdated: (payload: any) => void;
  handleMemberJoined: (payload: any) => void;
  handleMemberKicked: (payload: any) => void;
  handleActorVersionChanged: (payload: any) => void;
}

// Helper to extract groupId from payload (supports both groupId and rootSessionId)
function getGroupId(payload: any): string | undefined {
  return payload.groupId || payload.rootSessionId;
}

export const useChatStore = create<ChatState>((set, get) => ({
  groups: [],
  selectedGroupId: null,
  messages: [],
  loadingGroups: false,
  loadingMessages: false,
  thinkingMap: {},
  totalUnread: 0,

  loadGroups: async (workspaceId) => {
    set({ loadingGroups: true });
    try {
      const res = await api.getGroups(workspaceId);
      const groups = res?.groups || [];
      const totalUnread = groups.reduce((sum: number, g: any) => sum + (g.unreadCount || 0), 0);
      // Recover thinking states from server (persisted in Redis)
      const serverThinking = res?.thinkingMap || {};
      set((s) => ({
        groups,
        totalUnread,
        loadingGroups: false,
        thinkingMap: { ...serverThinking, ...s.thinkingMap },
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
        // API returns pre-transformed fields: role, fromActorId, actorName, createdAt
        // Fall back to raw DB fields for backward compatibility
        const role = m.role || (
          (m.sender_type || m.senderType) === 'user' ? 'user'
          : (m.sender_type || m.senderType) === 'actor' ? 'assistant'
          : 'system'
        );
        return {
          id: m.id,
          sessionId: m.sessionId || m.sender_session_id || '',
          role,
          content: m.content,
          fromActorId: m.fromActorId || m.sender_actor_id,
          fromUserId: m.fromUserId || m.sender_user_id,
          actorName: role === 'user' ? undefined : (m.actorName || m.sender_name),
          createdAt: m.createdAt || m.created_at,
          status: 'sent' as const,
          toolsUsed: m.metadata?.toolsUsed,
          serverToolCalls: m.metadata?.serverToolCalls,
          citationSources: m.metadata?.citationSources,
          attachments: m.metadata?.attachments,
          coordination: !!m.metadata?.coordination,
          targetActorNames: m.targetActorNames || m.target_actor_names,
        };
      });
      set({ messages, loadingMessages: false });
    } catch (err) {
      console.error('Failed to load messages:', err);
      set({ loadingMessages: false });
    }
  },

  sendMessage: async (workspaceId, groupId, content, attachments, targetActorIds) => {
    // Optimistic insert
    const tempId = `temp-${Date.now()}`;
    const optimisticMsg: GroupMessage = {
      id: tempId,
      sessionId: '',
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      status: 'sending',
      attachments,
    };
    set((state) => ({
      messages: [...state.messages, optimisticMsg],
    }));

    try {
      await api.sendGroupMessage(workspaceId, groupId, content, attachments, targetActorIds);
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
                lastMessage: { content, role: 'user', createdAt: new Date().toISOString() },
                status: 'active' as const,
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

    const { sessionId, role, content, fromActorId, fromActorName, messageId, fromUserId, metadata,
            senderType, senderActorId, senderUserId, senderName, targetUserIds } = payload;

    // Determine role from either old format (role) or new format (senderType)
    const effectiveRole = role || (senderType === 'user' ? 'user' : senderType === 'actor' ? 'assistant' : 'system');
    const effectiveFromActorId = fromActorId || senderActorId;
    const effectiveFromUserId = fromUserId || senderUserId;
    const effectiveActorName = fromActorName || senderName;

    const state = get();

    // Skip system messages
    if (effectiveRole === 'system' || effectiveRole === 'tool_result' || effectiveRole === 'child_result') {
      return;
    }

    // Visibility filter: actor messages without current user in targetUserIds are not for us
    // (coordination messages between actors — user can't see them)
    if (effectiveRole === 'assistant' && targetUserIds && Array.isArray(targetUserIds) && targetUserIds.length === 0) {
      // Actor sent to other actors only, not to any user — skip for frontend
      return;
    }

    // Clear thinking for this group when assistant responds
    if (effectiveRole === 'assistant') {
      set((s) => {
        const newMap = { ...s.thinkingMap };
        delete newMap[groupId];
        return { thinkingMap: newMap };
      });
    }

    // Extract toolsUsed, serverToolCalls, and attachments from metadata
    const toolsUsed = metadata?.toolsUsed as string[] | undefined;
    const serverToolCalls = metadata?.serverToolCalls as ServerToolCall[] | undefined;
    const citationSources = metadata?.citationSources as Record<string, { url: string; title: string }> | undefined;
    const attachments = metadata?.attachments as Attachment[] | undefined;
    const coordination = !!metadata?.coordination;
    const targetActorNames = payload.targetActorNames as string[] | undefined;

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
              content: content || '',
              fromActorId: effectiveFromActorId,
              actorName: effectiveActorName,
              createdAt: new Date().toISOString(),
              status: 'sent' as const,
              toolsUsed,
              serverToolCalls,
              citationSources,
              attachments,
              coordination,
              targetActorNames,
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
        return {
          ...g,
          lastMessage: { content: content || '', role: effectiveRole, actorName: effectiveActorName, createdAt: new Date().toISOString() },
          status: 'active' as const,
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
    const { status, errorMessage } = payload;

    // Map session status to group-level status
    let groupStatus = status;
    if (status === 'sleeping') groupStatus = 'active'; // sleeping actors = group still usable
    if (status === 'active') groupStatus = 'active';

    // Update group status
    set((s) => ({
      groups: s.groups.map((g) =>
        g.id === groupId ? { ...g, status: groupStatus } : g
      ),
    }));

    // On failure: clear thinking indicator and inject an error message into the chat
    if (status === 'failed') {
      set((s) => {
        const newMap = { ...s.thinkingMap };
        delete newMap[groupId];

        // Only inject if this group is currently selected
        if (s.selectedGroupId !== groupId) {
          return { thinkingMap: newMap };
        }

        const errMsg: GroupMessage = {
          id: `error-${Date.now()}`,
          sessionId: '',
          role: 'error',
          content: errorMessage || 'An unexpected error occurred while processing your request.',
          createdAt: new Date().toISOString(),
        };

        return {
          thinkingMap: newMap,
          messages: [...s.messages, errMsg],
        };
      });
    }
  },

  handleThinking: (payload) => {
    const groupId = getGroupId(payload);
    if (!groupId) return;
    const { actorId, actorName, status } = payload;
    set((s) => ({
      thinkingMap: {
        ...s.thinkingMap,
        [groupId]: { actorId, actorName, status },
      },
    }));
  },

  handleGroupUpdated: (payload) => {
    const groupId = getGroupId(payload);
    if (!groupId) return;
    const { newParticipant, action } = payload;

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
    const { actorId, actorName } = payload;

    const state = get();

    // Add to participants list if not already present
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== groupId) return g;
        if (actorId && !g.participants.some((p) => p.id === actorId)) {
          return {
            ...g,
            participants: [...g.participants, { id: actorId, name: actorName || 'Unknown', role: 'specialist' }],
          };
        }
        return g;
      }),
    }));

    // Insert system message if this group is selected
    if (state.selectedGroupId === groupId) {
      set((s) => ({
        messages: [
          ...s.messages,
          {
            id: `sys-join-${Date.now()}`,
            sessionId: '',
            role: 'system',
            content: `${actorName || 'An actor'} joined the group`,
            createdAt: new Date().toISOString(),
          },
        ],
      }));
    }
  },

  handleMemberKicked: (payload) => {
    const groupId = payload.groupId;
    if (!groupId) return;
    const { actorId, actorName } = payload;

    const state = get();

    // Remove from participants list
    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== groupId) return g;
        return {
          ...g,
          participants: g.participants.filter((p) => p.id !== actorId),
        };
      }),
    }));

    // Insert system message if this group is selected
    if (state.selectedGroupId === groupId) {
      set((s) => ({
        messages: [
          ...s.messages,
          {
            id: `sys-kick-${Date.now()}`,
            sessionId: '',
            role: 'system',
            content: `${actorName || 'An actor'} was removed from the group`,
            createdAt: new Date().toISOString(),
          },
        ],
      }));
    }
  },

  handleActorVersionChanged: (payload) => {
    const { actorId, name: actorName } = payload;
    const state = get();

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
            createdAt: new Date().toISOString(),
          },
        ],
      }));
    }
  },
}));
