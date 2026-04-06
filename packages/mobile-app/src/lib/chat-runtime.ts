import { Platform } from "react-native";

import { api } from "@/lib/api";
import {
  buildPreviewTextFromItem,
  createEmptyChatWorkspaceSnapshot,
  getConversationMetaOrDefault,
  mergeChatItems,
  updateConversationInSnapshot,
  upsertChatConversation,
  upsertChatConversations,
  type ChatWorkspaceSnapshot,
  type PendingChatOutboxMessage,
} from "@/lib/chat-data";
import { createChatPersistence } from "@/lib/chat-persistence";
import type { ChatComposerSendPayload } from "@/lib/chat-compose";
import { getDeviceLabel } from "@/lib/config";
import { createId } from "@/lib/ids";
import {
  extractText,
  summarizeConversationEvent,
  type ChatConversationCreateResponse,
  type ChatConversationItem,
  type ChatConversationMessagesPage,
  type ChatConversationReadWatermarkResponse,
  type ChatSocketEvent,
  type ChatSyncEvent,
} from "@shared";

export type ChatRuntimeStatus = "idle" | "loading" | "ready";

export interface ChatRuntimeState {
  status: ChatRuntimeStatus;
  syncing: boolean;
  error: string | null;
  activeWorkspaceId: string | null;
  snapshot: ChatWorkspaceSnapshot | null;
}

type ChatRuntimeListener = (state: ChatRuntimeState) => void;

function clearDeliveredOutbox(
  outbox: ChatWorkspaceSnapshot["outbox"],
  items: ChatConversationItem[],
) {
  const deliveredClientIds = new Set(
    items
      .map((item) => item.clientMessageId)
      .filter((value): value is string => Boolean(value)),
  );
  if (deliveredClientIds.size === 0) {
    return outbox;
  }

  const nextOutbox = { ...outbox };
  for (const clientMessageId of deliveredClientIds) {
    delete nextOutbox[clientMessageId];
  }
  return nextOutbox;
}

function shouldIncrementUnreadCount(
  conversation: Parameters<typeof updateConversationInSnapshot>[0]["conversations"][number],
  item: ChatConversationItem,
) {
  return (
    item.itemType === "message" &&
    item.scope === "shared" &&
    item.surface === "visible" &&
    item.authorParticipantId !== conversation.viewerParticipantId
  );
}

function patchInteractionInConversationItem(
  item: ChatConversationItem,
  payload: ChatSyncEvent<"interaction.updated">["payload"],
) {
  if (
    item.itemType !== "event" ||
    item.subtype !== "interaction_requested" ||
    !item.eventPayload ||
    typeof item.eventPayload !== "object"
  ) {
    return item;
  }

  const currentInteraction =
    "interaction" in item.eventPayload
      ? ((item.eventPayload as { interaction?: unknown }).interaction as
          | { id?: string }
          | undefined)
      : undefined;

  if (
    item.id !== payload.itemId &&
    currentInteraction?.id !== payload.interactionId
  ) {
    return item;
  }

  return {
    ...item,
    eventPayload: {
      ...(item.eventPayload as Record<string, unknown>),
      interaction: payload.interaction,
    },
  };
}

export class ChatRuntime {
  private readonly persistence = createChatPersistence();
  private readonly listeners = new Set<ChatRuntimeListener>();
  private persistPromise: Promise<void> = Promise.resolve();
  private syncPromise: Promise<void> | null = null;
  private initializePromise: Promise<void> | null = null;
  private state: ChatRuntimeState = {
    status: "idle",
    syncing: false,
    error: null,
    activeWorkspaceId: null,
    snapshot: null,
  };

