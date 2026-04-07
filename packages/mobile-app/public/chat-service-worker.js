const CHAT_DB_NAME = "synapse-chat-web-queue";
const CHAT_DB_VERSION = 1;
const CHAT_QUEUE_STATE_STORE = "workspace_queue_states";

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

function createEmptyQueueState(workspaceId) {
  return {
    version: 1,
    workspaceId,
    inboxCursor: 0,
    pendingReads: {},
    outbox: {},
  };
}

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function normalizePendingReads(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.values(value)
      .filter(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          typeof entry.conversationId === "string" &&
          typeof entry.readUpToSequence === "number" &&
          typeof entry.lastVisibleSequence === "number" &&
          typeof entry.updatedAt === "string",
      )
      .map((entry) => [entry.conversationId, entry]),
  );
}

function normalizeOutbox(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.values(value)
      .filter(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          typeof entry.clientMessageId === "string" &&
          typeof entry.conversationId === "string" &&
          Array.isArray(entry.contentBlocks) &&
          typeof entry.createdAt === "string" &&
          typeof entry.optimisticSequence === "number" &&
          typeof entry.status === "string" &&
          typeof entry.attemptCount === "number",
      )
      .map((entry) => [entry.clientMessageId, entry]),
  );
}

function normalizeQueueState(workspaceId, value) {
  if (!value || typeof value !== "object") {
    return createEmptyQueueState(workspaceId);
  }

  const queueState = value;
  if (queueState.version !== 1 || queueState.workspaceId !== workspaceId) {
    return createEmptyQueueState(workspaceId);
  }

  return {
    version: 1,
    workspaceId,
    workspaceMemberId:
      typeof queueState.workspaceMemberId === "string"
        ? queueState.workspaceMemberId
        : undefined,
    clientInstanceId: isUuid(queueState.clientInstanceId)
      ? queueState.clientInstanceId
      : undefined,
    inboxCursor:
      typeof queueState.inboxCursor === "number" &&
      Number.isFinite(queueState.inboxCursor)
        ? queueState.inboxCursor
        : 0,
    lastBootstrappedAt:
      typeof queueState.lastBootstrappedAt === "string"
        ? queueState.lastBootstrappedAt
        : undefined,
    pendingReads: normalizePendingReads(queueState.pendingReads),
    outbox: normalizeOutbox(queueState.outbox),
  };
}

function queueStateEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function queueEntryEquals(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
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

async function loadWorkspaceQueueState(workspaceId) {
  const row = await withStore(
    CHAT_DB_NAME,
    CHAT_DB_VERSION,
    CHAT_QUEUE_STATE_STORE,
    "readonly",
    (db) => {
      if (!db.objectStoreNames.contains(CHAT_QUEUE_STATE_STORE)) {
        db.createObjectStore(CHAT_QUEUE_STATE_STORE, { keyPath: "workspaceId" });
      }
    },
    (store) => requestToPromise(store.get(workspaceId)),
  );

  return normalizeQueueState(workspaceId, row && row.payload);
}

async function saveWorkspaceQueueState(queueState) {
  return withStore(
    CHAT_DB_NAME,
    CHAT_DB_VERSION,
    CHAT_QUEUE_STATE_STORE,
    "readwrite",
    (db) => {
      if (!db.objectStoreNames.contains(CHAT_QUEUE_STATE_STORE)) {
        db.createObjectStore(CHAT_QUEUE_STATE_STORE, { keyPath: "workspaceId" });
      }
    },
    (store) =>
      requestToPromise(
        store.put({
          workspaceId: queueState.workspaceId,
          payload: queueState,
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

async function flushPendingReads(auth, queueState) {
  if (!queueState.clientInstanceId) {
    return queueState;
  }

  let next = queueState;
  const entries = Object.values(queueState.pendingReads || {}).sort(
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
            clientInstanceId: queueState.clientInstanceId,
            readUpToSequence: entry.readUpToSequence,
            lastVisibleSequence: entry.lastVisibleSequence,
          }),
        },
      );

      const pendingReads = { ...next.pendingReads };
      const queued = pendingReads[entry.conversationId];
      if (queued && queued.readUpToSequence <= response.readWatermarkSequence) {
        delete pendingReads[entry.conversationId];
      }

      next = {
        ...next,
        pendingReads,
      };
    } catch {
      break;
    }
  }

  return next;
}

async function flushOutbox(auth, queueState) {
  if (!queueState.clientInstanceId) {
    return queueState;
  }

  let next = queueState;
  const entries = Object.values(queueState.outbox || {}).sort(
    (left, right) => left.optimisticSequence - right.optimisticSequence,
  );

  for (const entry of entries) {
    if (!next.outbox[entry.clientMessageId]) {
      continue;
    }

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
      await fetchJson(
        auth,
        `/workspaces/${auth.workspaceId}/chat/conversations/${entry.conversationId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            clientInstanceId: queueState.clientInstanceId,
            clientMessageId: entry.clientMessageId,
            contentBlocks: entry.contentBlocks,
            replyToItemId: entry.replyToItemId,
          }),
        },
      );

      const nextOutbox = { ...next.outbox };
      delete nextOutbox[entry.clientMessageId];
      next = {
        ...next,
        outbox: nextOutbox,
      };
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

function mergeQueueStateForSave(baseQueueState, latestQueueState, processedQueueState) {
  const next = {
    version: 1,
    workspaceId: latestQueueState.workspaceId,
    workspaceMemberId:
      latestQueueState.workspaceMemberId || processedQueueState.workspaceMemberId,
    clientInstanceId:
      latestQueueState.clientInstanceId || processedQueueState.clientInstanceId,
    inboxCursor: Math.max(
      latestQueueState.inboxCursor || 0,
      processedQueueState.inboxCursor || 0,
    ),
    lastBootstrappedAt:
      latestQueueState.lastBootstrappedAt || processedQueueState.lastBootstrappedAt,
    pendingReads: {
      ...latestQueueState.pendingReads,
    },
    outbox: {
      ...latestQueueState.outbox,
    },
  };

  for (const conversationId of Object.keys(baseQueueState.pendingReads || {})) {
    const baseEntry = baseQueueState.pendingReads[conversationId];
    const latestEntry = next.pendingReads[conversationId];
    const processedEntry = processedQueueState.pendingReads[conversationId];

    if (!queueEntryEquals(latestEntry, baseEntry)) {
      continue;
    }

    if (processedEntry) {
      next.pendingReads[conversationId] = processedEntry;
    } else {
      delete next.pendingReads[conversationId];
    }
  }

  for (const clientMessageId of Object.keys(baseQueueState.outbox || {})) {
    const baseEntry = baseQueueState.outbox[clientMessageId];
    const latestEntry = next.outbox[clientMessageId];
    const processedEntry = processedQueueState.outbox[clientMessageId];

    if (!queueEntryEquals(latestEntry, baseEntry)) {
      continue;
    }

    if (processedEntry) {
      next.outbox[clientMessageId] = processedEntry;
    } else {
      delete next.outbox[clientMessageId];
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

    const baseQueueState = await loadWorkspaceQueueState(effectiveAuth.workspaceId);
    let processedQueueState = baseQueueState;
    processedQueueState = await flushPendingReads(effectiveAuth, processedQueueState);
    processedQueueState = await flushOutbox(effectiveAuth, processedQueueState);

    const latestQueueState = await loadWorkspaceQueueState(effectiveAuth.workspaceId);
    const nextQueueState = mergeQueueStateForSave(
      baseQueueState,
      latestQueueState,
      processedQueueState,
    );

    if (queueStateEquals(latestQueueState, nextQueueState)) {
      return;
    }

    await saveWorkspaceQueueState(nextQueueState);
    await broadcast({
      type: "chat:queue-updated",
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
