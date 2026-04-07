const CHAT_DB_NAME = "synapse-chat";
const CHAT_DB_VERSION = 1;
const CHAT_SNAPSHOT_STORE = "workspace_snapshots";

const CHAT_WORKER_DB_NAME = "synapse-chat-worker";
const CHAT_WORKER_DB_VERSION = 1;
const CHAT_WORKER_STATE_STORE = "auth_context";

const CHAT_BROADCAST_CHANNEL = "synapse.chat.worker";
const CHAT_SYNC_TAG = "synapse-chat-sync";
const CHAT_PERIODIC_SYNC_TAG = "synapse-chat-periodic-sync";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const message = event.data || {};
  switch (message.type) {
    case "chat:set-auth-context":
      event.waitUntil(
        saveAuthContext(message.payload).then(() =>
          runSyncPass(message.payload.workspaceId, "auth-context"),
        ),
      );
      break;
    case "chat:clear-auth-context":
      event.waitUntil(clearAuthContext());
      break;
    case "chat:run-sync":
      event.waitUntil(runSyncPass(null, message.payload && message.payload.reason));
      break;
  }
});

self.addEventListener("sync", (event) => {
  if (event.tag === CHAT_SYNC_TAG) {
    event.waitUntil(runSyncPass(null, "background-sync"));
  }
});

self.addEventListener("periodicsync", (event) => {
  if (event.tag === CHAT_PERIODIC_SYNC_TAG) {
    event.waitUntil(runSyncPass(null, "periodic-sync"));
  }
});

function openDb(name, version, onUpgrade) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      onUpgrade(request.result);
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(dbName, version, storeName, mode, onUpgrade, run) {
  const db = await openDb(dbName, version, onUpgrade);
  try {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = await run(store);
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return result;
  } finally {
    db.close();
  }
}

function createEmptySnapshot(workspaceId) {
  return {
    version: 4,
    workspaceId,
    inboxCursor: 0,
    conversations: [],
    itemsByConversationId: {},
    metaByConversationId: {},
    pendingReads: {},
    outbox: {},
  };
}

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function normalizeSnapshot(workspaceId, value) {
  if (!value || typeof value !== "object") {
    return createEmptySnapshot(workspaceId);
  }

  const snapshot = value;
  if (snapshot.version !== 4 || snapshot.workspaceId !== workspaceId) {
    return createEmptySnapshot(workspaceId);
  }

  return {
    ...createEmptySnapshot(workspaceId),
    ...snapshot,
    version: 4,
    workspaceId,
    clientInstanceId: isUuid(snapshot.clientInstanceId)
      ? snapshot.clientInstanceId
      : undefined,
  };
}

function getConversationMeta(snapshot, conversationId) {
  return (
    snapshot.metaByConversationId[conversationId] || {
      readWatermarkSequence: 0,
      hasMoreBefore: false,
      hasLoadedLatest: false,
    }
  );
}

function sortConversations(conversations) {
  return [...conversations].sort((left, right) => {
    const leftPinned = left.pinnedSortKey ? new Date(left.pinnedSortKey).getTime() : 0;
    const rightPinned = right.pinnedSortKey ? new Date(right.pinnedSortKey).getTime() : 0;
    if (leftPinned !== rightPinned) {
      return rightPinned - leftPinned;
    }

    const leftAt = (left.lastItem && left.lastItem.createdAt) || left.updatedAt || left.createdAt;
    const rightAt = (right.lastItem && right.lastItem.createdAt) || right.updatedAt || right.createdAt;
    return new Date(rightAt).getTime() - new Date(leftAt).getTime();
  });
}

function upsertConversation(conversations, incoming) {
  return sortConversations(
    conversations
      .filter((conversation) => conversation.conversationId !== incoming.conversationId)
      .concat(incoming),
  );
}

function updateConversation(snapshot, conversationId, updater) {
  const current = snapshot.conversations.find(
    (conversation) => conversation.conversationId === conversationId,
  );
  if (!current) {
    return snapshot;
  }

  return {
    ...snapshot,
    conversations: upsertConversation(snapshot.conversations, updater(current)),
  };
}

function sortItems(items) {
  return [...items].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });
}

function mergeItems(existing, incoming) {
  const map = new Map();
  for (const item of existing || []) {
    map.set(item.id, item);
  }
  for (const item of incoming || []) {
    map.set(item.id, item);
  }
  return sortItems([...map.values()]);
}

