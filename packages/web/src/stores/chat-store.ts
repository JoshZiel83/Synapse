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
  sendMessage: (workspaceId: string, groupId: string, content: string, attachments?: Attachment[]) => Promise<void>;
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
        attachments: m.metadata?.attachments,
      }));
      set({ messages, loadingMessages: false });
    } catch (err) {
      console.error('Failed to load messages:', err);
      set({ loadingMessages: false });
    }
  },

  sendMessage: async (workspaceId, groupId, content, attachments) => {
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
      await api.sendGroupMessage(workspaceId, groupId, content, attachments);
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

    // Extract toolsUsed, serverToolCalls, and attachments from metadata
    const toolsUsed = metadata?.toolsUsed as string[] | undefined;
    const serverToolCalls = metadata?.serverToolCalls as ServerToolCall[] | undefined;
    const citationSources = metadata?.citationSources as Record<string, { url: string; title: string }> | undefined;
    const attachments = metadata?.attachments as Attachment[] | undefined;

    // If this group is selected, append the message (avoid duplicates)
    if (state.selectedGroupId === rootSessionId) {
      set((s) => {
        const exists = s.messages.some((m) => m.id === messageId);
        if (exists) return s;

        // Remove optimistic temp messages when server confirms the user message
        let messages = s.messages;
        if (role === 'user' && fromUserId) {
          messages = messages.filter((m) => !(m.id.startsWith('temp-') && m.role === 'user'));
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
              attachments,
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
    const { rootSessionId, status, errorMessage } = payload;

    // Update group status
    set((s) => ({
      groups: s.groups.map((g) =>
        g.id === rootSessionId ? { ...g, status } : g
      ),
    }));

    // On failure: clear thinking indicator and inject an error message into the chat
    if (status === 'failed') {
      set((s) => {
        const newMap = { ...s.thinkingMap };
        delete newMap[rootSessionId];

        // Only inject if this group is currently selected
        if (s.selectedGroupId !== rootSessionId) {
          return { thinkingMap: newMap };
        }

        const errMsg: GroupMessage = {
          id: `error-${Date.now()}`,
          sessionId: rootSessionId,
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