  subscribe(listener: ChatRuntimeListener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState() {
    return this.state;
  }

  getSnapshot() {
    return this.state.snapshot;
  }

  deactivate() {
    this.initializePromise = null;
    this.syncPromise = null;
    this.replaceState({
      status: "idle",
      syncing: false,
      error: null,
      activeWorkspaceId: null,
      snapshot: null,
    });
  }

  async clearLocalState() {
    await this.persistence.clearAllWorkspaceSnapshots();
    this.deactivate();
  }

  async reloadPersistedSnapshot(workspaceId?: string | null) {
    const targetWorkspaceId = workspaceId ?? this.state.activeWorkspaceId;
    if (!targetWorkspaceId) {
      return null;
    }

    const persisted = await this.persistence.loadWorkspaceSnapshot(targetWorkspaceId);
    if (this.state.activeWorkspaceId !== targetWorkspaceId) {
      return persisted;
    }

    this.replaceSnapshot(
      persisted ?? createEmptyChatWorkspaceSnapshot(targetWorkspaceId),
    );
    return persisted;
  }

  async ensureWorkspace(workspaceId: string) {
    if (
      this.state.activeWorkspaceId === workspaceId &&
      this.state.status === "ready" &&
      this.state.snapshot
    ) {
      return;
    }

    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.initializePromise = this.initializeWorkspace(workspaceId).finally(() => {
      this.initializePromise = null;
    });

    return this.initializePromise;
  }

  async refreshInbox() {
    const workspaceId = this.state.activeWorkspaceId;
    if (!workspaceId) {
      return;
    }

    await this.bootstrapWorkspace(workspaceId);
  }

  async syncFromServer() {
    const current = this.state.snapshot;
    if (!current?.workspaceId) {
      return;
    }
    const workspaceId = current.workspaceId;

    if (this.syncPromise) {
      return this.syncPromise;
    }

    this.replaceState({
      ...this.state,
      syncing: true,
    });

    this.syncPromise = (async () => {
      try {
        let cursor = this.state.snapshot?.inboxCursor ?? 0;
        let hasMore = true;

        while (hasMore) {
          if (this.state.activeWorkspaceId !== workspaceId) {
            return;
          }

          const response = await api.getChatSync(current.workspaceId, {
            cursor,
            limit: 200,
          });

          for (const event of response.events) {
            if (this.state.activeWorkspaceId !== workspaceId) {
              return;
            }
            this.applyChatEvent(event);
          }

          cursor = response.nextCursor;
          hasMore = response.hasMore;
        }

        if (this.state.activeWorkspaceId !== workspaceId) {
          return;
        }

        await this.flushPendingReads();
        await this.flushOutbox();
      } finally {
        this.syncPromise = null;
        this.replaceState({
          ...this.state,
          syncing: false,
        });
      }
    })();

    return this.syncPromise;
  }

  handleSocketConnected() {
    void this.syncFromServer();
  }

  handleSocketEvent(event: ChatSocketEvent | Record<string, unknown>) {
    if (event.type === "chat.sync.event") {
      this.applyChatEvent((event as ChatSocketEvent<"chat.sync.event">).payload);
    }
  }

  async refreshConversation(conversationId: string) {
    const current = this.state.snapshot;
    if (!current?.workspaceId) {
      return null;
    }

    const response = await api.getChatConversationMessages(
      current.workspaceId,
      conversationId,
      {
        clientInstanceId: current.clientInstanceId ?? undefined,
        limit: 100,
      },
    );

    this.updateSnapshot((snapshotValue) => ({
      ...snapshotValue,
      outbox: clearDeliveredOutbox(snapshotValue.outbox, response.items),
      conversations: upsertChatConversation(
        snapshotValue.conversations,
        response.conversation,
      ),
      itemsByConversationId: {
        ...snapshotValue.itemsByConversationId,
        [conversationId]: mergeChatItems(
          snapshotValue.itemsByConversationId[conversationId] ?? [],
          response.items,
        ),
      },
      metaByConversationId: {
        ...snapshotValue.metaByConversationId,
        [conversationId]: {
          readWatermarkSequence: response.participantReadWatermarkSequence,
          hasMoreBefore: response.hasMoreBefore,
          hasLoadedLatest: true,
          lastFetchedAt: new Date().toISOString(),
        },
      },
    }));

    return response;
  }

  async loadOlderMessages(conversationId: string) {
    const current = this.state.snapshot;
    if (!current?.workspaceId) {
      return;
    }

    const existingItems = current.itemsByConversationId[conversationId] ?? [];
    const earliestSequence = existingItems[0]?.sequence;
    if (!earliestSequence) {
      await this.refreshConversation(conversationId);
      return;
    }

    const response = await api.getChatConversationMessages(
      current.workspaceId,
      conversationId,
      {
        clientInstanceId: current.clientInstanceId ?? undefined,
        beforeSequence: earliestSequence,
        limit: 100,
      },
    );

    this.updateSnapshot((snapshotValue) => ({
      ...snapshotValue,
      conversations: upsertChatConversation(
        snapshotValue.conversations,
        response.conversation,
      ),
      itemsByConversationId: {
        ...snapshotValue.itemsByConversationId,
        [conversationId]: mergeChatItems(
          snapshotValue.itemsByConversationId[conversationId] ?? [],
          response.items,
        ),
      },
      metaByConversationId: {
        ...snapshotValue.metaByConversationId,
        [conversationId]: {
          ...getConversationMetaOrDefault(snapshotValue, conversationId),
          readWatermarkSequence: Math.max(
            getConversationMetaOrDefault(snapshotValue, conversationId)
              .readWatermarkSequence,
            response.participantReadWatermarkSequence,
          ),
          hasMoreBefore: response.hasMoreBefore,
          lastFetchedAt: new Date().toISOString(),
        },
      },
    }));
  }

  async markConversationRead(
    conversationId: string,
    readUpToSequence: number,
    lastVisibleSequence?: number,
  ) {
    const current = this.state.snapshot;
    if (!current?.workspaceId) {
      return;
    }

    const normalizedReadUpToSequence = Math.max(0, Math.floor(readUpToSequence));
    const normalizedLastVisibleSequence = Math.max(
      normalizedReadUpToSequence,
      Math.floor(lastVisibleSequence ?? normalizedReadUpToSequence),
    );

    this.updateSnapshot((snapshotValue) =>
      updateConversationInSnapshot(
        {
          ...snapshotValue,
          pendingReads: {
            ...snapshotValue.pendingReads,
            [conversationId]: {
              conversationId,
              readUpToSequence: Math.max(
                normalizedReadUpToSequence,
                snapshotValue.pendingReads[conversationId]?.readUpToSequence ?? 0,
              ),
              lastVisibleSequence: Math.max(
                normalizedLastVisibleSequence,
                snapshotValue.pendingReads[conversationId]?.lastVisibleSequence ?? 0,
              ),
              updatedAt: new Date().toISOString(),
            },
          },
          metaByConversationId: {
            ...snapshotValue.metaByConversationId,
            [conversationId]: {
              ...getConversationMetaOrDefault(snapshotValue, conversationId),
              readWatermarkSequence: Math.max(
                getConversationMetaOrDefault(snapshotValue, conversationId)
                  .readWatermarkSequence,
                normalizedReadUpToSequence,
              ),
            },
          },
        },
        conversationId,
        (conversation) => ({
          ...conversation,
          unreadCount: 0,
        }),
      ),
    );

    if (!current.clientInstanceId) {
      return;
    }

    try {
      const response = await api.updateChatConversationReadWatermark(
        current.workspaceId,
        conversationId,
        {
          clientInstanceId: current.clientInstanceId,
          readUpToSequence: normalizedReadUpToSequence,
          lastVisibleSequence: normalizedLastVisibleSequence,
        },
      );
      this.applyReadWatermarkAck(response);
    } catch {
      // Keep the pending read queued for the next sync/connection.
    }
  }

  async sendMessage(conversationId: string, input: ChatComposerSendPayload) {
    const current = this.state.snapshot;
    if (!current?.workspaceId) {
      throw new Error("No active workspace");
    }

    const existingItems = current.itemsByConversationId[conversationId] ?? [];
    const existingOutbox = Object.values(current.outbox).filter(
      (entry) => entry.conversationId === conversationId,
    );
    const optimisticSequence =
      Math.max(
        Date.now() * 1000,
        ...existingItems.map((item) => item.sequence),
        ...existingOutbox.map((item) => item.optimisticSequence),
        0,
      ) + 1;

    const clientMessageId = createId("message");
    const outboxEntry: PendingChatOutboxMessage = {
      clientMessageId,
      conversationId,
      contentBlocks: input.contentBlocks,
      replyToItemId: input.replyToItemId,
      replyTo: input.replyTo,
      createdAt: new Date().toISOString(),
      optimisticSequence,
      status: "sending",
      attemptCount: 0,
    };

    this.updateSnapshot((snapshotValue) => ({
      ...snapshotValue,
      outbox: {
        ...snapshotValue.outbox,
        [clientMessageId]: outboxEntry,
      },
    }));

    await this.flushOutbox();
  }

  async createConversation(input: {
    workspaceId?: string;
    kind: "group" | "private" | "virtual";
    title?: string;
    actorIds?: string[];
    workspaceMemberIds?: string[];
    boundary?: "internal" | "external";
  }): Promise<ChatConversationCreateResponse> {
    const workspaceId = input.workspaceId ?? this.state.activeWorkspaceId;
    if (!workspaceId) {
      throw new Error("No active workspace");
    }

    const response = await api.createChatConversation(workspaceId, {
      clientRequestId: createId("conversation"),
      kind: input.kind,
      title: input.title,
      actorIds: input.actorIds ?? [],
      workspaceMemberIds: input.workspaceMemberIds ?? [],
      boundary: input.boundary,
    });

    if (this.state.activeWorkspaceId === workspaceId) {
      this.updateSnapshot((snapshotValue) => ({
        ...snapshotValue,
        conversations: upsertChatConversation(
          snapshotValue.conversations,
          response.conversation,
        ),
      }));
    }

    return response;
  }

  private replaceState(nextState: ChatRuntimeState) {
    this.state = nextState;
    for (const listener of this.listeners) {
      listener(nextState);
    }
  }

  private replaceSnapshot(nextSnapshot: ChatWorkspaceSnapshot | null) {
    const nextState = {
      ...this.state,
      snapshot: nextSnapshot,
    };
    this.replaceState(nextState);

    if (nextSnapshot) {
      this.persistPromise = this.persistPromise
        .then(() => this.persistence.saveWorkspaceSnapshot(nextSnapshot))
        .catch(() => undefined);
    }
  }

  private updateSnapshot(
    updater: (current: ChatWorkspaceSnapshot) => ChatWorkspaceSnapshot,
  ) {
    const current = this.state.snapshot;
    if (!current) {
      return null;
    }

    const nextSnapshot = updater(current);
    this.replaceSnapshot(nextSnapshot);
    return nextSnapshot;
  }

  private async initializeWorkspace(workspaceId: string) {
    this.replaceState({
      ...this.state,
      activeWorkspaceId: workspaceId,
      status: "loading",
      error: null,
    });

    const persisted = await this.persistence.loadWorkspaceSnapshot(workspaceId);
    if (this.state.activeWorkspaceId !== workspaceId) {
      return;
    }

    this.replaceState({
      ...this.state,
      activeWorkspaceId: workspaceId,
      status: "ready",
      error: null,
      snapshot: persisted ?? createEmptyChatWorkspaceSnapshot(workspaceId),
    });

    if (this.state.snapshot) {
      this.persistPromise = this.persistPromise
        .then(() => this.persistence.saveWorkspaceSnapshot(this.state.snapshot!))
        .catch(() => undefined);
    }

    try {
      await this.bootstrapWorkspace(workspaceId);
    } catch (error) {
      if (this.state.activeWorkspaceId !== workspaceId) {
        return;
      }

      this.replaceState({
        ...this.state,
        error:
          error instanceof Error ? error.message : "消息同步初始化失败。",
      });
    }
  }

  private async bootstrapWorkspace(workspaceId: string) {
    const bootstrap = await api.getChatBootstrap(workspaceId);
    if (this.state.activeWorkspaceId !== workspaceId) {
      return;
    }

    let baseSnapshot =
      this.state.snapshot ?? createEmptyChatWorkspaceSnapshot(workspaceId);
    if (
      baseSnapshot.workspaceMemberId &&
      baseSnapshot.workspaceMemberId !== bootstrap.workspaceMemberId
    ) {
      baseSnapshot = createEmptyChatWorkspaceSnapshot(workspaceId);
    }

    const clientInstanceId = baseSnapshot.clientInstanceId ?? createId("client");
    await api.registerChatClientInstance(workspaceId, clientInstanceId, {
      platform: Platform.OS,
      deviceLabel: getDeviceLabel(),
      metadata: {
        workspaceMemberId: bootstrap.workspaceMemberId,
      },
    });

    this.replaceSnapshot({
      ...baseSnapshot,
      workspaceId,
      workspaceMemberId: bootstrap.workspaceMemberId,
      clientInstanceId,
      inboxCursor: Math.max(baseSnapshot.inboxCursor, bootstrap.nextInboxCursor),
      lastBootstrappedAt: new Date().toISOString(),
      conversations: upsertChatConversations(
        baseSnapshot.conversations,
        bootstrap.conversations,
      ),
    });

    this.replaceState({
      ...this.state,
      status: "ready",
      error: null,
    });

    await this.syncFromServer();
  }

  private applyReadWatermarkAck(
    response: ChatConversationReadWatermarkResponse,
  ) {
    this.updateSnapshot((current) => {
      const pendingReads = { ...current.pendingReads };
      const queued = pendingReads[response.conversationId];
      if (
        queued &&
        queued.readUpToSequence <= response.readWatermarkSequence
      ) {
        delete pendingReads[response.conversationId];
      }

      return updateConversationInSnapshot(
        {
          ...current,
          pendingReads,
          metaByConversationId: {
            ...current.metaByConversationId,
            [response.conversationId]: {
              ...getConversationMetaOrDefault(current, response.conversationId),
              readWatermarkSequence: Math.max(
                getConversationMetaOrDefault(current, response.conversationId)
                  .readWatermarkSequence,
                response.readWatermarkSequence,
              ),
            },
          },
        },
        response.conversationId,
        (conversation) => ({
          ...conversation,
          unreadCount: 0,
        }),
      );
    });
  }

  private applyChatEvent(event: ChatSyncEvent) {
    this.updateSnapshot((current) => {
      let nextSnapshot: ChatWorkspaceSnapshot = {
        ...current,
        inboxCursor: Math.max(current.inboxCursor, event.syncSeq),
      };

      switch (event.eventType) {
        case "conversation.upsert": {
          const payload = event.payload as ChatSyncEvent<"conversation.upsert">["payload"];
          nextSnapshot = {
            ...nextSnapshot,
            conversations: upsertChatConversation(
              nextSnapshot.conversations,
              payload.conversation,
            ),
          };
          break;
        }
        case "conversation.item.created": {
          const { conversationId, item } =
            event.payload as ChatSyncEvent<"conversation.item.created">["payload"];
          const currentItems = nextSnapshot.itemsByConversationId[conversationId] ?? [];
          const alreadyExists = currentItems.some((entry) => entry.id === item.id);
          const nextItems = mergeChatItems(currentItems, [item]);

          nextSnapshot = {
            ...nextSnapshot,
            outbox: clearDeliveredOutbox(nextSnapshot.outbox, [item]),
            itemsByConversationId: {
              ...nextSnapshot.itemsByConversationId,
              [conversationId]: nextItems,
            },
          };

          nextSnapshot = updateConversationInSnapshot(
            nextSnapshot,
            conversationId,
            (entry) => ({
              ...entry,
              unreadCount:
                !alreadyExists && shouldIncrementUnreadCount(entry, item)
                  ? entry.unreadCount + 1
                  : entry.unreadCount,
              updatedAt: item.createdAt,
              lastItem: {
                itemId: item.id,
                sequence: item.sequence,
                itemType: item.itemType,
                subtype: item.subtype,
                previewText: buildPreviewTextFromItem(item),
                authorParticipantId: item.authorParticipantId,
                author: item.author,
                createdAt: item.createdAt,
              },
            }),
          );
          break;
        }
        case "conversation.read.updated": {
          const payload =
            event.payload as ChatSyncEvent<"conversation.read.updated">["payload"];
          if (payload.workspaceMemberId !== current.workspaceMemberId) {
            break;
          }

          const pendingReads = { ...nextSnapshot.pendingReads };
          const queued = pendingReads[payload.conversationId];
          if (
            queued &&
            queued.readUpToSequence <= payload.readWatermarkSequence
          ) {
            delete pendingReads[payload.conversationId];
          }

          nextSnapshot = updateConversationInSnapshot(
            {
              ...nextSnapshot,
              pendingReads,
              metaByConversationId: {
                ...nextSnapshot.metaByConversationId,
                [payload.conversationId]: {
                  ...getConversationMetaOrDefault(
                    nextSnapshot,
                    payload.conversationId,
                  ),
                  readWatermarkSequence: Math.max(
                    getConversationMetaOrDefault(
                      nextSnapshot,
                      payload.conversationId,
                    ).readWatermarkSequence,
                    payload.readWatermarkSequence,
                  ),
                },
              },
            },
            payload.conversationId,
            (conversation) => ({
              ...conversation,
              unreadCount: 0,
            }),
          );
          break;
        }
        case "interaction.updated": {
          const payload =
            event.payload as ChatSyncEvent<"interaction.updated">["payload"];
          const currentItems =
            nextSnapshot.itemsByConversationId[payload.conversationId] ?? [];
          const nextItems = currentItems.map((item) =>
            patchInteractionInConversationItem(item, payload),
          );

          nextSnapshot = {
            ...nextSnapshot,
            itemsByConversationId: {
              ...nextSnapshot.itemsByConversationId,
              [payload.conversationId]: nextItems,
            },
          };

          nextSnapshot = updateConversationInSnapshot(
            nextSnapshot,
            payload.conversationId,
            (conversation) => ({
              ...conversation,
              lastItem:
                payload.itemId &&
                conversation.lastItem?.itemId === payload.itemId
                  ? {
                      ...conversation.lastItem,
                      previewText: summarizeConversationEvent(
                        "interaction_requested",
                        {
                          interaction: payload.interaction,
                        },
                      ),
                    }
                  : conversation.lastItem,
            }),
          );
          break;
        }
      }

      return nextSnapshot;
    });
  }

  private async flushPendingReads() {
    const current = this.state.snapshot;
    if (!current?.workspaceId || !current.clientInstanceId) {
      return;
    }

    const pendingReads = Object.values(current.pendingReads).sort(
      (left, right) => left.readUpToSequence - right.readUpToSequence,
    );

    for (const entry of pendingReads) {
      try {
        const response = await api.updateChatConversationReadWatermark(
          current.workspaceId,
          entry.conversationId,
          {
            clientInstanceId: current.clientInstanceId,
            readUpToSequence: entry.readUpToSequence,
            lastVisibleSequence: entry.lastVisibleSequence,
          },
        );
        this.applyReadWatermarkAck(response);
      } catch {
        break;
      }
    }
  }

  private async flushOutbox() {
    const current = this.state.snapshot;
    if (!current?.workspaceId || !current.clientInstanceId) {
      return;
    }

    const entries = Object.values(current.outbox).sort(
      (left, right) => left.optimisticSequence - right.optimisticSequence,
    );

    for (const entry of entries) {
      this.updateSnapshot((snapshotValue) => ({
        ...snapshotValue,
        outbox: {
          ...snapshotValue.outbox,
          [entry.clientMessageId]: {
            ...snapshotValue.outbox[entry.clientMessageId]!,
            attemptCount:
              snapshotValue.outbox[entry.clientMessageId]!.attemptCount + 1,
            lastAttemptAt: new Date().toISOString(),
          },
        },
      }));

      try {
        const response = await api.sendChatConversationMessage(
          current.workspaceId,
          entry.conversationId,
          {
            clientInstanceId: current.clientInstanceId,
            clientMessageId: entry.clientMessageId,
            contentBlocks: entry.contentBlocks,
            replyToItemId: entry.replyToItemId,
          },
        );

        this.updateSnapshot((snapshotValue) => {
          const nextOutbox = { ...snapshotValue.outbox };
          delete nextOutbox[entry.clientMessageId];

          const nextItems = mergeChatItems(
            snapshotValue.itemsByConversationId[entry.conversationId] ?? [],
            [response.item],
          );

          return updateConversationInSnapshot(
            {
              ...snapshotValue,
              outbox: nextOutbox,
              itemsByConversationId: {
                ...snapshotValue.itemsByConversationId,
                [entry.conversationId]: nextItems,
              },
            },
            entry.conversationId,
            (conversation) => ({
              ...conversation,
              updatedAt: response.item.createdAt,
              lastItem: {
                itemId: response.item.id,
                sequence: response.item.sequence,
                itemType: response.item.itemType,
                subtype: response.item.subtype,
                previewText: buildPreviewTextFromItem(response.item),
                authorParticipantId: response.item.authorParticipantId,
                author: response.item.author,
                createdAt: response.item.createdAt,
              },
            }),
          );
        });
      } catch (error) {
        this.updateSnapshot((snapshotValue) => ({
          ...snapshotValue,
          outbox: {
            ...snapshotValue.outbox,
            [entry.clientMessageId]: {
              ...snapshotValue.outbox[entry.clientMessageId]!,
              status: "retrying",
              firstFailedAt:
                snapshotValue.outbox[entry.clientMessageId]!.firstFailedAt ??
                new Date().toISOString(),
              lastErrorMessage:
                error instanceof Error ? error.message : "发送失败",
            },
          },
        }));
        break;
      }
    }
  }
}

export function createChatRuntime() {
  return new ChatRuntime();
}

export const chatRuntime = createChatRuntime();