function extractText(contentBlocks) {
  if (!Array.isArray(contentBlocks)) {
    return "";
  }

  const parts = [];
  for (const block of contentBlocks) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if (typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text.trim());
      continue;
    }
    if (typeof block.content === "string" && block.content.trim()) {
      parts.push(block.content.trim());
      continue;
    }
    if (Array.isArray(block.children)) {
      const nested = extractText(block.children);
      if (nested) {
        parts.push(nested);
      }
    }
  }
  return parts.join(" ").trim();
}

function buildPreviewText(item) {
  if (!item) {
    return "";
  }

  const text = extractText(item.contentBlocks).trim() || (typeof item.content === "string" ? item.content.trim() : "");
  if (text) {
    return text;
  }

  if (item.itemType === "message") {
    return "Attachment";
  }

  if (item.itemType === "event") {
    return item.subtype || "Event";
  }

  return item.subtype ? `[${item.subtype}]` : "";
}

function buildInteractionPreview(interaction) {
  if (!interaction || typeof interaction !== "object") {
    return "Interaction requested";
  }

  if (interaction.kind === "user_input") {
    const targetName =
      interaction.target && typeof interaction.target.name === "string"
        ? interaction.target.name.trim() || "a user"
        : "a user";
    const prompt =
      interaction.userInput && typeof interaction.userInput.title === "string"
        ? interaction.userInput.title.trim() || "A question"
        : "A question";
    if (interaction.status === "cancelled") {
      return `Input request for ${targetName} was cancelled: ${prompt}`;
    }
    return interaction.status === "answered"
      ? `${targetName} answered: ${prompt}`
      : `Input requested from ${targetName}: ${prompt}`;
  }

  if (interaction.kind === "plan_approval") {
    const targetName =
      interaction.target && typeof interaction.target.name === "string"
        ? interaction.target.name.trim() || "a user"
        : "a user";
    const title =
      interaction.planApproval && typeof interaction.planApproval.title === "string"
        ? interaction.planApproval.title.trim() || "Plan approval"
        : "Plan approval";
    if (interaction.status === "cancelled") {
      return `Plan approval for ${targetName} was cancelled: ${title}`;
    }
    if (interaction.status === "approved") {
      return `${targetName} approved: ${title}`;
    }
    if (interaction.status === "rejected") {
      return `${targetName} requested changes: ${title}`;
    }
    return `Plan approval requested from ${targetName}: ${title}`;
  }

  const deviceName =
    interaction.relayAuthorization &&
    typeof interaction.relayAuthorization.deviceDisplayName === "string"
      ? interaction.relayAuthorization.deviceDisplayName.trim() || "relay"
      : "relay";
  if (interaction.status === "cancelled") {
    return `Relay authorization request was cancelled for ${deviceName}`;
  }
  if (interaction.status === "rejected") {
    const resolverName =
      interaction.resolvedBy && typeof interaction.resolvedBy.name === "string"
        ? interaction.resolvedBy.name.trim() || "A user"
        : "A user";
    return `${resolverName} rejected access for ${deviceName}`;
  }
  if (interaction.status === "approved") {
    const resolverName =
      interaction.resolvedBy && typeof interaction.resolvedBy.name === "string"
        ? interaction.resolvedBy.name.trim() || "A user"
        : "A user";
    return `${resolverName} approved access for ${deviceName}`;
  }
  if (interaction.status === "superseded") {
    return `Relay authorization request was superseded for ${deviceName}`;
  }
  return `Relay authorization requested for ${deviceName}`;
}

function patchInteractionItem(item, payload) {
  if (
    !item ||
    item.itemType !== "event" ||
    item.subtype !== "interaction_requested" ||
    !item.eventPayload ||
    typeof item.eventPayload !== "object"
  ) {
    return item;
  }

  const currentInteraction =
    "interaction" in item.eventPayload ? item.eventPayload.interaction : null;
  if (
    item.id !== payload.itemId &&
    (!currentInteraction || currentInteraction.id !== payload.interactionId)
  ) {
    return item;
  }

  return {
    ...item,
    eventPayload: {
      ...item.eventPayload,
      interaction: payload.interaction,
    },
  };
}

function clearDeliveredOutbox(outbox, items) {
  const deliveredClientIds = new Set(
    (items || [])
      .map((item) => item.clientMessageId)
      .filter(Boolean),
  );
  if (deliveredClientIds.size === 0) {
    return outbox;
  }

  const next = { ...outbox };
  for (const clientMessageId of deliveredClientIds) {
    delete next[clientMessageId];
  }
  return next;
}

