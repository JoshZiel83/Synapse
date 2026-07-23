/* eslint-disable */
"use strict";
(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));

  // node_modules/fast-deep-equal/index.js
  var require_fast_deep_equal = __commonJS({
    "../../node_modules/fast-deep-equal/index.js"(exports, module) {
      "use strict";
      module.exports = function equal(a, b) {
        if (a === b) return true;
        if (a && b && typeof a == "object" && typeof b == "object") {
          if (a.constructor !== b.constructor) return false;
          var length, i, keys;
          if (Array.isArray(a)) {
            length = a.length;
            if (length != b.length) return false;
            for (i = length; i-- !== 0; )
              if (!equal(a[i], b[i])) return false;
            return true;
          }
          if (a.constructor === RegExp) return a.source === b.source && a.flags === b.flags;
          if (a.valueOf !== Object.prototype.valueOf) return a.valueOf() === b.valueOf();
          if (a.toString !== Object.prototype.toString) return a.toString() === b.toString();
          keys = Object.keys(a);
          length = keys.length;
          if (length !== Object.keys(b).length) return false;
          for (i = length; i-- !== 0; )
            if (!Object.prototype.hasOwnProperty.call(b, keys[i])) return false;
          for (i = length; i-- !== 0; ) {
            var key = keys[i];
            if (!equal(a[key], b[key])) return false;
          }
          return true;
        }
        return a !== a && b !== b;
      };
    }
  });

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

  // ../shared/dist/utils/traceparent.js
  var TRACEPARENT_RE = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;
  function isValidTraceparent(value) {
    return typeof value === "string" && TRACEPARENT_RE.test(value);
  }

  // ../shared/dist/chat-queue/index.js
  var import_fast_deep_equal = __toESM(require_fast_deep_equal(), 1);
  var CHAT_QUEUE_DB_NAME = "synapse-chat-queue";
  var CHAT_QUEUE_DB_VERSION = 1;
  var CHAT_QUEUE_STATE_STORE = "workspace_queue_states";
  var CHAT_QUEUE_BROADCAST_CHANNEL = "synapse-chat-queue";
  var CHAT_SERVICE_WORKER_SYNC_TAG = "synapse-chat-sync";
  var CHAT_SERVICE_WORKER_PERIODIC_SYNC_TAG = "synapse-chat-periodic-sync";
  var CHAT_QUEUE_TRACE_CARRIER_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
  function sanitizeQueueEntryCarrier(entry) {
    if (entry.traceparent !== void 0 && !isValidTraceparent(entry.traceparent)) {
      const next = { ...entry };
      delete next.traceparent;
      return next;
    }
    return entry;
  }
  function replayTraceHeaders(traceparent, capturedAtIso, nowMs = Date.now()) {
    if (!isValidTraceparent(traceparent))
      return {};
    if (typeof capturedAtIso !== "string")
      return {};
    const capturedMs = new Date(capturedAtIso).getTime();
    if (!Number.isFinite(capturedMs))
      return {};
    if (nowMs - capturedMs >= CHAT_QUEUE_TRACE_CARRIER_MAX_AGE_MS)
      return {};
    return { traceparent };
  }
  function createEmptyStoredChatQueueState(workspaceId) {
    return {
      version: 5,
      workspaceId,
      inboxCursor: 0,
      pendingReads: {},
      outbox: {},
      tombstones: {}
    };
  }
  function isUuidLike(value) {
    if (typeof value !== "string")
      return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }
  function normalizeStoredChatQueueState(workspaceId, value) {
    if (!value || typeof value !== "object") {
      return createEmptyStoredChatQueueState(workspaceId);
    }
    const snapshot = value;
    if (snapshot.workspaceId !== workspaceId) {
      return createEmptyStoredChatQueueState(workspaceId);
    }
    const version = snapshot.version ?? 0;
    if (version !== 5) {
      return createEmptyStoredChatQueueState(workspaceId);
    }
    const pendingReads = snapshot.pendingReads && typeof snapshot.pendingReads === "object" ? Object.fromEntries(Object.entries(snapshot.pendingReads).filter(([conversationId, entry]) => Boolean(conversationId && entry && typeof entry === "object" && typeof entry.conversationId === "string")).map(([conversationId, entry]) => [
      conversationId,
      sanitizeQueueEntryCarrier(entry)
    ])) : {};
    const outbox = snapshot.outbox && typeof snapshot.outbox === "object" ? Object.fromEntries(Object.entries(snapshot.outbox).filter(([, entry]) => Boolean(entry && typeof entry === "object" && typeof entry.clientMessageId === "string" && typeof entry.conversationId === "string")).map(([clientMessageId, entry]) => [
      clientMessageId,
      sanitizeQueueEntryCarrier(entry)
    ])) : {};
    const tombstones = snapshot.tombstones && typeof snapshot.tombstones === "object" ? Object.fromEntries(Object.entries(snapshot.tombstones).filter(([conversationId, entry]) => Boolean(conversationId && entry && typeof entry === "object" && typeof entry.conversationId === "string" && typeof entry.removedSeq === "number"))) : {};
    return {
      version: 5,
      workspaceId,
      workspaceMemberId: typeof snapshot.workspaceMemberId === "string" ? snapshot.workspaceMemberId : void 0,
      clientInstanceId: isUuidLike(snapshot.clientInstanceId) ? snapshot.clientInstanceId : void 0,
      inboxCursor: typeof snapshot.inboxCursor === "number" && Number.isFinite(snapshot.inboxCursor) ? snapshot.inboxCursor : 0,
      lastBootstrappedAt: typeof snapshot.lastBootstrappedAt === "string" ? snapshot.lastBootstrappedAt : void 0,
      pendingReads,
      outbox,
      tombstones
    };
  }
  function sameStoredChatQueueState(left, right) {
    return (0, import_fast_deep_equal.default)(left, right);
  }
  function latestIsoTimestamp(currentValue, nextValue) {
    if (!currentValue)
      return nextValue;
    if (!nextValue)
      return currentValue;
    return new Date(currentValue).getTime() >= new Date(nextValue).getTime() ? currentValue : nextValue;
  }
  function sameStoredEntry(left, right) {
    return (0, import_fast_deep_equal.default)(left, right);
  }
  function mergeStoredQueueTransition(currentState, previousState, nextState) {
    const resolveNextWorkspaceState = () => {
      if (currentState.workspaceMemberId && nextState.workspaceMemberId && currentState.workspaceMemberId !== nextState.workspaceMemberId) {
        return createEmptyStoredChatQueueState(nextState.workspaceId);
      }
      if (currentState.workspaceId === nextState.workspaceId) {
        return currentState;
      }
      return createEmptyStoredChatQueueState(nextState.workspaceId);
    };
    const nextWorkspaceState = resolveNextWorkspaceState();
    const previousOutbox = previousState?.outbox ?? {};
    const previousPendingReads = previousState?.pendingReads ?? {};
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
        if (currentEntry && previousEntry && currentEntry.readUpToSequence > previousEntry.readUpToSequence) {
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
    const previousTombstones = previousState?.tombstones ?? {};
    const nextTombstones = { ...nextWorkspaceState.tombstones ?? {} };
    for (const conversationId of Object.keys(previousTombstones)) {
      if (!(conversationId in nextState.tombstones)) {
        const current = nextTombstones[conversationId];
        const previous = previousTombstones[conversationId];
        if (current && previous && current.removedSeq > previous.removedSeq) {
          continue;
        }
        delete nextTombstones[conversationId];
      }
    }
    for (const [conversationId, entry] of Object.entries(nextState.tombstones)) {
      const current = nextTombstones[conversationId];
      if (!current || entry.removedSeq >= current.removedSeq) {
        nextTombstones[conversationId] = entry;
      }
    }
    return {
      ...nextWorkspaceState,
      workspaceId: nextState.workspaceId,
      workspaceMemberId: nextState.workspaceMemberId ?? nextWorkspaceState.workspaceMemberId,
      clientInstanceId: nextState.clientInstanceId ?? nextWorkspaceState.clientInstanceId,
      inboxCursor: Math.max(nextWorkspaceState.inboxCursor, nextState.inboxCursor),
      lastBootstrappedAt: latestIsoTimestamp(nextWorkspaceState.lastBootstrappedAt, nextState.lastBootstrappedAt),
      pendingReads: nextPendingReads,
      outbox: nextOutbox,
      tombstones: nextTombstones
    };
  }
  async function flushOutboxQueue(state, deps) {
    if (!state.clientInstanceId) {
      return state;
    }
    let next = state;
    const entries = Object.values(state.outbox).sort((left, right) => left.optimisticSequence - right.optimisticSequence);
    for (const entry of entries) {
      const currentEntry = next.outbox[entry.clientMessageId];
      if (!currentEntry) {
        continue;
      }
      next = {
        ...next,
        outbox: {
          ...next.outbox,
          [entry.clientMessageId]: {
            ...currentEntry,
            attemptCount: (currentEntry.attemptCount || 0) + 1,
            lastAttemptAt: deps.now()
          }
        }
      };
      try {
        await deps.send(entry);
        const nextOutbox = { ...next.outbox };
        delete nextOutbox[entry.clientMessageId];
        next = { ...next, outbox: nextOutbox };
      } catch (error) {
        const failedEntry = next.outbox[entry.clientMessageId];
        if (!failedEntry) {
          break;
        }
        next = {
          ...next,
          outbox: {
            ...next.outbox,
            [entry.clientMessageId]: {
              ...failedEntry,
              status: "retrying",
              firstFailedAt: failedEntry.firstFailedAt || deps.now(),
              lastErrorMessage: error instanceof Error ? error.message : deps.failureMessage ?? "Failed to send message"
            }
          }
        };
        break;
      }
    }
    return next;
  }

  // ../device-protocol/dist/instant.js
  var ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  var MIN_PLAUSIBLE_EPOCH_MS = Date.UTC(2e3, 0, 1);
  var MAX_PLAUSIBLE_EPOCH_MS = Date.UTC(2200, 0, 1);
  function isValidDateInstance(value) {
    return Object.prototype.toString.call(value) === "[object Date]" && !Number.isNaN(value.getTime());
  }
  function isIsoInstantString(value) {
    if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) {
      return false;
    }
    const parsedMs = Date.parse(value);
    if (!Number.isFinite(parsedMs)) {
      return false;
    }
    return new Date(parsedMs).toISOString() === value;
  }
  function assertIsoInstantString(value) {
    if (!isIsoInstantString(value)) {
      throw new Error("Expected a canonical UTC ISO-8601 instant string with millisecond precision");
    }
    return value;
  }
  function dateToIsoInstant(value) {
    if (!isValidDateInstance(value)) {
      throw new Error("Expected a valid Date when converting to IsoInstantString");
    }
    return assertIsoInstantString(value.toISOString());
  }
  function nowIsoInstant() {
    return dateToIsoInstant(/* @__PURE__ */ new Date());
  }

  // lib/chat-persistence.ts
  var queueDbPromise = null;
  function getQueueDatabase() {
    if (!queueDbPromise) {
      queueDbPromise = openDB(
        CHAT_QUEUE_DB_NAME,
        CHAT_QUEUE_DB_VERSION,
        {
          upgrade(database) {
            if (!database.objectStoreNames.contains(CHAT_QUEUE_STATE_STORE)) {
              database.createObjectStore(CHAT_QUEUE_STATE_STORE, {
                keyPath: "workspaceId"
              });
            }
          }
        }
      );
    }
    return queueDbPromise;
  }
  async function loadStoredChatQueueState(workspaceId) {
    const database = await getQueueDatabase();
    const row = await database.get(CHAT_QUEUE_STATE_STORE, workspaceId);
    if (!row?.payload) {
      return null;
    }
    return normalizeStoredChatQueueState(workspaceId, row.payload);
  }
  async function saveStoredChatQueueState(queueState) {
    const database = await getQueueDatabase();
    await database.put(CHAT_QUEUE_STATE_STORE, {
      workspaceId: queueState.workspaceId,
      payload: normalizeStoredChatQueueState(queueState.workspaceId, queueState),
      updatedAt: nowIsoInstant()
    });
  }

  // lib/workers/web-chat-service-worker.ts
  var CHAT_WORKER_DB_NAME = "synapse-web-chat-worker";
  var CHAT_WORKER_DB_VERSION = 1;
  var CHAT_WORKER_AUTH_CONTEXT_STORE = "auth_context";
  var scope = self;
  var workerDbPromise = null;
  function getWorkerDatabase() {
    if (!workerDbPromise) {
      workerDbPromise = openDB(
        CHAT_WORKER_DB_NAME,
        CHAT_WORKER_DB_VERSION,
        {
          upgrade(database) {
            if (!database.objectStoreNames.contains(CHAT_WORKER_AUTH_CONTEXT_STORE)) {
              database.createObjectStore(CHAT_WORKER_AUTH_CONTEXT_STORE, {
                keyPath: "key"
              });
            }
          }
        }
      );
    }
    return workerDbPromise;
  }
  async function loadAuthContext() {
    const database = await getWorkerDatabase();
    const row = await database.get(CHAT_WORKER_AUTH_CONTEXT_STORE, "active");
    return row?.payload ?? null;
  }
  async function saveAuthContext(payload) {
    const database = await getWorkerDatabase();
    await database.put(CHAT_WORKER_AUTH_CONTEXT_STORE, {
      key: "active",
      payload,
      updatedAt: nowIsoInstant()
    });
  }
  async function clearAuthContext() {
    const database = await getWorkerDatabase();
    await database.delete(CHAT_WORKER_AUTH_CONTEXT_STORE, "active");
  }
  function resolveApiUrl(apiBase, path) {
    const base = typeof apiBase === "string" && apiBase.trim() ? apiBase.trim() : "/api/v1";
    return new URL(
      `${base.replace(/\/$/, "")}${path}`,
      scope.location.origin
    ).toString();
  }
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
          saveAuthContext(message.payload).then(
            () => runSyncPass(message.payload.workspaceId, "auth-context")
          )
        );
        break;
      case "chat:clear-auth-context":
        event.waitUntil(clearAuthContext());
        break;
      case "chat:run-sync":
        event.waitUntil(runSyncPass(null, message.payload?.reason));
        break;
    }
  });
  scope.addEventListener("sync", (event) => {
    const syncEvent = event;
    if (syncEvent.tag === CHAT_SERVICE_WORKER_SYNC_TAG) {
      syncEvent.waitUntil(runSyncPass(null, "background-sync"));
    }
  });
  scope.addEventListener("periodicsync", (event) => {
    const syncEvent = event;
    if (syncEvent.tag === CHAT_SERVICE_WORKER_PERIODIC_SYNC_TAG) {
      syncEvent.waitUntil(runSyncPass(null, "periodic-sync"));
    }
  });
  async function fetchJson(auth, path, options) {
    const response = await fetch(resolveApiUrl(auth.apiBase, path), {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...options?.headers ?? {}
      }
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data && data.error || "Request failed");
    }
    return data;
  }
  function applyReadWatermarkAck(snapshot, response) {
    const pendingReads = { ...snapshot.pendingReads };
    const queued = pendingReads[response.conversationId];
    if (queued && queued.readUpToSequence <= response.readWatermarkSequence) {
      delete pendingReads[response.conversationId];
    }
    return {
      ...snapshot,
      pendingReads
    };
  }
  async function flushPendingReads(auth, snapshot) {
    if (!snapshot.clientInstanceId) {
      return snapshot;
    }
    let next = snapshot;
    const entries = Object.values(snapshot.pendingReads).sort(
      (left, right) => left.readUpToSequence - right.readUpToSequence
    );
    for (const entry of entries) {
      try {
        const response = await fetchJson(
          auth,
          `/workspaces/${auth.workspaceId}/chat/conversations/${entry.conversationId}/read-watermark`,
          {
            method: "POST",
            // Replay the persisted creation-context carrier (captured on the main
            // thread inside a chat.read.enqueue span) as a raw traceparent header,
            // dropped past the 24h cap. No Sentry SDK / minted id in the worker.
            headers: replayTraceHeaders(entry.traceparent, entry.updatedAt),
            body: JSON.stringify({
              clientInstanceId: snapshot.clientInstanceId,
              readUpToSequence: entry.readUpToSequence,
              lastVisibleSequence: entry.lastVisibleSequence
            })
          }
        );
        next = applyReadWatermarkAck(next, response);
      } catch {
        break;
      }
    }
    return next;
  }
  async function flushOutbox(auth, snapshot) {
    return flushOutboxQueue(snapshot, {
      now: () => nowIsoInstant(),
      failureMessage: "Failed to send message",
      send: async (entry) => {
        await fetchJson(
          auth,
          `/workspaces/${auth.workspaceId}/chat/conversations/${entry.conversationId}/messages`,
          {
            method: "POST",
            // Replay the persisted creation-context carrier (captured on the main
            // thread inside a chat.outbox.enqueue span) as a raw traceparent
            // header, dropped past the 24h cap. No Sentry SDK / minted id here.
            headers: replayTraceHeaders(entry.traceparent, entry.createdAt),
            body: JSON.stringify({
              clientInstanceId: snapshot.clientInstanceId,
              clientMessageId: entry.clientMessageId,
              contentBlocks: entry.contentBlocks,
              replyToItemId: entry.replyToItemId
            })
          }
        );
      }
    });
  }
  async function broadcast(message) {
    try {
      if ("BroadcastChannel" in scope) {
        const channel = new BroadcastChannel(
          CHAT_QUEUE_BROADCAST_CHANNEL
        );
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
      const auth = await loadAuthContext();
      if (!auth || !auth.workspaceId || !auth.apiBase) {
        return;
      }
      const effectiveAuth = {
        ...auth,
        workspaceId: workspaceIdOverride || auth.workspaceId
      };
      const startingSnapshot = await loadStoredChatQueueState(effectiveAuth.workspaceId) || createEmptyStoredChatQueueState(effectiveAuth.workspaceId);
      if (!startingSnapshot.clientInstanceId) {
        return;
      }
      let nextSnapshot = await flushPendingReads(effectiveAuth, startingSnapshot);
      nextSnapshot = await flushOutbox(effectiveAuth, nextSnapshot);
      if (!sameStoredChatQueueState(startingSnapshot, nextSnapshot)) {
        await saveStoredChatQueueState(
          mergeStoredQueueTransition(
            await loadStoredChatQueueState(effectiveAuth.workspaceId) || createEmptyStoredChatQueueState(effectiveAuth.workspaceId),
            startingSnapshot,
            nextSnapshot
          )
        );
      }
      await broadcast({
        type: "chat:queue-updated",
        payload: {
          workspaceId: effectiveAuth.workspaceId,
          reason: reason || "queue-sync"
        }
      });
    } catch {
      await broadcast({
        type: "chat:queue-sync-failed",
        payload: {
          reason: reason || "queue-sync"
        }
      });
    }
  }
})();
