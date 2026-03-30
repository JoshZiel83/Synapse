import type {
  CanonicalContentBlock,
  ConversationFeedItem,
} from "@shared";
import { extractText } from "@shared";

import { api } from "@/lib/api";
import {
  readStoredValue,
  writeStoredValue,
} from "@/lib/storage";

export type PendingConversationRead = {
  conversationId: string;
  readUpToSequence: number;
  updatedAt: string;
};

export type PendingConversationMessage = {
  clientMessageId: string;
  conversationId: string;
  contentBlocks: CanonicalContentBlock[];
  createdAt: string;
  optimisticSequence: number;
  status: "sending" | "retrying";
  attemptCount: number;
  lastAttemptAt?: string;
  firstFailedAt?: string;
  lastErrorMessage?: string;
};

const PENDING_READS_STORAGE_KEY = "synapse.mobile.chat.reads:v1";
const PENDING_MESSAGES_STORAGE_KEY = "synapse.mobile.chat.outbox:v1";

async function loadEntries<T>(key: string): Promise<T[]> {
  try {
    const raw = await readStoredValue(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as T[] | null;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function persistEntries<T>(key: string, entries: T[]) {
  await writeStoredValue(key, JSON.stringify(entries));
}

async function loadPendingReads() {
  const entries = await loadEntries<PendingConversationRead>(
    PENDING_READS_STORAGE_KEY,
  );
  return Object.fromEntries(entries.map((entry) => [entry.conversationId, entry]));
}

async function persistPendingReadsMap(
  readsMap: Record<string, PendingConversationRead>,
) {
  const entries = Object.values(readsMap).sort(
    (left, right) =>
      new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime(),
  );
  await persistEntries(PENDING_READS_STORAGE_KEY, entries);
}

async function loadPendingMessages() {
  const entries = await loadEntries<PendingConversationMessage>(
    PENDING_MESSAGES_STORAGE_KEY,
  );
  return Object.fromEntries(
    entries.map((entry) => [entry.clientMessageId, entry]),
  );
}

async function persistPendingMessagesMap(
  messagesMap: Record<string, PendingConversationMessage>,
) {
  const entries = Object.values(messagesMap).sort(
    (left, right) => left.optimisticSequence - right.optimisticSequence,
  );
  await persistEntries(PENDING_MESSAGES_STORAGE_KEY, entries);
}

export async function queuePendingConversationRead(
  conversationId: string,
  readUpToSequence: number,
) {
  const readsMap = await loadPendingReads();
  const current = readsMap[conversationId];
  readsMap[conversationId] = {
    conversationId,
    readUpToSequence: Math.max(
      Math.floor(readUpToSequence),
      current?.readUpToSequence || 0,
    ),
    updatedAt: new Date().toISOString(),
  };
  await persistPendingReadsMap(readsMap);
}

export async function clearPendingConversationRead(
  conversationId: string,
  confirmedSequence?: number,
) {
  const readsMap = await loadPendingReads();
  const current = readsMap[conversationId];
  if (!current) return;
  if (
    typeof confirmedSequence === "number" &&
    current.readUpToSequence > Math.floor(confirmedSequence)
  ) {
    return;
  }
  delete readsMap[conversationId];
  await persistPendingReadsMap(readsMap);
}

export async function listPendingConversationReads() {
  return Object.values(await loadPendingReads()).sort(
    (left, right) =>
      new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime(),
  );
}

let readFlushPromise: Promise<void> | null = null;

export async function flushPendingConversationReads() {
  if (readFlushPromise) return readFlushPromise;

  readFlushPromise = (async () => {
    const readsMap = await loadPendingReads();
    const entries = Object.values(readsMap).sort(
      (left, right) => left.readUpToSequence - right.readUpToSequence,
    );

    for (const entry of entries) {
      try {
        await api.markThreadRead(entry.conversationId, entry.readUpToSequence);
        await clearPendingConversationRead(
          entry.conversationId,
          entry.readUpToSequence,
        );
      } catch {
        // Keep queued for the next reconnect.
      }
    }
  })().finally(() => {
    readFlushPromise = null;
  });

  return readFlushPromise;
}

export async function queuePendingConversationMessage(
  entry: PendingConversationMessage,
) {
  const messagesMap = await loadPendingMessages();
  messagesMap[entry.clientMessageId] = entry;
  await persistPendingMessagesMap(messagesMap);
}

export async function clearPendingConversationMessage(clientMessageId: string) {
  const messagesMap = await loadPendingMessages();
  if (!messagesMap[clientMessageId]) return;
  delete messagesMap[clientMessageId];
  await persistPendingMessagesMap(messagesMap);
}

export async function listPendingConversationMessages(conversationId: string) {
  const messagesMap = await loadPendingMessages();
  return Object.values(messagesMap)
    .filter((entry) => entry.conversationId === conversationId)
    .sort((left, right) => left.optimisticSequence - right.optimisticSequence);
}

let messageFlushPromise: Promise<ConversationFeedItem[]> | null = null;

export async function flushPendingConversationMessages(options?: {
  conversationId?: string;
}): Promise<ConversationFeedItem[]> {
  if (messageFlushPromise) return messageFlushPromise;

  messageFlushPromise = (async () => {
    const deliveredItems: ConversationFeedItem[] = [];
    const pendingMessages = Object.values(await loadPendingMessages()).sort(
      (left, right) => left.optimisticSequence - right.optimisticSequence,
    );

    for (const entry of pendingMessages) {
      if (
        options?.conversationId &&
        entry.conversationId !== options.conversationId
      ) {
        continue;
      }

      const messagesMap = await loadPendingMessages();
      const current = messagesMap[entry.clientMessageId];
      if (!current) continue;

      const lastAttemptAt = new Date().toISOString();
      messagesMap[current.clientMessageId] = {
        ...current,
        attemptCount: current.attemptCount + 1,
        lastAttemptAt,
      };
      await persistPendingMessagesMap(messagesMap);

      try {
        const result = await api.sendThreadMessage(
          current.conversationId,
          current.contentBlocks,
          current.clientMessageId,
        );
        if (result?.item) {
          deliveredItems.push(result.item);
        }
        await clearPendingConversationMessage(current.clientMessageId);
      } catch (error) {
        const nextMessagesMap = await loadPendingMessages();
        const next = nextMessagesMap[current.clientMessageId];
        if (!next) continue;
        nextMessagesMap[current.clientMessageId] = {
          ...next,
          status: "retrying",
          firstFailedAt: next.firstFailedAt || new Date().toISOString(),
          lastErrorMessage:
            error instanceof Error ? error.message : "Failed to send message",
        };
        await persistPendingMessagesMap(nextMessagesMap);
      }
    }

    return deliveredItems;
  })().finally(() => {
    messageFlushPromise = null;
  });

  return messageFlushPromise;
}

export function pendingConversationMessageToFeedItem(
  entry: PendingConversationMessage,
): ConversationFeedItem {
  return {
    kind: "message",
    itemId: `temp:${entry.clientMessageId}`,
    conversationId: entry.conversationId,
    sequence: entry.optimisticSequence,
    role: "user",
    messageType: "user_message",
    targets: [],
    content: extractText(entry.contentBlocks),
    contentBlocks: entry.contentBlocks,
    metadata: {
      localDeliveryStatus: entry.status,
      localErrorMessage: entry.lastErrorMessage || null,
      localPending: true,
    },
    createdAt: entry.createdAt,
    clientMessageId: entry.clientMessageId,
  };
}