async function getAuthContext() {
  const row = await withStore(
    CHAT_WORKER_DB_NAME,
    CHAT_WORKER_DB_VERSION,
    CHAT_WORKER_STATE_STORE,
    "readonly",
    (db) => {
      if (!db.objectStoreNames.contains(CHAT_WORKER_STATE_STORE)) {
        db.createObjectStore(CHAT_WORKER_STATE_STORE, { keyPath: "key" });
      }
    },
    (store) => requestToPromise(store.get("active")),
  );

  return row && row.payload ? row.payload : null;
}

async function saveAuthContext(payload) {
  return withStore(
    CHAT_WORKER_DB_NAME,
    CHAT_WORKER_DB_VERSION,
    CHAT_WORKER_STATE_STORE,
    "readwrite",
    (db) => {
      if (!db.objectStoreNames.contains(CHAT_WORKER_STATE_STORE)) {
        db.createObjectStore(CHAT_WORKER_STATE_STORE, { keyPath: "key" });
      }
    },
    (store) =>
      requestToPromise(
        store.put({
          key: "active",
          payload,
          updatedAt: new Date().toISOString(),
        }),
      ),
  );
}

async function clearAuthContext() {
  return withStore(
    CHAT_WORKER_DB_NAME,
    CHAT_WORKER_DB_VERSION,
    CHAT_WORKER_STATE_STORE,
    "readwrite",
    (db) => {
      if (!db.objectStoreNames.contains(CHAT_WORKER_STATE_STORE)) {
        db.createObjectStore(CHAT_WORKER_STATE_STORE, { keyPath: "key" });
      }
    },
    (store) => requestToPromise(store.delete("active")),
  );
}

async function loadWorkspaceSnapshot(workspaceId) {
  const row = await withStore(
    CHAT_DB_NAME,
    CHAT_DB_VERSION,
    CHAT_SNAPSHOT_STORE,
    "readonly",
    (db) => {
      if (!db.objectStoreNames.contains(CHAT_SNAPSHOT_STORE)) {
        db.createObjectStore(CHAT_SNAPSHOT_STORE, { keyPath: "workspaceId" });
      }
    },
    (store) => requestToPromise(store.get(workspaceId)),
  );

  return normalizeSnapshot(workspaceId, row && row.payload);
}

async function saveWorkspaceSnapshot(snapshot) {
  return withStore(
    CHAT_DB_NAME,
    CHAT_DB_VERSION,
    CHAT_SNAPSHOT_STORE,
    "readwrite",
    (db) => {
      if (!db.objectStoreNames.contains(CHAT_SNAPSHOT_STORE)) {
        db.createObjectStore(CHAT_SNAPSHOT_STORE, { keyPath: "workspaceId" });
      }
    },
    (store) =>
      requestToPromise(
        store.put({
          workspaceId: snapshot.workspaceId,
          payload: snapshot,
          updatedAt: new Date().toISOString(),
        }),
      ),
  );
}

