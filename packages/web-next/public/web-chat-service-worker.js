const CHAT_DB_NAME = "synapse-web-next-chat";
const CHAT_DB_VERSION = 1;
const CHAT_SNAPSHOT_STORE = "workspace_snapshots";

const CHAT_WORKER_DB_NAME = "synapse-web-next-chat-worker";
const CHAT_WORKER_DB_VERSION = 1;
const CHAT_WORKER_STATE_STORE = "auth_context";

const CHAT_BROADCAST_CHANNEL = "synapse.web.chat.worker";
const CHAT_SYNC_TAG = "synapse-web-chat-sync";
const CHAT_PERIODIC_SYNC_TAG = "synapse-web-chat-periodic-sync";
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
    version: 3,
    workspaceId,
    inboxCursor: 0,
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
  if (snapshot.version !== 3 || snapshot.workspaceId !== workspaceId) {
    return createEmptySnapshot(workspaceId);
  }

  const pendingReads =
    snapshot.pendingReads && typeof snapshot.pendingReads === "object"
      ? Object.fromEntries(
          Object.entries(snapshot.pendingReads).filter(
            ([conversationId, entry]) =>
              Boolean(
                conversationId &&
                  entry &&
                  typeof entry === "object" &&
                  typeof entry.conversationId === "string",
              ),
          ),
        )
      : {};

  const outbox =
    snapshot.outbox && typeof snapshot.outbox === "object"
      ? Object.fromEntries(
          Object.entries(snapshot.outbox).filter(
            ([, entry]) =>
              Boolean(
                entry &&
                  typeof entry === "object" &&
                  typeof entry.clientMessageId === "string" &&
                  typeof entry.conversationId === "string",
              ),
          ),
        )
      : {};

  return {
    version: 3,
    workspaceId,
    workspaceMemberId:
      typeof snapshot.workspaceMemberId === "string"
        ? snapshot.workspaceMemberId
        : undefined,
    clientInstanceId: isUuid(snapshot.clientInstanceId)
      ? snapshot.clientInstanceId
      : undefined,
    inboxCursor:
      typeof snapshot.inboxCursor === "number" && Number.isFinite(snapshot.inboxCursor)
        ? snapshot.inboxCursor
        : 0,
    lastBootstrappedAt:
      typeof snapshot.lastBootstrappedAt === "string"
        ? snapshot.lastBootstrappedAt
        : undefined,
    pendingReads,
    outbox,
  };
}

