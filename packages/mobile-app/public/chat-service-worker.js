/* eslint-disable */
"use strict";
(() => {
  // node_modules/idb/build/index.js
  var instanceOfAny = (object, constructors) => constructors.some((c) => object instanceof c);
  var idbProxyableTypes;
  var cursorAdvanceMethods;
  function getIdbProxyableTypes() {
    return idbProxyableTypes || (idbProxyableTypes = [
      IDBDatabase,
      IDBObjectStore,
      IDBIndex,
      IDBCursor,
      IDBTransaction
    ]);
  }
  function getCursorAdvanceMethods() {
    return cursorAdvanceMethods || (cursorAdvanceMethods = [
      IDBCursor.prototype.advance,
      IDBCursor.prototype.continue,
      IDBCursor.prototype.continuePrimaryKey
    ]);
  }
  var transactionDoneMap = /* @__PURE__ */ new WeakMap();
  var transformCache = /* @__PURE__ */ new WeakMap();
  var reverseTransformCache = /* @__PURE__ */ new WeakMap();
  function promisifyRequest(request) {
    const promise = new Promise((resolve, reject) => {
      const unlisten = () => {
        request.removeEventListener("success", success);
        request.removeEventListener("error", error);
      };
      const success = () => {
        resolve(wrap(request.result));
        unlisten();
      };
      const error = () => {
        reject(request.error);
        unlisten();
      };
      request.addEventListener("success", success);
      request.addEventListener("error", error);
    });
    reverseTransformCache.set(promise, request);
    return promise;
  }
  function cacheDonePromiseForTransaction(tx) {
    if (transactionDoneMap.has(tx))
      return;
    const done = new Promise((resolve, reject) => {
      const unlisten = () => {
        tx.removeEventListener("complete", complete);
        tx.removeEventListener("error", error);
        tx.removeEventListener("abort", error);
      };
      const complete = () => {
        resolve();
        unlisten();
      };
      const error = () => {
        reject(tx.error || new DOMException("AbortError", "AbortError"));
        unlisten();
      };
      tx.addEventListener("complete", complete);
      tx.addEventListener("error", error);
      tx.addEventListener("abort", error);
    });
    transactionDoneMap.set(tx, done);
  }
  var idbProxyTraps = {
    get(target, prop, receiver) {
      if (target instanceof IDBTransaction) {
        if (prop === "done")
          return transactionDoneMap.get(target);
        if (prop === "store") {
          return receiver.objectStoreNames[1] ? void 0 : receiver.objectStore(receiver.objectStoreNames[0]);
        }
      }
      return wrap(target[prop]);
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
    has(target, prop) {
      if (target instanceof IDBTransaction && (prop === "done" || prop === "store")) {
        return true;
      }
      return prop in target;
    }
  };
  function replaceTraps(callback) {
    idbProxyTraps = callback(idbProxyTraps);
  }
  function wrapFunction(func) {
    if (getCursorAdvanceMethods().includes(func)) {
      return function(...args) {
        func.apply(unwrap(this), args);
        return wrap(this.request);
      };
    }
    return function(...args) {
      return wrap(func.apply(unwrap(this), args));
    };
  }
  function transformCachableValue(value) {
    if (typeof value === "function")
      return wrapFunction(value);
    if (value instanceof IDBTransaction)
      cacheDonePromiseForTransaction(value);
    if (instanceOfAny(value, getIdbProxyableTypes()))
      return new Proxy(value, idbProxyTraps);
    return value;
  }
  function wrap(value) {
    if (value instanceof IDBRequest)
      return promisifyRequest(value);
    if (transformCache.has(value))
      return transformCache.get(value);
    const newValue = transformCachableValue(value);
    if (newValue !== value) {
      transformCache.set(value, newValue);
      reverseTransformCache.set(newValue, value);
    }
    return newValue;
  }
  var unwrap = (value) => reverseTransformCache.get(value);
  function openDB(name, version, { blocked, upgrade, blocking, terminated } = {}) {
    const request = indexedDB.open(name, version);
    const openPromise = wrap(request);
    if (upgrade) {
      request.addEventListener("upgradeneeded", (event) => {
        upgrade(wrap(request.result), event.oldVersion, event.newVersion, wrap(request.transaction), event);
      });
    }
    if (blocked) {
      request.addEventListener("blocked", (event) => blocked(
        // Casting due to https://github.com/microsoft/TypeScript-DOM-lib-generator/pull/1405
        event.oldVersion,
        event.newVersion,
        event
      ));
    }
    openPromise.then((db) => {
      if (terminated)
        db.addEventListener("close", () => terminated());
      if (blocking) {
        db.addEventListener("versionchange", (event) => blocking(event.oldVersion, event.newVersion, event));
      }
    }).catch(() => {
    });
    return openPromise;
  }
  var readMethods = ["get", "getKey", "getAll", "getAllKeys", "count"];
  var writeMethods = ["put", "add", "delete", "clear"];
  var cachedMethods = /* @__PURE__ */ new Map();
  function getMethod(target, prop) {
    if (!(target instanceof IDBDatabase && !(prop in target) && typeof prop === "string")) {
      return;
    }
    if (cachedMethods.get(prop))
      return cachedMethods.get(prop);
    const targetFuncName = prop.replace(/FromIndex$/, "");
    const useIndex = prop !== targetFuncName;
    const isWrite = writeMethods.includes(targetFuncName);
    if (
      // Bail if the target doesn't exist on the target. Eg, getAll isn't in Edge.
      !(targetFuncName in (useIndex ? IDBIndex : IDBObjectStore).prototype) || !(isWrite || readMethods.includes(targetFuncName))
    ) {
      return;
    }
    const method = async function(storeName, ...args) {
      const tx = this.transaction(storeName, isWrite ? "readwrite" : "readonly");
      let target2 = tx.store;
      if (useIndex)
        target2 = target2.index(args.shift());
      return (await Promise.all([
        target2[targetFuncName](...args),
        isWrite && tx.done
      ]))[0];
    };
    cachedMethods.set(prop, method);
    return method;
  }
  replaceTraps((oldTraps) => ({
    ...oldTraps,
    get: (target, prop, receiver) => getMethod(target, prop) || oldTraps.get(target, prop, receiver),
    has: (target, prop) => !!getMethod(target, prop) || oldTraps.has(target, prop)
  }));
  var advanceMethodProps = ["continue", "continuePrimaryKey", "advance"];
  var methodMap = {};
  var advanceResults = /* @__PURE__ */ new WeakMap();
  var ittrProxiedCursorToOriginalProxy = /* @__PURE__ */ new WeakMap();
  var cursorIteratorTraps = {
    get(target, prop) {
      if (!advanceMethodProps.includes(prop))
        return target[prop];
      let cachedFunc = methodMap[prop];
      if (!cachedFunc) {
        cachedFunc = methodMap[prop] = function(...args) {
          advanceResults.set(this, ittrProxiedCursorToOriginalProxy.get(this)[prop](...args));
        };
      }
      return cachedFunc;
    }
  };
  async function* iterate(...args) {
    let cursor = this;
    if (!(cursor instanceof IDBCursor)) {
      cursor = await cursor.openCursor(...args);
    }
    if (!cursor)
      return;
    cursor = cursor;
    const proxiedCursor = new Proxy(cursor, cursorIteratorTraps);
    ittrProxiedCursorToOriginalProxy.set(proxiedCursor, cursor);
    reverseTransformCache.set(proxiedCursor, unwrap(cursor));
    while (cursor) {
      yield proxiedCursor;
      cursor = await (advanceResults.get(proxiedCursor) || cursor.continue());
      advanceResults.delete(proxiedCursor);
    }
  }
  function isIteratorProp(target, prop) {
    return prop === Symbol.asyncIterator && instanceOfAny(target, [IDBIndex, IDBObjectStore, IDBCursor]) || prop === "iterate" && instanceOfAny(target, [IDBIndex, IDBObjectStore]);
  }
  replaceTraps((oldTraps) => ({
    ...oldTraps,
    get(target, prop, receiver) {
      if (isIteratorProp(target, prop))
        return iterate;
      return oldTraps.get(target, prop, receiver);
    },
    has(target, prop) {
      return isIteratorProp(target, prop) || oldTraps.has(target, prop);
    }
  }));

  // src/lib/ids.ts
  var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function isUuid(value) {
    return typeof value === "string" && UUID_PATTERN.test(value);
  }

  // src/lib/chat-web-queue-storage.ts
  var CHAT_WEB_QUEUE_DB_NAME = "synapse-chat-web-queue";
  var CHAT_WEB_QUEUE_DB_VERSION = 1;
  var CHAT_WEB_QUEUE_STATE_STORE = "workspace_queue_states";
  var CHAT_WEB_WORKER_DB_NAME = "synapse-chat-worker";
  var CHAT_WEB_WORKER_DB_VERSION = 1;
  var CHAT_WEB_WORKER_AUTH_CONTEXT_STORE = "auth_context";
  var queueDbPromise = null;
  var workerDbPromise = null;
  function getQueueDatabase() {
    if (!queueDbPromise) {
      queueDbPromise = openDB(
        CHAT_WEB_QUEUE_DB_NAME,
        CHAT_WEB_QUEUE_DB_VERSION,
        {
          upgrade(database) {
            if (!database.objectStoreNames.contains(CHAT_WEB_QUEUE_STATE_STORE)) {
              database.createObjectStore(CHAT_WEB_QUEUE_STATE_STORE, {
                keyPath: "workspaceId"
              });
            }
          }
        }
      );
    }
    return queueDbPromise;
  }
  function getWorkerDatabase() {
    if (!workerDbPromise) {
      workerDbPromise = openDB(
        CHAT_WEB_WORKER_DB_NAME,
        CHAT_WEB_WORKER_DB_VERSION,
        {
          upgrade(database) {
            if (!database.objectStoreNames.contains(CHAT_WEB_WORKER_AUTH_CONTEXT_STORE)) {
              database.createObjectStore(CHAT_WEB_WORKER_AUTH_CONTEXT_STORE, {
                keyPath: "key"
              });
            }
          }
        }
      );
    }
    return workerDbPromise;
  }
  function createEmptyStoredChatWorkspaceQueueState(workspaceId) {
    return {
      version: 1,
      workspaceId,
      inboxCursor: 0,
      pendingReads: {},
      outbox: {}
    };
  }
  function normalizePendingReads(value) {
    if (!value || typeof value !== "object") {
      return {};
    }
    return Object.fromEntries(
      Object.values(value).filter(
        (entry) => Boolean(
          entry && typeof entry === "object" && typeof entry.conversationId === "string" && typeof entry.readUpToSequence === "number" && typeof entry.lastVisibleSequence === "number" && typeof entry.updatedAt === "string"
        )
      ).map((entry) => [entry.conversationId, entry])
    );
  }
  function normalizeOutbox(value) {
    if (!value || typeof value !== "object") {
      return {};
    }
    return Object.fromEntries(
      Object.values(value).filter(
        (entry) => Boolean(
          entry && typeof entry === "object" && typeof entry.clientMessageId === "string" && typeof entry.conversationId === "string" && Array.isArray(entry.contentBlocks) && typeof entry.createdAt === "string" && typeof entry.optimisticSequence === "number" && typeof entry.status === "string" && typeof entry.attemptCount === "number"
        )
      ).map((entry) => [entry.clientMessageId, entry])
    );
  }
  function normalizeStoredChatWorkspaceQueueState(workspaceId, value) {
    if (!value || typeof value !== "object") {
      return createEmptyStoredChatWorkspaceQueueState(workspaceId);
    }
    const queueState = value;
    if (queueState.version !== 1 || queueState.workspaceId !== workspaceId) {
      return createEmptyStoredChatWorkspaceQueueState(workspaceId);
    }
    return {
      version: 1,
      workspaceId,
      workspaceMemberId: typeof queueState.workspaceMemberId === "string" ? queueState.workspaceMemberId : void 0,
      clientInstanceId: typeof queueState.clientInstanceId === "string" && isUuid(queueState.clientInstanceId) ? queueState.clientInstanceId : void 0,
      inboxCursor: typeof queueState.inboxCursor === "number" && Number.isFinite(queueState.inboxCursor) ? queueState.inboxCursor : 0,
      lastBootstrappedAt: typeof queueState.lastBootstrappedAt === "string" ? queueState.lastBootstrappedAt : void 0,
      pendingReads: normalizePendingReads(queueState.pendingReads),
      outbox: normalizeOutbox(queueState.outbox)
    };
  }
  async function loadStoredChatWorkspaceQueueState(workspaceId) {
    const database = await getQueueDatabase();
    const row = await database.get(CHAT_WEB_QUEUE_STATE_STORE, workspaceId);
    if (!row?.payload) {
      return null;
    }
    return normalizeStoredChatWorkspaceQueueState(workspaceId, row.payload);
  }
  async function saveStoredChatWorkspaceQueueState(queueState) {
    const database = await getQueueDatabase();
    await database.put(CHAT_WEB_QUEUE_STATE_STORE, {
      workspaceId: queueState.workspaceId,
      payload: normalizeStoredChatWorkspaceQueueState(
        queueState.workspaceId,
        queueState
      ),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  async function loadStoredChatWorkerAuthContext() {
    const database = await getWorkerDatabase();
    const row = await database.get(CHAT_WEB_WORKER_AUTH_CONTEXT_STORE, "active");
    return row?.payload ?? null;
  }
  async function saveStoredChatWorkerAuthContext(payload) {
    const database = await getWorkerDatabase();
    await database.put(CHAT_WEB_WORKER_AUTH_CONTEXT_STORE, {
      key: "active",
      payload,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  async function clearStoredChatWorkerAuthContext() {
    const database = await getWorkerDatabase();
    await database.delete(CHAT_WEB_WORKER_AUTH_CONTEXT_STORE, "active");
  }
  function sameStoredChatQueueState(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  function sameStoredChatQueueEntry(left, right) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  }

  // src/lib/storage-keys.ts
  var CHAT_WEB_SERVICE_WORKER_BROADCAST_CHANNEL = "synapse.chat.worker";
  var CHAT_WEB_SERVICE_WORKER_SYNC_TAG = "synapse-chat-sync";
  var CHAT_WEB_SERVICE_WORKER_PERIODIC_SYNC_TAG = "synapse-chat-periodic-sync";

  // src/workers/chat-service-worker.ts
  var scope = self;
  scope.addEventListener("install", (event) => {
    event.waitUntil(scope.skipWaiting());
  });
  scope.addEventListener("activate", (event) => {
    event.waitUntil(scope.clients.claim());
  });
  scope.addEventListener("message", (event) => {
    const message = event.data || {};
    switch (message.type) {
      case "chat:set-auth-context":
        event.waitUntil(
          saveStoredChatWorkerAuthContext(message.payload).then(
            () => runSyncPass(message.payload.workspaceId, "auth-context")
          )
        );
        break;
      case "chat:clear-auth-context":
        event.waitUntil(clearStoredChatWorkerAuthContext());
        break;
      case "chat:run-sync":
        event.waitUntil(runSyncPass(null, message.payload?.reason));
        break;
    }
  });
  scope.addEventListener("sync", (event) => {
    const syncEvent = event;
    if (syncEvent.tag === CHAT_WEB_SERVICE_WORKER_SYNC_TAG) {
      syncEvent.waitUntil(runSyncPass(null, "background-sync"));
    }
  });
  scope.addEventListener("periodicsync", (event) => {
    const syncEvent = event;
    if (syncEvent.tag === CHAT_WEB_SERVICE_WORKER_PERIODIC_SYNC_TAG) {
      syncEvent.waitUntil(runSyncPass(null, "periodic-sync"));
    }
  });
  async function fetchJson(auth, path, options) {
    const response = await fetch(`${auth.apiBase}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
        ...options?.headers ?? {}
      }
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data && data.error || "Request failed");
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
    const entries = Object.values(queueState.pendingReads).sort(
      (left, right) => left.readUpToSequence - right.readUpToSequence
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
              lastVisibleSequence: entry.lastVisibleSequence
            })
          }
        );
        const pendingReads = { ...next.pendingReads };
        const queued = pendingReads[entry.conversationId];
        if (queued && queued.readUpToSequence <= response.readWatermarkSequence) {
          delete pendingReads[entry.conversationId];
        }
        next = {
          ...next,
          pendingReads
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
    const entries = Object.values(queueState.outbox).sort(
      (left, right) => left.optimisticSequence - right.optimisticSequence
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
            lastAttemptAt: (/* @__PURE__ */ new Date()).toISOString()
          }
        }
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
              replyToItemId: entry.replyToItemId
            })
          }
        );
        const nextOutbox = { ...next.outbox };
        delete nextOutbox[entry.clientMessageId];
        next = {
          ...next,
          outbox: nextOutbox
        };
      } catch (error) {
        const currentEntry = next.outbox[entry.clientMessageId];
        if (!currentEntry) {
          break;
        }
        next = {
          ...next,
          outbox: {
            ...next.outbox,
            [entry.clientMessageId]: {
              ...currentEntry,
              status: "retrying",
              firstFailedAt: currentEntry.firstFailedAt || (/* @__PURE__ */ new Date()).toISOString(),
              lastErrorMessage: error instanceof Error ? error.message : "发送失败"
            }
          }
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
      workspaceMemberId: latestQueueState.workspaceMemberId || processedQueueState.workspaceMemberId,
      clientInstanceId: latestQueueState.clientInstanceId || processedQueueState.clientInstanceId,
      inboxCursor: Math.max(
        latestQueueState.inboxCursor || 0,
        processedQueueState.inboxCursor || 0
      ),
      lastBootstrappedAt: latestQueueState.lastBootstrappedAt || processedQueueState.lastBootstrappedAt,
      pendingReads: {
        ...latestQueueState.pendingReads
      },
      outbox: {
        ...latestQueueState.outbox
      }
    };
    for (const conversationId of Object.keys(baseQueueState.pendingReads)) {
      const baseEntry = baseQueueState.pendingReads[conversationId];
      const latestEntry = next.pendingReads[conversationId];
      const processedEntry = processedQueueState.pendingReads[conversationId];
      if (!sameStoredChatQueueEntry(latestEntry, baseEntry)) {
        continue;
      }
      if (processedEntry) {
        next.pendingReads[conversationId] = processedEntry;
      } else {
        delete next.pendingReads[conversationId];
      }
    }
    for (const clientMessageId of Object.keys(baseQueueState.outbox)) {
      const baseEntry = baseQueueState.outbox[clientMessageId];
      const latestEntry = next.outbox[clientMessageId];
      const processedEntry = processedQueueState.outbox[clientMessageId];
      if (!sameStoredChatQueueEntry(latestEntry, baseEntry)) {
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
      if ("BroadcastChannel" in scope) {
        const channel = new BroadcastChannel(CHAT_WEB_SERVICE_WORKER_BROADCAST_CHANNEL);
        channel.postMessage(message);
        channel.close();
      }
    } catch {
    }
    const clients = await scope.clients.matchAll({
      includeUncontrolled: true,
      type: "window"
    });
    for (const client of clients) {
      client.postMessage(message);
    }
  }
  async function runSyncPass(workspaceIdOverride, reason) {
    try {
      const auth = await loadStoredChatWorkerAuthContext();
      if (!auth || !auth.token || !(workspaceIdOverride || auth.workspaceId) || !auth.apiBase) {
        return;
      }
      const effectiveAuth = {
        ...auth,
        workspaceId: workspaceIdOverride || auth.workspaceId
      };
      const baseQueueState = await loadStoredChatWorkspaceQueueState(effectiveAuth.workspaceId) || createEmptyStoredChatWorkspaceQueueState(effectiveAuth.workspaceId);
      let processedQueueState = baseQueueState;
      processedQueueState = await flushPendingReads(effectiveAuth, processedQueueState);
      processedQueueState = await flushOutbox(effectiveAuth, processedQueueState);
      const latestQueueState = await loadStoredChatWorkspaceQueueState(effectiveAuth.workspaceId) || createEmptyStoredChatWorkspaceQueueState(effectiveAuth.workspaceId);
      const nextQueueState = mergeQueueStateForSave(
        baseQueueState,
        latestQueueState,
        processedQueueState
      );
      if (sameStoredChatQueueState(latestQueueState, nextQueueState)) {
        return;
      }
      await saveStoredChatWorkspaceQueueState(nextQueueState);
      await broadcast({
        type: "chat:queue-updated",
        payload: {
          workspaceId: effectiveAuth.workspaceId,
          reason: reason || "sync-pass"
        }
      });
    } catch (error) {
      if (error?.status === 401) {
        await broadcast({
          type: "chat:auth-expired"
        });
        return;
      }
      await broadcast({
        type: "chat:sync-failed",
        payload: {
          reason: reason || "sync-pass"
        }
      });
    }
  }
})();
