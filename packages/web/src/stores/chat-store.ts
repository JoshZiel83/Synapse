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
}

interface ThinkingState {
  actorId: string;
  actorName: string;
  status?: string; // e.g. "Calling AI model...", "Delegating to Developer..."
}

interface ChatState {
  groups: Group[];
  selectedGroupId: string | null;
  messages: GroupMessage[];
  loadingGroups: boolean;
  loadingMessages: boolean;
  thinkingMap: Record<string, ThinkingState>; // keyed by rootSessionId
  totalUnread: number;

  loadGroups: (workspaceId: string) => Promise<void>;
  selectGroup: (groupId: string | null) => void;
  loadMessages: (workspaceId: string, groupId: string) => Promise<void>;
  sendMessage: (workspaceId: string, groupId: string, content: string) => Promise<void>;
  createGroup: (workspaceId: string, actorId: string, content: string) => Promise<string>;
  markRead: (workspaceId: string, groupId: string) => Promise<void>;

  // WS handlers
  handleNewMessage: (payload: any) => void;
  handleStatusChanged: (payload: any) => void;
  handleThinking: (payload: any) => void;
  handleGroupUpdated: (payload: any) => void;
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
      set({ groups, totalUnread, loadingGroups: false });
    } catch (err) {
      console.error('Failed to load groups:', err);
      set({ loadingGroups: false });
    }
  },

  selectGroup: (groupId) => {
    const state = get();
    if (state.selectedGroupId === groupId) return; // don't reset if same group
    set({ selectedGroupId: groupId, messages: [] });
  },

  loadMessages: async (workspaceId, groupId) => {
    set({ loadingMessages: true });
    try {
      const res = await api.getGroupMessages(workspaceId, groupId, 100);
      const messages = (res?.messages || []).map((m: any) => ({
        ...m,
        toolsUsed: m.metadata?.toolsUsed,
        serverToolCalls: m.metadata?.serverToolCalls,
        citationSources: m.metadata?.citationSources,
      }));
      set({ messages, loadingMessages: false });
    } catch (err) {
      console.error('Failed to load messages:', err);
      set({ loadingMessages: false });
    }
  },

  sendMessage: async (workspaceId, groupId, content) => {
    // Optimistic insert
    const tempId = `temp-${Date.now()}`;
    const optimisticMsg: GroupMessage = {
      id: tempId,
      sessionId: '',
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      status: 'sending',
    };
    set((state) => ({
      messages: [...state.messages, optimisticMsg],
    }));

    try {
      await api.sendGroupMessage(workspaceId, groupId, content);
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

  createGroup: async (workspaceId, actorId, content) => {
    const res = await api.createGroup(workspaceId, actorId, content);
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
    const { rootSessionId, sessionId, role, content, fromActorId, fromActorName, messageId, fromUserId, metadata } = payload;
    const state = get();

    // Skip child_result and system messages — they're internal cascade noise
    if (role === 'child_result' || role === 'system' || role === 'tool_result') {
      return;
    }

    // Clear thinking for this group when assistant responds
    if (role === 'assistant') {
      set((s) => {
        const newMap = { ...s.thinkingMap };
        delete newMap[rootSessionId];
        return { thinkingMap: newMap };
      });
    }

    // Extract toolsUsed and serverToolCalls from metadata
    const toolsUsed = metadata?.toolsUsed as string[] | undefined;
    const serverToolCalls = metadata?.serverToolCalls as ServerToolCall[] | undefined;
    const citationSources = metadata?.citationSources as Record<string, { url: string; title: string }> | undefined;

    // If this group is selected, append the message (avoid duplicates)
    if (state.selectedGroupId === rootSessionId) {
      set((s) => {
        const exists = s.messages.some((m) => m.id === messageId);
        if (exists) return s;

        // Remove temp messages from same user if this is a user message confirmation
        let messages = s.messages;
        if (role === 'user' && fromUserId) {
          messages = messages.filter((m) => !(m.status === 'sending' && m.role === 'user'));
        }

        return {
          messages: [
            ...messages,
            {
              id: messageId || `ws-${Date.now()}`,
              sessionId,
              role,
              content,
              fromActorId,
              actorName: fromActorName,
              createdAt: new Date().toISOString(),
              status: 'sent' as const,
              toolsUsed,
              serverToolCalls,
              citationSources,
            },
          ],
        };
      });
    }

    // Update group list
    set((s) => {
      let groups = s.groups.map((g) => {
        if (g.id !== rootSessionId) return g;
        const unreadCount = s.selectedGroupId === rootSessionId ? g.unreadCount : g.unreadCount + 1;
        return {
          ...g,
          lastMessage: { content, role, actorName: fromActorName, createdAt: new Date().toISOString() },
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
    const { rootSessionId, status } = payload;
    set((s) => ({
      groups: s.groups.map((g) =>
        g.id === rootSessionId ? { ...g, status } : g
      ),
    }));
  },

  handleThinking: (payload) => {
    const { rootSessionId, actorId, actorName, status } = payload;
    set((s) => ({
      thinkingMap: {
        ...s.thinkingMap,
        [rootSessionId]: { actorId, actorName, status },
      },
    }));
  },

  handleGroupUpdated: (payload) => {
    const { rootSessionId, newParticipant } = payload;
    if (!newParticipant) return;

    set((s) => ({
      groups: s.groups.map((g) => {
        if (g.id !== rootSessionId) return g;
        const exists = g.participants.some((p) => p.id === newParticipant.id);
        if (exists) return g;
        return {
          ...g,
          participants: [...g.participants, newParticipant],
        };
      }),
    }));
  },
}));