function sameStoredEntry(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function latestIsoTimestamp(currentValue, nextValue) {
  if (!currentValue) {
    return nextValue;
  }
  if (!nextValue) {
    return currentValue;
  }
  return new Date(currentValue).getTime() >= new Date(nextValue).getTime()
    ? currentValue
    : nextValue;
}

function mergeStoredQueueTransition(currentState, previousState, nextState) {
  const nextWorkspaceState =
    currentState.workspaceMemberId &&
    nextState.workspaceMemberId &&
    currentState.workspaceMemberId !== nextState.workspaceMemberId
      ? createEmptySnapshot(nextState.workspaceId)
      : currentState.workspaceId === nextState.workspaceId
        ? currentState
        : createEmptySnapshot(nextState.workspaceId);

  const previousOutbox = (previousState && previousState.outbox) || {};
  const previousPendingReads = (previousState && previousState.pendingReads) || {};
  const nextOutbox = { ...nextWorkspaceState.outbox };
  const nextPendingReads = { ...nextWorkspaceState.pendingReads };

  for (const clientMessageId of Object.keys(previousOutbox)) {
    if (!(clientMessageId in nextState.outbox)) {
      delete nextOutbox[clientMessageId];
    }
  }
  for (const [clientMessageId, entry] of Object.entries(nextState.outbox)) {
    if (!sameStoredEntry(previousOutbox[clientMessageId], entry)) {
      nextOutbox[clientMessageId] = entry;
    }
  }

  for (const conversationId of Object.keys(previousPendingReads)) {
    if (!(conversationId in nextState.pendingReads)) {
      const currentEntry = nextPendingReads[conversationId];
      const previousEntry = previousPendingReads[conversationId];
      if (
        currentEntry &&
        previousEntry &&
        currentEntry.readUpToSequence > previousEntry.readUpToSequence
      ) {
        continue;
      }
      delete nextPendingReads[conversationId];
    }
  }
  for (const [conversationId, entry] of Object.entries(nextState.pendingReads)) {
    if (!sameStoredEntry(previousPendingReads[conversationId], entry)) {
      nextPendingReads[conversationId] = entry;
    }
  }

  return {
    ...nextWorkspaceState,
    workspaceId: nextState.workspaceId,
    workspaceMemberId:
      nextState.workspaceMemberId || nextWorkspaceState.workspaceMemberId,
    clientInstanceId:
      nextState.clientInstanceId || nextWorkspaceState.clientInstanceId,
    inboxCursor: Math.max(nextWorkspaceState.inboxCursor || 0, nextState.inboxCursor || 0),
    lastBootstrappedAt: latestIsoTimestamp(
      nextWorkspaceState.lastBootstrappedAt,
      nextState.lastBootstrappedAt,
    ),
    pendingReads: nextPendingReads,
    outbox: nextOutbox,
  };
}

function resolveApiUrl(apiBase, path) {
  const base =
    typeof apiBase === "string" && apiBase.trim()
      ? apiBase.trim()
      : "/api/v1";
  return new URL(`${base.replace(/\/$/, "")}${path}`, self.location.origin).toString();
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

async function updateWorkspaceSnapshot(workspaceId, updater) {
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
    async (store) => {
      const currentRow = await requestToPromise(store.get(workspaceId));
      const next = updater(normalizeSnapshot(workspaceId, currentRow && currentRow.payload));
      await requestToPromise(
        store.put({
          workspaceId,
          payload: normalizeSnapshot(workspaceId, next),
          updatedAt: new Date().toISOString(),
        }),
      );
    },
  );
}

async function fetchJson(auth, path, options) {
  const response = await fetch(resolveApiUrl(auth.apiBase, path), {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options && options.headers ? options.headers : {}),
    },
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((data && data.error) || "Request failed");
  }

  return data;
}

function applyReadWatermarkAck(snapshot, response) {
  const pendingReads = { ...(snapshot.pendingReads || {}) };
  const queued = pendingReads[response.conversationId];
  if (queued && queued.readUpToSequence <= response.readWatermarkSequence) {
    delete pendingReads[response.conversationId];
  }

  return {
    ...snapshot,
    pendingReads,
  };
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
      await fetchJson(
        auth,
        `/workspaces/${auth.workspaceId}/chat/conversations/${entry.conversationId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            clientInstanceId: snapshot.clientInstanceId,
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
              error && error.message ? error.message : "Failed to send message",
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
    if (!auth || !auth.workspaceId || !auth.apiBase) {
      return;
    }

    const effectiveAuth = {
      ...auth,
      workspaceId: workspaceIdOverride || auth.workspaceId,
    };

    const startingSnapshot = await loadWorkspaceSnapshot(effectiveAuth.workspaceId);
    if (!startingSnapshot.clientInstanceId) {
      return;
    }

    let nextSnapshot = await flushPendingReads(effectiveAuth, startingSnapshot);
    nextSnapshot = await flushOutbox(effectiveAuth, nextSnapshot);

    if (!sameStoredEntry(startingSnapshot, nextSnapshot)) {
      await updateWorkspaceSnapshot(effectiveAuth.workspaceId, (currentState) =>
        mergeStoredQueueTransition(currentState, startingSnapshot, nextSnapshot),
      );
    }

    await broadcast({
      type: "chat:queue-updated",
      payload: {
        workspaceId: effectiveAuth.workspaceId,
        reason: reason || "queue-sync",
      },
    });
  } catch {
    await broadcast({
      type: "chat:queue-sync-failed",
      payload: {
        reason: reason || "queue-sync",
      },
    });
  }
}