async function fetchJson(auth, path, options) {
  const response = await fetch(`${auth.apiBase}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
      ...(options && options.headers ? options.headers : {}),
    },
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error((data && data.error) || "Request failed");
    error.status = response.status;
    throw error;
  }

  return data;
}

async function bootstrapWorkspace(auth, snapshot) {
  const bootstrap = await fetchJson(
    auth,
    `/workspaces/${auth.workspaceId}/chat/bootstrap`,
  );

  let next = snapshot || createEmptySnapshot(auth.workspaceId);
  if (
    next.workspaceMemberId &&
    next.workspaceMemberId !== bootstrap.workspaceMemberId
  ) {
    next = createEmptySnapshot(auth.workspaceId);
  }

  const conversations = bootstrap.conversations.reduce(
    (current, conversation) => upsertConversation(current, conversation),
    next.conversations || [],
  );

  return {
    ...next,
    workspaceId: auth.workspaceId,
    workspaceMemberId: bootstrap.workspaceMemberId,
    clientInstanceId: isUuid(next.clientInstanceId)
      ? next.clientInstanceId
      : undefined,
    inboxCursor: Math.max(next.inboxCursor || 0, bootstrap.nextInboxCursor || 0),
    lastBootstrappedAt: new Date().toISOString(),
    conversations,
  };
}

function applyReadWatermarkAck(snapshot, response) {
  const pendingReads = { ...snapshot.pendingReads };
  const queued = pendingReads[response.conversationId];
  if (queued && queued.readUpToSequence <= response.readWatermarkSequence) {
    delete pendingReads[response.conversationId];
  }

  return updateConversation(
    {
      ...snapshot,
      pendingReads,
      metaByConversationId: {
        ...snapshot.metaByConversationId,
        [response.conversationId]: {
          ...getConversationMeta(snapshot, response.conversationId),
          readWatermarkSequence: Math.max(
            getConversationMeta(snapshot, response.conversationId).readWatermarkSequence,
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
}

function shouldIncrementUnreadCount(conversation, item) {
  return (
    item.itemType === "message" &&
    item.scope === "shared" &&
    item.surface === "visible" &&
    item.authorParticipantId !== conversation.viewerParticipantId
  );
}

function applySyncEvent(snapshot, event) {
  let next = {
    ...snapshot,
    inboxCursor: Math.max(snapshot.inboxCursor || 0, event.syncSeq || 0),
  };

  switch (event.eventType) {
    case "conversation.upsert":
      next = {
        ...next,
        conversations: upsertConversation(
          next.conversations || [],
          event.payload.conversation,
        ),
      };
      break;
    case "conversation.item.created": {
      const conversationId = event.payload.conversationId;
      const item = event.payload.item;
      const currentItems =
        (next.itemsByConversationId && next.itemsByConversationId[conversationId]) || [];
      const alreadyExists = currentItems.some((entry) => entry.id === item.id);
      next = {
        ...next,
        outbox: clearDeliveredOutbox(next.outbox || {}, [item]),
        itemsByConversationId: {
          ...(next.itemsByConversationId || {}),
          [conversationId]: mergeItems(
            currentItems,
            [item],
          ),
        },
      };
      next = updateConversation(next, conversationId, (conversation) => ({
        ...conversation,
        unreadCount:
          !alreadyExists && shouldIncrementUnreadCount(conversation, item)
            ? (conversation.unreadCount || 0) + 1
            : conversation.unreadCount || 0,
        updatedAt: item.createdAt,
        lastItem: {
          itemId: item.id,
          sequence: item.sequence,
          itemType: item.itemType,
          subtype: item.subtype,
          previewText: buildPreviewText(item),
          authorParticipantId: item.authorParticipantId,
          author: item.author,
          createdAt: item.createdAt,
        },
      }));
      break;
    }
    case "conversation.read.updated": {
      const payload = event.payload;
      if (payload.workspaceMemberId !== next.workspaceMemberId) {
        break;
      }

      const pendingReads = { ...(next.pendingReads || {}) };
      const queued = pendingReads[payload.conversationId];
      if (queued && queued.readUpToSequence <= payload.readWatermarkSequence) {
        delete pendingReads[payload.conversationId];
      }

      next = updateConversation(
        {
          ...next,
          pendingReads,
          metaByConversationId: {
            ...(next.metaByConversationId || {}),
            [payload.conversationId]: {
              ...getConversationMeta(next, payload.conversationId),
              readWatermarkSequence: Math.max(
                getConversationMeta(next, payload.conversationId).readWatermarkSequence,
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
      const payload = event.payload;
      const currentItems = next.itemsByConversationId[payload.conversationId] || [];
      next = {
        ...next,
        itemsByConversationId: {
          ...next.itemsByConversationId,
          [payload.conversationId]: currentItems.map((item) =>
            patchInteractionItem(item, payload),
          ),
        },
      };

      next = updateConversation(next, payload.conversationId, (conversation) => ({
        ...conversation,
        lastItem:
          payload.itemId &&
          conversation.lastItem &&
          conversation.lastItem.itemId === payload.itemId
            ? {
                ...conversation.lastItem,
                previewText: buildInteractionPreview(payload.interaction),
              }
            : conversation.lastItem,
      }));
      break;
    }
  }

  return next;
}

async function flushPendingReads(auth, snapshot) {
  if (!snapshot.clientInstanceId) {
    return snapshot;
  }

  let next = snapshot;
  const entries = Object.values(snapshot.pendingReads || {}).sort(
    (left, right) => left.readUpToSequence - right.readUpToSequence,
  );

  for (const entry of entries) {
    try {
      const response = await fetchJson(
        auth,
        `/workspaces/${auth.workspaceId}/chat/conversations/${entry.conversationId}/read-watermark`,
        {
          method: "POST",
          body: JSON.stringify({
            clientInstanceId: snapshot.clientInstanceId,
            readUpToSequence: entry.readUpToSequence,
            lastVisibleSequence: entry.lastVisibleSequence,
          }),
        },
      );
      next = applyReadWatermarkAck(next, response);
    } catch {
      break;
    }
  }

  return next;
}

async function flushOutbox(auth, snapshot) {
  if (!snapshot.clientInstanceId) {
    return snapshot;
  }

  let next = snapshot;
  const entries = Object.values(snapshot.outbox || {}).sort(
    (left, right) => left.optimisticSequence - right.optimisticSequence,
  );

  for (const entry of entries) {
    next = {
      ...next,
      outbox: {
        ...next.outbox,
        [entry.clientMessageId]: {
          ...next.outbox[entry.clientMessageId],
          attemptCount: (next.outbox[entry.clientMessageId].attemptCount || 0) + 1,
          lastAttemptAt: new Date().toISOString(),
        },
      },
    };

    try {
      const response = await fetchJson(
        auth,
        `/workspaces/${auth.workspaceId}/chat/conversations/${entry.conversationId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            clientInstanceId: snapshot.clientInstanceId,
            clientMessageId: entry.clientMessageId,
            contentBlocks: entry.contentBlocks,
            replyToItemId: entry.replyToItemId,
            metadata: entry.metadata || undefined,
          }),
        },
      );

      const item = response.item;
      const nextOutbox = { ...next.outbox };
      delete nextOutbox[entry.clientMessageId];

      next = updateConversation(
        {
          ...next,
          outbox: nextOutbox,
          itemsByConversationId: {
            ...next.itemsByConversationId,
            [entry.conversationId]: mergeItems(
              next.itemsByConversationId[entry.conversationId] || [],
              [item],
            ),
          },
        },
        entry.conversationId,
        (conversation) => ({
          ...conversation,
          updatedAt: item.createdAt,
          lastItem: {
            itemId: item.id,
            sequence: item.sequence,
            itemType: item.itemType,
            subtype: item.subtype,
            previewText: buildPreviewText(item),
            authorParticipantId: item.authorParticipantId,
            author: item.author,
            createdAt: item.createdAt,
          },
        }),
      );
    } catch (error) {
      next = {
        ...next,
        outbox: {
          ...next.outbox,
          [entry.clientMessageId]: {
            ...next.outbox[entry.clientMessageId],
            status: "retrying",
            firstFailedAt:
              next.outbox[entry.clientMessageId].firstFailedAt ||
              new Date().toISOString(),
            lastErrorMessage:
              error && error.message ? error.message : "发送失败",
          },
        },
      };
      break;
    }
  }

  return next;
}

async function broadcast(message) {
  try {
    if ("BroadcastChannel" in self) {
      const channel = new BroadcastChannel(CHAT_BROADCAST_CHANNEL);
      channel.postMessage(message);
      channel.close();
    }
  } catch {}

  const clients = await self.clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  });
  for (const client of clients) {
    client.postMessage(message);
  }
}

async function runSyncPass(workspaceIdOverride, reason) {
  try {
    const auth = await getAuthContext();
    if (!auth || !auth.token || !(workspaceIdOverride || auth.workspaceId) || !auth.apiBase) {
      return;
    }

    const effectiveAuth = {
      ...auth,
      workspaceId: workspaceIdOverride || auth.workspaceId,
    };

    let snapshot = await loadWorkspaceSnapshot(effectiveAuth.workspaceId);
    snapshot = await bootstrapWorkspace(effectiveAuth, snapshot);

    let cursor = snapshot.inboxCursor || 0;
    let hasMore = true;
    while (hasMore) {
      const response = await fetchJson(
        effectiveAuth,
        `/workspaces/${effectiveAuth.workspaceId}/chat/sync?cursor=${encodeURIComponent(
          String(cursor),
        )}&limit=200`,
      );

      for (const event of response.events || []) {
        snapshot = applySyncEvent(snapshot, event);
      }

      cursor = response.nextCursor;
      hasMore = Boolean(response.hasMore);
    }

    snapshot = await flushPendingReads(effectiveAuth, snapshot);
    snapshot = await flushOutbox(effectiveAuth, snapshot);
    await saveWorkspaceSnapshot(snapshot);

    await broadcast({
      type: "chat:snapshot-updated",
      payload: {
        workspaceId: effectiveAuth.workspaceId,
        reason: reason || "sync-pass",
      },
    });
  } catch (error) {
    if (error && error.status === 401) {
      await broadcast({
        type: "chat:auth-expired",
      });
      return;
    }

    await broadcast({
      type: "chat:sync-failed",
      payload: {
        reason: reason || "sync-pass",
      },
    });
  }
}
