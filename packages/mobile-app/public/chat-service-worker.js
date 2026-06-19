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

  // ../shared/dist/uuid/index.js
  var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function isUuid(value) {
    return typeof value === "string" && UUID_PATTERN.test(value);
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
  function isIsoInstant(value) {
    return isIsoInstantString(value);
  }

  // ../device-protocol/dist/enums.js
  var DEVICE_MCP_ERROR_CODES = [
    "tool_definition_changed",
    "permission_denied",
    "runtime_constraint",
    "invalid_request",
    "expired_envelope",
    "replay_detected"
  ];
  var SERVER_FACADE_ERROR_CODES = [
    ...DEVICE_MCP_ERROR_CODES,
    "runtime_authorization_requested"
  ];

  // ../shared/dist/constants/enums.js
  var INVITE_TRUST_LEVELS = ["admin", "member", "guest"];
  var WORKSPACE_TRUST_LEVELS = ["owner", ...INVITE_TRUST_LEVELS];
  var PLATFORM_ACCESS_KEY = {
    SUPER_ADMIN: "super_admin",
    WORKSPACE_ADMIN: "workspace_admin",
    MODEL_ADMIN: "model_admin",
    SUPPORT: "support",
    AUDITOR: "auditor"
  };
  var PLATFORM_ACCESS_KEYS = [
    PLATFORM_ACCESS_KEY.SUPER_ADMIN,
    PLATFORM_ACCESS_KEY.WORKSPACE_ADMIN,
    PLATFORM_ACCESS_KEY.MODEL_ADMIN,
    PLATFORM_ACCESS_KEY.SUPPORT,
    PLATFORM_ACCESS_KEY.AUDITOR
  ];
  var PLATFORM_ACCESS_SOURCE = {
    CONFIG: "config",
    MANUAL: "manual"
  };
  var PLATFORM_ACCESS_SOURCES = [
    PLATFORM_ACCESS_SOURCE.CONFIG,
    PLATFORM_ACCESS_SOURCE.MANUAL
  ];
  var EVENT_TYPE = {
    WORK_ITEM_CREATED: "work_item.created",
    WORK_ITEM_UPDATED: "work_item.updated",
    WORK_ITEM_TRANSITIONED: "work_item.transitioned",
    MESSAGE_CREATED: "message.created",
    ACTOR_CREATED: "actor.created",
    ACTOR_UPDATED: "actor.updated",
    MEMORY_CREATED: "memory.created",
    ACTOR_THINKING: "actor.thinking",
    ACTOR_ACTION: "actor.action",
    CHAT_SYNC_EVENT: "chat.sync.event",
    RUNTIME_UPDATED: "runtime.updated",
    MCP_CONFIG_CHANGED: "mcp.config.changed",
    CHAT_TYPING: "chat.typing"
  };
  var EVENT_TYPES = [
    EVENT_TYPE.WORK_ITEM_CREATED,
    EVENT_TYPE.WORK_ITEM_UPDATED,
    EVENT_TYPE.WORK_ITEM_TRANSITIONED,
    EVENT_TYPE.MESSAGE_CREATED,
    EVENT_TYPE.ACTOR_CREATED,
    EVENT_TYPE.ACTOR_UPDATED,
    EVENT_TYPE.MEMORY_CREATED,
    EVENT_TYPE.ACTOR_THINKING,
    EVENT_TYPE.ACTOR_ACTION,
    EVENT_TYPE.CHAT_SYNC_EVENT,
    EVENT_TYPE.RUNTIME_UPDATED,
    EVENT_TYPE.MCP_CONFIG_CHANGED,
    EVENT_TYPE.CHAT_TYPING
  ];
  var RELATIONSHIP_PROFILE_SUBJECT_TYPE = {
    MEMBER: "workspace_member",
    ACTOR: "actor",
    REMOTE_AGENT: "remote_agent"
  };
  var RELATIONSHIP_PROFILE_SUBJECT_TYPES = [
    RELATIONSHIP_PROFILE_SUBJECT_TYPE.MEMBER,
    RELATIONSHIP_PROFILE_SUBJECT_TYPE.ACTOR,
    RELATIONSHIP_PROFILE_SUBJECT_TYPE.REMOTE_AGENT
  ];
  var RELATIONSHIP_APPROVAL_MODE = {
    AUTO: "auto",
    MANUAL: "manual"
  };
  var RELATIONSHIP_APPROVAL_MODES = [
    RELATIONSHIP_APPROVAL_MODE.AUTO,
    RELATIONSHIP_APPROVAL_MODE.MANUAL
  ];
  var RELATIONSHIP_REQUEST_STATUS = {
    PENDING: "pending",
    APPROVED: "approved",
    REJECTED: "rejected"
  };
  var RELATIONSHIP_REQUEST_STATUSES = [
    RELATIONSHIP_REQUEST_STATUS.PENDING,
    RELATIONSHIP_REQUEST_STATUS.APPROVED,
    RELATIONSHIP_REQUEST_STATUS.REJECTED
  ];
  var CONTACT_TARGET_TYPE = {
    MEMBER: "workspace_member",
    ACTOR: "actor",
    REMOTE_AGENT: "remote_agent"
  };
  var CONTACT_TARGET_TYPES = [
    CONTACT_TARGET_TYPE.MEMBER,
    CONTACT_TARGET_TYPE.ACTOR,
    CONTACT_TARGET_TYPE.REMOTE_AGENT
  ];
  var CONTACT_HUB_KIND = {
    WORKSPACE_ACTOR: "workspace-actor",
    WORKSPACE_REMOTE_AGENT: "workspace-remote-agent",
    WORKSPACE_MEMBER: "workspace-member",
    FRIEND_ACTOR: "friend-actor",
    FRIEND_REMOTE_AGENT: "friend-remote-agent",
    FRIEND_MEMBER: "friend-member"
  };
  var CONTACT_HUB_KINDS = [
    CONTACT_HUB_KIND.WORKSPACE_ACTOR,
    CONTACT_HUB_KIND.WORKSPACE_REMOTE_AGENT,
    CONTACT_HUB_KIND.WORKSPACE_MEMBER,
    CONTACT_HUB_KIND.FRIEND_ACTOR,
    CONTACT_HUB_KIND.FRIEND_REMOTE_AGENT,
    CONTACT_HUB_KIND.FRIEND_MEMBER
  ];
  var CONTACT_DIRECT_STATE = {
    EXISTING: "existing",
    AVAILABLE: "available",
    APPROVAL_REQUIRED: "approval_required",
    PENDING_APPROVAL: "pending_approval"
  };
  var CONTACT_DIRECT_STATES = [
    CONTACT_DIRECT_STATE.EXISTING,
    CONTACT_DIRECT_STATE.AVAILABLE,
    CONTACT_DIRECT_STATE.APPROVAL_REQUIRED,
    CONTACT_DIRECT_STATE.PENDING_APPROVAL
  ];
  var IDENTITY_SEARCH_OUTCOME = {
    EMPTY: "empty",
    INVALID: "invalid",
    SELF: "self",
    NOT_FOUND: "not_found",
    FOUND: "found"
  };
  var IDENTITY_SEARCH_OUTCOMES = [
    IDENTITY_SEARCH_OUTCOME.EMPTY,
    IDENTITY_SEARCH_OUTCOME.INVALID,
    IDENTITY_SEARCH_OUTCOME.SELF,
    IDENTITY_SEARCH_OUTCOME.NOT_FOUND,
    IDENTITY_SEARCH_OUTCOME.FOUND
  ];
  var IDENTITY_SEARCH_MATCH_STATE = {
    SAME_WORKSPACE_MEMBER: "same_workspace_member",
    FRIEND: "friend",
    PENDING_REQUEST: "pending_request",
    REQUESTABLE: "requestable",
    EXISTING: CONTACT_DIRECT_STATE.EXISTING,
    AVAILABLE: CONTACT_DIRECT_STATE.AVAILABLE,
    APPROVAL_REQUIRED: CONTACT_DIRECT_STATE.APPROVAL_REQUIRED,
    PENDING_APPROVAL: CONTACT_DIRECT_STATE.PENDING_APPROVAL
  };
  var IDENTITY_SEARCH_MATCH_STATES = [
    IDENTITY_SEARCH_MATCH_STATE.SAME_WORKSPACE_MEMBER,
    IDENTITY_SEARCH_MATCH_STATE.FRIEND,
    IDENTITY_SEARCH_MATCH_STATE.PENDING_REQUEST,
    IDENTITY_SEARCH_MATCH_STATE.REQUESTABLE,
    IDENTITY_SEARCH_MATCH_STATE.EXISTING,
    IDENTITY_SEARCH_MATCH_STATE.AVAILABLE,
    IDENTITY_SEARCH_MATCH_STATE.APPROVAL_REQUIRED,
    IDENTITY_SEARCH_MATCH_STATE.PENDING_APPROVAL
  ];
  var RELATIONSHIP_SCAN_OUTCOME = {
    SELF_SCAN: "self_scan",
    SAME_WORKSPACE_MEMBER: "same_workspace_member",
    FRIEND_ACTIVE: "friend_active",
    FRIEND_REQUEST_CREATED: "friend_request_created",
    FRIEND_REQUEST_PENDING: "friend_request_pending",
    ACTOR_ACCESS_GRANTED: "actor_access_granted",
    ACTOR_ACCESS_REQUEST_CREATED: "actor_access_request_created",
    ACTOR_ACCESS_PENDING: "actor_access_pending",
    REMOTE_AGENT_ACCESS_GRANTED: "remote_agent_access_granted",
    REMOTE_AGENT_ACCESS_REQUEST_CREATED: "remote_agent_access_request_created",
    REMOTE_AGENT_ACCESS_PENDING: "remote_agent_access_pending"
  };
  var RELATIONSHIP_SCAN_OUTCOMES = [
    RELATIONSHIP_SCAN_OUTCOME.SELF_SCAN,
    RELATIONSHIP_SCAN_OUTCOME.SAME_WORKSPACE_MEMBER,
    RELATIONSHIP_SCAN_OUTCOME.FRIEND_ACTIVE,
    RELATIONSHIP_SCAN_OUTCOME.FRIEND_REQUEST_CREATED,
    RELATIONSHIP_SCAN_OUTCOME.FRIEND_REQUEST_PENDING,
    RELATIONSHIP_SCAN_OUTCOME.ACTOR_ACCESS_GRANTED,
    RELATIONSHIP_SCAN_OUTCOME.ACTOR_ACCESS_REQUEST_CREATED,
    RELATIONSHIP_SCAN_OUTCOME.ACTOR_ACCESS_PENDING,
    RELATIONSHIP_SCAN_OUTCOME.REMOTE_AGENT_ACCESS_GRANTED,
    RELATIONSHIP_SCAN_OUTCOME.REMOTE_AGENT_ACCESS_REQUEST_CREATED,
    RELATIONSHIP_SCAN_OUTCOME.REMOTE_AGENT_ACCESS_PENDING
  ];
  var DIRECT_CONVERSATION_OPEN_STATUS = {
    READY: "ready",
    PENDING_APPROVAL: "pending_approval"
  };
  var DIRECT_CONVERSATION_OPEN_STATUSES = [
    DIRECT_CONVERSATION_OPEN_STATUS.READY,
    DIRECT_CONVERSATION_OPEN_STATUS.PENDING_APPROVAL
  ];
  var FILE_ORIGIN_SYSTEMS = {
    WORKSPACE_WEB_UPLOAD: "workspace_web_upload",
    WORKSPACE_MOBILE_UPLOAD: "workspace_mobile_upload",
    ACTOR_TOOL_UPLOAD_FILE: "actor_tool_upload_file",
    MCP_TOOL_RESULT_INGEST: "mcp_tool_result_ingest",
    MCP_RESULT_NORMALIZER: "mcp_result_normalizer",
    ZHIPU_TEXT_TO_SPEECH: "zhipu_text_to_speech",
    ZHIPU_FILE_PARSER_SYNC: "zhipu_file_parser_sync",
    ZHIPU_IMAGE_GENERATION: "zhipu_image_generation",
    ZHIPU_LAYOUT_PARSING: "zhipu_layout_parsing",
    ANTHROPIC_RESPONSE_MEDIA_INGEST: "anthropic_response_media_ingest",
    OPENAI_RESPONSE_MEDIA_INGEST: "openai_response_media_ingest",
    GENERIC_MODEL_RESPONSE_MEDIA_INGEST: "generic_model_response_media_ingest",
    FEISHU_DOCS_DOWNLOAD_MEDIA: "feishu_docs_download_media",
    FEISHU_DRIVE_DOWNLOAD_FILE: "feishu_drive_download_file",
    QQ_INBOUND_MEDIA_INGEST: "qq_inbound_media_ingest",
    FEISHU_INBOUND_MEDIA_INGEST: "feishu_inbound_media_ingest",
    WEIXIN_INBOUND_MEDIA_INGEST: "weixin_inbound_media_ingest",
    DINGTALK_INBOUND_MEDIA_INGEST: "dingtalk_inbound_media_ingest",
    SKILL_MIRROR_IMPORT: "skill_mirror_import",
    GENERATED_USER_AVATAR: "generated_user_avatar",
    GENERATED_OFFICIAL_ACTOR_AVATAR: "generated_official_actor_avatar",
    GENERATED_ACTOR_PIXEL_ART_AVATAR: "generated_actor_pixel_art_avatar",
    MARKETPLACE_SKILL_ICON_COPY: "marketplace_skill_icon_copy",
    BUILTIN_PLUGIN_ICON: "builtin_plugin_icon"
  };
  var USER_UPLOAD_FILE_ORIGIN_SYSTEMS = [
    FILE_ORIGIN_SYSTEMS.WORKSPACE_WEB_UPLOAD,
    FILE_ORIGIN_SYSTEMS.WORKSPACE_MOBILE_UPLOAD
  ];
  var ACTOR_OUTPUT_FILE_ORIGIN_SYSTEMS = [
    FILE_ORIGIN_SYSTEMS.ACTOR_TOOL_UPLOAD_FILE
  ];
  var TOOL_OUTPUT_FILE_ORIGIN_SYSTEMS = [
    FILE_ORIGIN_SYSTEMS.MCP_TOOL_RESULT_INGEST,
    FILE_ORIGIN_SYSTEMS.MCP_RESULT_NORMALIZER,
    FILE_ORIGIN_SYSTEMS.ZHIPU_TEXT_TO_SPEECH,
    FILE_ORIGIN_SYSTEMS.ZHIPU_FILE_PARSER_SYNC,
    FILE_ORIGIN_SYSTEMS.ZHIPU_IMAGE_GENERATION,
    FILE_ORIGIN_SYSTEMS.ZHIPU_LAYOUT_PARSING
  ];
  var MODEL_OUTPUT_FILE_ORIGIN_SYSTEMS = [
    FILE_ORIGIN_SYSTEMS.ANTHROPIC_RESPONSE_MEDIA_INGEST,
    FILE_ORIGIN_SYSTEMS.OPENAI_RESPONSE_MEDIA_INGEST,
    FILE_ORIGIN_SYSTEMS.GENERIC_MODEL_RESPONSE_MEDIA_INGEST
  ];
  var EXTERNAL_IMPORT_FILE_ORIGIN_SYSTEMS = [
    FILE_ORIGIN_SYSTEMS.FEISHU_DOCS_DOWNLOAD_MEDIA,
    FILE_ORIGIN_SYSTEMS.FEISHU_DRIVE_DOWNLOAD_FILE,
    FILE_ORIGIN_SYSTEMS.QQ_INBOUND_MEDIA_INGEST,
    FILE_ORIGIN_SYSTEMS.FEISHU_INBOUND_MEDIA_INGEST,
    FILE_ORIGIN_SYSTEMS.WEIXIN_INBOUND_MEDIA_INGEST,
    FILE_ORIGIN_SYSTEMS.DINGTALK_INBOUND_MEDIA_INGEST
  ];
  var PACKAGE_IMPORT_FILE_ORIGIN_SYSTEMS = [
    FILE_ORIGIN_SYSTEMS.SKILL_MIRROR_IMPORT
  ];
  var SYSTEM_GENERATED_FILE_ORIGIN_SYSTEMS = [
    FILE_ORIGIN_SYSTEMS.GENERATED_USER_AVATAR,
    FILE_ORIGIN_SYSTEMS.GENERATED_OFFICIAL_ACTOR_AVATAR,
    FILE_ORIGIN_SYSTEMS.GENERATED_ACTOR_PIXEL_ART_AVATAR,
    FILE_ORIGIN_SYSTEMS.MARKETPLACE_SKILL_ICON_COPY
  ];
  var PLATFORM_ASSET_FILE_ORIGIN_SYSTEMS = [
    FILE_ORIGIN_SYSTEMS.BUILTIN_PLUGIN_ICON
  ];
  var CONVERSATION_KIND = {
    DIRECT: "direct",
    GROUP: "group"
  };
  var CONVERSATION_KINDS = [
    CONVERSATION_KIND.DIRECT,
    CONVERSATION_KIND.GROUP
  ];
  var CONVERSATION_STATUS = {
    ACTIVE: "active",
    COMPLETED: "completed"
  };
  var CONVERSATION_STATUSES = [
    CONVERSATION_STATUS.ACTIVE,
    CONVERSATION_STATUS.COMPLETED
  ];
  var CONVERSATION_PARTICIPANT_TYPE = {
    WORKSPACE_MEMBER: "workspace_member",
    ACTOR: "actor",
    REMOTE_AGENT: "remote_agent",
    EXTERNAL: "external"
  };
  var CONVERSATION_PARTICIPANT_TYPES = [
    CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
    CONVERSATION_PARTICIPANT_TYPE.ACTOR,
    CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT,
    CONVERSATION_PARTICIPANT_TYPE.EXTERNAL
  ];
  var CONVERSATION_PARTICIPANT_STATE = {
    ACTIVE: "active",
    LEFT: "left",
    REMOVED: "removed"
  };
  var CONVERSATION_PARTICIPANT_STATES = [
    CONVERSATION_PARTICIPANT_STATE.ACTIVE,
    CONVERSATION_PARTICIPANT_STATE.LEFT,
    CONVERSATION_PARTICIPANT_STATE.REMOVED
  ];
  var CONVERSATION_PARTICIPANT_ROLE_KEY = {
    OWNER: "owner",
    ADMIN: "admin",
    MEMBER: "member"
  };
  var CONVERSATION_PARTICIPANT_ROLE_KEYS = [
    CONVERSATION_PARTICIPANT_ROLE_KEY.OWNER,
    CONVERSATION_PARTICIPANT_ROLE_KEY.ADMIN,
    CONVERSATION_PARTICIPANT_ROLE_KEY.MEMBER
  ];
  var CHAT_PARTICIPANT_REMOVAL_STATE = {
    LEFT: CONVERSATION_PARTICIPANT_STATE.LEFT,
    REMOVED: CONVERSATION_PARTICIPANT_STATE.REMOVED
  };
  var CHAT_PARTICIPANT_REMOVAL_STATES = [
    CHAT_PARTICIPANT_REMOVAL_STATE.LEFT,
    CHAT_PARTICIPANT_REMOVAL_STATE.REMOVED
  ];
  var CHAT_MEMBERSHIP_UPDATE_REASON = {
    KICKED: "kicked",
    LEFT: "left",
    ADDED: "added"
  };
  var CHAT_MEMBERSHIP_UPDATE_REASONS = [
    CHAT_MEMBERSHIP_UPDATE_REASON.KICKED,
    CHAT_MEMBERSHIP_UPDATE_REASON.LEFT,
    CHAT_MEMBERSHIP_UPDATE_REASON.ADDED
  ];
  var CHAT_TYPING_STATE = {
    STARTED: "started",
    STOPPED: "stopped"
  };
  var CHAT_TYPING_STATES = [
    CHAT_TYPING_STATE.STARTED,
    CHAT_TYPING_STATE.STOPPED
  ];
  var CONVERSATION_MESSAGE_TRANSPORT_DIRECTION = {
    INBOUND: "inbound",
    OUTBOUND: "outbound"
  };
  var CONVERSATION_MESSAGE_TRANSPORT_DIRECTIONS = [
    CONVERSATION_MESSAGE_TRANSPORT_DIRECTION.INBOUND,
    CONVERSATION_MESSAGE_TRANSPORT_DIRECTION.OUTBOUND
  ];
  var PUSH_TOKEN_PLATFORM = {
    IOS: "ios",
    ANDROID: "android",
    WEB: "web"
  };
  var PUSH_TOKEN_PLATFORMS = [
    PUSH_TOKEN_PLATFORM.IOS,
    PUSH_TOKEN_PLATFORM.ANDROID,
    PUSH_TOKEN_PLATFORM.WEB
  ];
  var CONVERSATION_ITEM_SCOPE = {
    SHARED: "shared",
    PRIVATE: "private"
  };
  var CONVERSATION_ITEM_SCOPES = [
    CONVERSATION_ITEM_SCOPE.SHARED,
    CONVERSATION_ITEM_SCOPE.PRIVATE
  ];
  var CONVERSATION_ITEM_SURFACE = {
    VISIBLE: "visible",
    INTERNAL: "internal"
  };
  var CONVERSATION_ITEM_SURFACES = [
    CONVERSATION_ITEM_SURFACE.VISIBLE,
    CONVERSATION_ITEM_SURFACE.INTERNAL
  ];
  var CONVERSATION_ITEM_TYPE = {
    MESSAGE: "message",
    EVENT: "event",
    SUMMARY: "summary",
    CONTROL: "control"
  };
  var CONVERSATION_ITEM_TYPES = [
    CONVERSATION_ITEM_TYPE.MESSAGE,
    CONVERSATION_ITEM_TYPE.EVENT,
    CONVERSATION_ITEM_TYPE.SUMMARY,
    CONVERSATION_ITEM_TYPE.CONTROL
  ];
  var CONVERSATION_ITEM_ROLE = {
    USER: "user",
    ASSISTANT: "assistant",
    SYSTEM: "system",
    TOOL: "tool"
  };
  var CONVERSATION_ITEM_ROLES = [
    CONVERSATION_ITEM_ROLE.USER,
    CONVERSATION_ITEM_ROLE.ASSISTANT,
    CONVERSATION_ITEM_ROLE.SYSTEM,
    CONVERSATION_ITEM_ROLE.TOOL
  ];
  var CONVERSATION_MESSAGE_SUBTYPE = {
    CHAT_MESSAGE: "chat.message",
    USER: "user",
    ASSISTANT: "assistant",
    SYSTEM: "system",
    TOOL_RESULT: "tool_result",
    MODEL_ERROR_NOTICE: "model_error_notice"
  };
  var CONVERSATION_MESSAGE_SUBTYPES = [
    CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
    CONVERSATION_MESSAGE_SUBTYPE.USER,
    CONVERSATION_MESSAGE_SUBTYPE.ASSISTANT,
    CONVERSATION_MESSAGE_SUBTYPE.SYSTEM,
    CONVERSATION_MESSAGE_SUBTYPE.TOOL_RESULT,
    CONVERSATION_MESSAGE_SUBTYPE.MODEL_ERROR_NOTICE
  ];
  var CONVERSATION_FEED_MESSAGE_TYPE = {
    ...CONVERSATION_MESSAGE_SUBTYPE,
    SUMMARY: "summary"
  };
  var CONVERSATION_FEED_MESSAGE_TYPES = [
    ...CONVERSATION_MESSAGE_SUBTYPES,
    CONVERSATION_FEED_MESSAGE_TYPE.SUMMARY
  ];
  var CONVERSATION_FEED_EVENT_TYPE = {
    PARTICIPANT_JOINED: "participant_joined",
    PARTICIPANT_KICKED: "participant_kicked",
    PARTICIPANT_LEFT: "participant_left",
    MEMORY_SAVED: "memory_saved",
    MEMORY_UPDATED: "memory_updated",
    ACTOR_RENAMED: "actor_renamed",
    ACTOR_AVATAR_CHANGED: "actor_avatar_changed",
    AUTOMATION_NOTICE: "automation_notice",
    TASK_REQUESTED: "task_requested",
    TASK_NOTICE: "task_notice"
  };
  var CONVERSATION_FEED_EVENT_TYPES = [
    CONVERSATION_FEED_EVENT_TYPE.PARTICIPANT_JOINED,
    CONVERSATION_FEED_EVENT_TYPE.PARTICIPANT_KICKED,
    CONVERSATION_FEED_EVENT_TYPE.PARTICIPANT_LEFT,
    CONVERSATION_FEED_EVENT_TYPE.MEMORY_SAVED,
    CONVERSATION_FEED_EVENT_TYPE.MEMORY_UPDATED,
    CONVERSATION_FEED_EVENT_TYPE.ACTOR_RENAMED,
    CONVERSATION_FEED_EVENT_TYPE.ACTOR_AVATAR_CHANGED,
    CONVERSATION_FEED_EVENT_TYPE.AUTOMATION_NOTICE,
    CONVERSATION_FEED_EVENT_TYPE.TASK_REQUESTED,
    CONVERSATION_FEED_EVENT_TYPE.TASK_NOTICE
  ];
  var CONVERSATION_FEED_ITEM_SUBTYPES = [
    ...CONVERSATION_FEED_MESSAGE_TYPES,
    ...CONVERSATION_FEED_EVENT_TYPES
  ];
  var CONVERSATION_REPLY_REF_SPECIAL_SUBTYPE = {
    UNAVAILABLE: "unavailable"
  };
  var CONVERSATION_REPLY_REF_SPECIAL_SUBTYPES = [
    CONVERSATION_REPLY_REF_SPECIAL_SUBTYPE.UNAVAILABLE
  ];
  var CONVERSATION_REPLY_REF_SUBTYPES = [
    ...CONVERSATION_FEED_ITEM_SUBTYPES,
    ...CONVERSATION_REPLY_REF_SPECIAL_SUBTYPES
  ];
  var CONVERSATION_EVENT_TIMELINE_POLICY = {
    NONE: "none",
    ALL_MEMBERS: "all_members",
    USERS_ONLY: "users_only",
    ACTORS_ONLY: "actors_only",
    TARGETED_MEMBERS: "targeted_members"
  };
  var CONVERSATION_EVENT_TIMELINE_POLICIES = [
    CONVERSATION_EVENT_TIMELINE_POLICY.NONE,
    CONVERSATION_EVENT_TIMELINE_POLICY.ALL_MEMBERS,
    CONVERSATION_EVENT_TIMELINE_POLICY.USERS_ONLY,
    CONVERSATION_EVENT_TIMELINE_POLICY.ACTORS_ONLY,
    CONVERSATION_EVENT_TIMELINE_POLICY.TARGETED_MEMBERS
  ];
  var CONVERSATION_EVENT_CONTEXT_POLICY = {
    NONE: "none",
    SHARED: "shared",
    ACTOR_PRIVATE: "actor_private",
    TARGETED_MEMBERS: "targeted_members"
  };
  var CONVERSATION_EVENT_CONTEXT_POLICIES = [
    CONVERSATION_EVENT_CONTEXT_POLICY.NONE,
    CONVERSATION_EVENT_CONTEXT_POLICY.SHARED,
    CONVERSATION_EVENT_CONTEXT_POLICY.ACTOR_PRIVATE,
    CONVERSATION_EVENT_CONTEXT_POLICY.TARGETED_MEMBERS
  ];
  var CONVERSATION_TYPE_MASK_BITS = {
    direct: 1 << 0,
    group: 1 << 1,
    im_direct: 1 << 2,
    im_group: 1 << 3
  };
  var CONVERSATION_TYPE_MASK_PRESETS = {
    ALL: CONVERSATION_TYPE_MASK_BITS.direct | CONVERSATION_TYPE_MASK_BITS.group | CONVERSATION_TYPE_MASK_BITS.im_direct | CONVERSATION_TYPE_MASK_BITS.im_group,
    // Native (in-app, non-IM) conversations only — replaces the old INTERNAL_ONLY.
    NATIVE_ONLY: CONVERSATION_TYPE_MASK_BITS.direct | CONVERSATION_TYPE_MASK_BITS.group,
    // IM-bridged conversations only — replaces the old EXTERNAL_ONLY / VIRTUAL_ONLY.
    IM_ONLY: CONVERSATION_TYPE_MASK_BITS.im_direct | CONVERSATION_TYPE_MASK_BITS.im_group,
    // 1:1 conversations across both native and IM.
    DIRECT_ONLY: CONVERSATION_TYPE_MASK_BITS.direct | CONVERSATION_TYPE_MASK_BITS.im_direct,
    // Group conversations across both native and IM.
    GROUP_ONLY: CONVERSATION_TYPE_MASK_BITS.group | CONVERSATION_TYPE_MASK_BITS.im_group,
    // Native (in-app) group conversations only — excludes IM groups. Used by
    // capabilities that must not act on IM-bridged group chats (e.g. invite_actor,
    // which must not pull more actors into a third-party IM group).
    NATIVE_GROUP_ONLY: CONVERSATION_TYPE_MASK_BITS.group
  };
  var DEFAULT_CONVERSATION_TYPE_MASK = CONVERSATION_TYPE_MASK_PRESETS.ALL;
  var REALTIME_ASR_AUDIO_FORMAT = {
    PCM: "pcm",
    OGG: "ogg"
  };
  var REALTIME_ASR_AUDIO_FORMATS = [
    REALTIME_ASR_AUDIO_FORMAT.PCM,
    REALTIME_ASR_AUDIO_FORMAT.OGG
  ];
  var REALTIME_ASR_AUDIO_CODEC = {
    RAW: "raw",
    OPUS: "opus"
  };
  var REALTIME_ASR_AUDIO_CODECS = [
    REALTIME_ASR_AUDIO_CODEC.RAW,
    REALTIME_ASR_AUDIO_CODEC.OPUS
  ];
  var DEVICE_CAPABILITY_ACCESS_SUBJECT_KIND = {
    WORKSPACE: "workspace",
    ACTOR: "actor",
    REMOTE_AGENT: "remote_agent",
    CONVERSATION: "conversation"
  };
  var DEVICE_CAPABILITY_ACCESS_SUBJECT_KINDS = [
    DEVICE_CAPABILITY_ACCESS_SUBJECT_KIND.WORKSPACE,
    DEVICE_CAPABILITY_ACCESS_SUBJECT_KIND.ACTOR,
    DEVICE_CAPABILITY_ACCESS_SUBJECT_KIND.REMOTE_AGENT,
    DEVICE_CAPABILITY_ACCESS_SUBJECT_KIND.CONVERSATION
  ];
  var DEVICE_CAPABILITY_ACCESS_SCOPE_KIND = {
    CONVERSATION: "conversation"
  };
  var DEVICE_CAPABILITY_ACCESS_SCOPE_KINDS = [
    DEVICE_CAPABILITY_ACCESS_SCOPE_KIND.CONVERSATION
  ];
  var TASK_REQUEST_KIND = {
    USER_INPUT: "user_input",
    PLAN_APPROVAL: "plan_approval",
    RUNTIME_AUTHORIZATION: "runtime_authorization"
  };
  var TASK_REQUEST_KINDS = [
    TASK_REQUEST_KIND.USER_INPUT,
    TASK_REQUEST_KIND.PLAN_APPROVAL,
    TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION
  ];
  var TARGETED_TASK_REQUEST_KINDS = [
    TASK_REQUEST_KIND.USER_INPUT,
    TASK_REQUEST_KIND.PLAN_APPROVAL
  ];
  var MODEL_GROUP_ROUTING_STRATEGY = {
    WEIGHTED_RANDOM: "weighted_random",
    PRIORITY_FAILOVER: "priority_failover"
  };
  var MODEL_GROUP_ROUTING_STRATEGIES = [
    MODEL_GROUP_ROUTING_STRATEGY.WEIGHTED_RANDOM,
    MODEL_GROUP_ROUTING_STRATEGY.PRIORITY_FAILOVER
  ];
  var MODEL_GROUP_OWNER_TYPE = {
    PLATFORM: "platform",
    WORKSPACE: "workspace",
    WORKSPACE_MEMBER: "workspace_member"
  };
  var MODEL_GROUP_OWNER_TYPES = [
    MODEL_GROUP_OWNER_TYPE.PLATFORM,
    MODEL_GROUP_OWNER_TYPE.WORKSPACE,
    MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER
  ];
  var MODEL_GROUP_GRANT_SCOPE = {
    PLATFORM: "platform",
    WORKSPACE: "workspace",
    WORKSPACE_MEMBER: "workspace_member",
    ACTOR: "actor"
  };
  var MODEL_GROUP_GRANT_SCOPES = [
    MODEL_GROUP_GRANT_SCOPE.PLATFORM,
    MODEL_GROUP_GRANT_SCOPE.WORKSPACE,
    MODEL_GROUP_GRANT_SCOPE.WORKSPACE_MEMBER,
    MODEL_GROUP_GRANT_SCOPE.ACTOR
  ];
  var MODEL_GROUP_GRANT_STATUS = {
    ACTIVE: "active",
    REVOKED: "revoked"
  };
  var MODEL_GROUP_GRANT_STATUSES = [
    MODEL_GROUP_GRANT_STATUS.ACTIVE,
    MODEL_GROUP_GRANT_STATUS.REVOKED
  ];
  var MODEL_API_STYLE = {
    CHAT: "chat",
    RESPONSES: "responses"
  };
  var MODEL_API_STYLES = [
    MODEL_API_STYLE.CHAT,
    MODEL_API_STYLE.RESPONSES
  ];
  var MODEL_SERVER_TOOL = {
    WEB_SEARCH: "web_search",
    WEB_FETCH: "web_fetch"
  };
  var MODEL_SERVER_TOOLS = [
    MODEL_SERVER_TOOL.WEB_SEARCH,
    MODEL_SERVER_TOOL.WEB_FETCH
  ];
  var REMOTE_AGENT_RUNTIME_KIND = {
    CLAUDE_CODE: "claude_code",
    CODEX: "codex"
  };
  var REMOTE_AGENT_RUNTIME_KINDS = [
    REMOTE_AGENT_RUNTIME_KIND.CLAUDE_CODE,
    REMOTE_AGENT_RUNTIME_KIND.CODEX
  ];
  var REMOTE_AGENT_RUNTIME_STATE = {
    OFFLINE: "offline",
    IDLE: "idle",
    RUNNING: "running",
    WAITING_USER_INPUT: "waiting_user_input",
    PLAN_DRAFTING: "plan_drafting",
    WAITING_PLAN_APPROVAL: "waiting_plan_approval",
    ERROR: "error"
  };
  var REMOTE_AGENT_RUNTIME_STATES = [
    REMOTE_AGENT_RUNTIME_STATE.OFFLINE,
    REMOTE_AGENT_RUNTIME_STATE.IDLE,
    REMOTE_AGENT_RUNTIME_STATE.RUNNING,
    REMOTE_AGENT_RUNTIME_STATE.WAITING_USER_INPUT,
    REMOTE_AGENT_RUNTIME_STATE.PLAN_DRAFTING,
    REMOTE_AGENT_RUNTIME_STATE.WAITING_PLAN_APPROVAL,
    REMOTE_AGENT_RUNTIME_STATE.ERROR
  ];
  var REMOTE_AGENT_RUNTIME_CATALOG_STATUS = {
    AVAILABLE: "available",
    MISSING_BINARY: "missing_binary",
    BROKEN_PATH: "broken_path",
    UNSUPPORTED_PLATFORM: "unsupported_platform",
    RUNTIME_ERROR: "runtime_error"
  };
  var REMOTE_AGENT_RUNTIME_CATALOG_STATUSES = [
    REMOTE_AGENT_RUNTIME_CATALOG_STATUS.AVAILABLE,
    REMOTE_AGENT_RUNTIME_CATALOG_STATUS.MISSING_BINARY,
    REMOTE_AGENT_RUNTIME_CATALOG_STATUS.BROKEN_PATH,
    REMOTE_AGENT_RUNTIME_CATALOG_STATUS.UNSUPPORTED_PLATFORM,
    REMOTE_AGENT_RUNTIME_CATALOG_STATUS.RUNTIME_ERROR
  ];
  var REMOTE_AGENT_BINDING_STATUS = {
    ACTIVE: "active",
    DISABLED: "disabled",
    ERROR: "error"
  };
  var REMOTE_AGENT_BINDING_STATUSES = [
    REMOTE_AGENT_BINDING_STATUS.ACTIVE,
    REMOTE_AGENT_BINDING_STATUS.DISABLED,
    REMOTE_AGENT_BINDING_STATUS.ERROR
  ];
  var REMOTE_AGENT_MACHINE_TRUST_STATUS = {
    PENDING: "pending",
    ACTIVE: "active",
    REVOKED: "revoked",
    BLOCKED: "blocked"
  };
  var REMOTE_AGENT_MACHINE_TRUST_STATUSES = [
    REMOTE_AGENT_MACHINE_TRUST_STATUS.PENDING,
    REMOTE_AGENT_MACHINE_TRUST_STATUS.ACTIVE,
    REMOTE_AGENT_MACHINE_TRUST_STATUS.REVOKED,
    REMOTE_AGENT_MACHINE_TRUST_STATUS.BLOCKED
  ];
  var REMOTE_AGENT_MACHINE_LIFECYCLE_STATE = {
    ONLINE: "online",
    OFFLINE: "offline"
  };
  var REMOTE_AGENT_MACHINE_LIFECYCLE_STATES = [
    REMOTE_AGENT_MACHINE_LIFECYCLE_STATE.ONLINE,
    REMOTE_AGENT_MACHINE_LIFECYCLE_STATE.OFFLINE
  ];
  var ACTOR_RUNTIME_HEALTH = {
    OK: "ok",
    ERROR: "error"
  };
  var ACTOR_RUNTIME_HEALTHS = [
    ACTOR_RUNTIME_HEALTH.OK,
    ACTOR_RUNTIME_HEALTH.ERROR
  ];
  var WEIXIN_QR_LOGIN_STATUS = {
    WAITING: "waiting",
    SCANNED: "scanned",
    // The phone shows a numeric pairing code the user must type back to continue.
    NEED_VERIFYCODE: "need_verifycode",
    CONFIRMED: "confirmed",
    EXPIRED: "expired",
    ERROR: "error"
  };
  var WEIXIN_QR_LOGIN_STATUSES = [
    WEIXIN_QR_LOGIN_STATUS.WAITING,
    WEIXIN_QR_LOGIN_STATUS.SCANNED,
    WEIXIN_QR_LOGIN_STATUS.NEED_VERIFYCODE,
    WEIXIN_QR_LOGIN_STATUS.CONFIRMED,
    WEIXIN_QR_LOGIN_STATUS.EXPIRED,
    WEIXIN_QR_LOGIN_STATUS.ERROR
  ];
  var DINGTALK_DEVICE_FLOW_STATUS = {
    WAITING: "waiting",
    SUCCESS: "success",
    FAIL: "fail",
    EXPIRED: "expired"
  };
  var DINGTALK_DEVICE_FLOW_STATUSES = [
    DINGTALK_DEVICE_FLOW_STATUS.WAITING,
    DINGTALK_DEVICE_FLOW_STATUS.SUCCESS,
    DINGTALK_DEVICE_FLOW_STATUS.FAIL,
    DINGTALK_DEVICE_FLOW_STATUS.EXPIRED
  ];
  var PLUGIN_AUTH_SESSION_STATUS = {
    PENDING: "pending",
    COMPLETED: "completed",
    FAILED: "failed",
    EXPIRED: "expired",
    CONSUMED: "consumed"
  };
  var PLUGIN_AUTH_SESSION_STATUSES = [
    PLUGIN_AUTH_SESSION_STATUS.PENDING,
    PLUGIN_AUTH_SESSION_STATUS.COMPLETED,
    PLUGIN_AUTH_SESSION_STATUS.FAILED,
    PLUGIN_AUTH_SESSION_STATUS.EXPIRED,
    PLUGIN_AUTH_SESSION_STATUS.CONSUMED
  ];
  var PLUGIN_AUTH_SESSION_PHASE = {
    AWAITING_START: "awaiting_start",
    AWAITING_EXTERNAL_INPUT: "awaiting_external_input",
    AWAITING_CALLBACK: "awaiting_callback",
    PENDING_SCAN: "pending_scan",
    PENDING_CONFIRM: "pending_confirm",
    FINALIZING: "finalizing"
  };
  var PLUGIN_AUTH_SESSION_PHASES = [
    PLUGIN_AUTH_SESSION_PHASE.AWAITING_START,
    PLUGIN_AUTH_SESSION_PHASE.AWAITING_EXTERNAL_INPUT,
    PLUGIN_AUTH_SESSION_PHASE.AWAITING_CALLBACK,
    PLUGIN_AUTH_SESSION_PHASE.PENDING_SCAN,
    PLUGIN_AUTH_SESSION_PHASE.PENDING_CONFIRM,
    PLUGIN_AUTH_SESSION_PHASE.FINALIZING
  ];
  var PLUGIN_AUTH_CONNECTION_STATUS = {
    ACTIVE: "active",
    EXPIRED: "expired",
    REVOKED: "revoked"
  };
  var PLUGIN_AUTH_CONNECTION_STATUSES = [
    PLUGIN_AUTH_CONNECTION_STATUS.ACTIVE,
    PLUGIN_AUTH_CONNECTION_STATUS.EXPIRED,
    PLUGIN_AUTH_CONNECTION_STATUS.REVOKED
  ];
  var AUTOMATION_RULE_CATEGORY = {
    SCHEDULE: "schedule",
    EVENT_SUBSCRIPTION: "event_subscription"
  };
  var AUTOMATION_RULE_CATEGORIES = [
    AUTOMATION_RULE_CATEGORY.SCHEDULE,
    AUTOMATION_RULE_CATEGORY.EVENT_SUBSCRIPTION
  ];
  var AUTOMATION_EXECUTION_STATUS = {
    PENDING: "pending",
    RUNNING: "running",
    COMPLETED: "completed",
    FAILED: "failed",
    SKIPPED: "skipped"
  };
  var AUTOMATION_EXECUTION_STATUSES = [
    AUTOMATION_EXECUTION_STATUS.PENDING,
    AUTOMATION_EXECUTION_STATUS.RUNNING,
    AUTOMATION_EXECUTION_STATUS.COMPLETED,
    AUTOMATION_EXECUTION_STATUS.FAILED,
    AUTOMATION_EXECUTION_STATUS.SKIPPED
  ];
  var AUTOMATION_WEBHOOK_ENDPOINT_STATUS = {
    ACTIVE: "active",
    DISABLED: "disabled",
    ARCHIVED: "archived"
  };
  var AUTOMATION_WEBHOOK_ENDPOINT_STATUSES = [
    AUTOMATION_WEBHOOK_ENDPOINT_STATUS.ACTIVE,
    AUTOMATION_WEBHOOK_ENDPOINT_STATUS.DISABLED,
    AUTOMATION_WEBHOOK_ENDPOINT_STATUS.ARCHIVED
  ];
  var MARKETPLACE_ITEM_KIND = {
    PLUGIN: "plugin",
    SKILL: "skill",
    ACTOR: "actor",
    MODEL: "model"
  };
  var MARKETPLACE_ITEM_KINDS = [
    MARKETPLACE_ITEM_KIND.PLUGIN,
    MARKETPLACE_ITEM_KIND.SKILL,
    MARKETPLACE_ITEM_KIND.ACTOR,
    MARKETPLACE_ITEM_KIND.MODEL
  ];
  var MARKETPLACE_SOURCE_TYPE = {
    BUILTIN: "builtin",
    OFFICIAL: "official",
    WORKSPACE_UPLOAD: "workspace_upload",
    USER_UPLOAD: "user_upload"
  };
  var MARKETPLACE_SOURCE_TYPES = [
    MARKETPLACE_SOURCE_TYPE.BUILTIN,
    MARKETPLACE_SOURCE_TYPE.OFFICIAL,
    MARKETPLACE_SOURCE_TYPE.WORKSPACE_UPLOAD,
    MARKETPLACE_SOURCE_TYPE.USER_UPLOAD
  ];
  var MARKETPLACE_SYNC_MODE = {
    NOTIFY: "notify",
    MANUAL_MERGE: "manual_merge",
    FOLLOW_UPSTREAM: "follow_upstream",
    DETACHED: "detached"
  };
  var MARKETPLACE_SYNC_MODES = [
    MARKETPLACE_SYNC_MODE.NOTIFY,
    MARKETPLACE_SYNC_MODE.MANUAL_MERGE,
    MARKETPLACE_SYNC_MODE.FOLLOW_UPSTREAM,
    MARKETPLACE_SYNC_MODE.DETACHED
  ];
  var MARKETPLACE_VERSION_STATUS = {
    DRAFT: "draft",
    ACTIVE: "active",
    DEPRECATED: "deprecated",
    ARCHIVED: "archived"
  };
  var MARKETPLACE_VERSION_STATUSES = [
    MARKETPLACE_VERSION_STATUS.DRAFT,
    MARKETPLACE_VERSION_STATUS.ACTIVE,
    MARKETPLACE_VERSION_STATUS.DEPRECATED,
    MARKETPLACE_VERSION_STATUS.ARCHIVED
  ];
  var MARKETPLACE_ASSET_KIND = {
    SKILL_MARKDOWN: "skill_markdown",
    REFERENCE_MARKDOWN: "reference_markdown",
    SCRIPT: "script",
    JSON: "json",
    TEXT: "text",
    BINARY: "binary"
  };
  var MARKETPLACE_ASSET_KINDS = [
    MARKETPLACE_ASSET_KIND.SKILL_MARKDOWN,
    MARKETPLACE_ASSET_KIND.REFERENCE_MARKDOWN,
    MARKETPLACE_ASSET_KIND.SCRIPT,
    MARKETPLACE_ASSET_KIND.JSON,
    MARKETPLACE_ASSET_KIND.TEXT,
    MARKETPLACE_ASSET_KIND.BINARY
  ];
  var ACTOR_PACKAGE_DEPENDENCY_KIND = {
    REQUIRED: "required",
    RECOMMENDED: "recommended"
  };
  var ACTOR_PACKAGE_DEPENDENCY_KINDS = [
    ACTOR_PACKAGE_DEPENDENCY_KIND.REQUIRED,
    ACTOR_PACKAGE_DEPENDENCY_KIND.RECOMMENDED
  ];
  var ACTOR_PACKAGE_TARGET_KIND = {
    PLUGIN: MARKETPLACE_ITEM_KIND.PLUGIN,
    SKILL: MARKETPLACE_ITEM_KIND.SKILL
  };
  var ACTOR_PACKAGE_TARGET_KINDS = [
    ACTOR_PACKAGE_TARGET_KIND.PLUGIN,
    ACTOR_PACKAGE_TARGET_KIND.SKILL
  ];
  var ACTOR_UPDATE_SOURCE_TYPE = {
    WORKSPACE_MEMBER: "workspace_member",
    ACTOR: "actor",
    SYSTEM: "system",
    SYNC: "sync"
  };
  var ACTOR_UPDATE_SOURCE_TYPES = [
    ACTOR_UPDATE_SOURCE_TYPE.WORKSPACE_MEMBER,
    ACTOR_UPDATE_SOURCE_TYPE.ACTOR,
    ACTOR_UPDATE_SOURCE_TYPE.SYSTEM,
    ACTOR_UPDATE_SOURCE_TYPE.SYNC
  ];
  var ACTOR_VERSION_CHANGED_FIELD = {
    DISPLAY_NAME: "displayName",
    ROLE: "role",
    TITLE: "title",
    PARENT_ID: "parentId",
    CAN_REPRESENT_USER: "canRepresentUser",
    SPECIALTIES: "specialties",
    CONFIG: "config"
  };
  var ACTOR_VERSION_CHANGED_FIELDS = [
    ACTOR_VERSION_CHANGED_FIELD.DISPLAY_NAME,
    ACTOR_VERSION_CHANGED_FIELD.ROLE,
    ACTOR_VERSION_CHANGED_FIELD.TITLE,
    ACTOR_VERSION_CHANGED_FIELD.PARENT_ID,
    ACTOR_VERSION_CHANGED_FIELD.CAN_REPRESENT_USER,
    ACTOR_VERSION_CHANGED_FIELD.SPECIALTIES,
    ACTOR_VERSION_CHANGED_FIELD.CONFIG
  ];
  var ACTOR_DOC_CHANGED_FIELD = {
    TITLE: "title",
    VISIBILITY: "visibility",
    PRIORITY: "priority",
    CONTENT: "content"
  };
  var ACTOR_DOC_CHANGED_FIELDS = [
    ACTOR_DOC_CHANGED_FIELD.TITLE,
    ACTOR_DOC_CHANGED_FIELD.VISIBILITY,
    ACTOR_DOC_CHANGED_FIELD.PRIORITY,
    ACTOR_DOC_CHANGED_FIELD.CONTENT
  ];
  var ACTOR_VERSION_DOC_CHANGE_TYPE = {
    ADDED: "added",
    UPDATED: "updated",
    REMOVED: "removed"
  };
  var ACTOR_VERSION_DOC_CHANGE_TYPES = [
    ACTOR_VERSION_DOC_CHANGE_TYPE.ADDED,
    ACTOR_VERSION_DOC_CHANGE_TYPE.UPDATED,
    ACTOR_VERSION_DOC_CHANGE_TYPE.REMOVED
  ];
  var ACTOR_PACKAGE_LINK_STATUS = {
    UP_TO_DATE: "up_to_date",
    UPDATE_AVAILABLE: "update_available",
    DIVERGED: "diverged",
    UPDATE_AVAILABLE_WITH_LOCAL_CHANGES: "update_available_with_local_changes",
    DETACHED: "detached"
  };
  var ACTOR_PACKAGE_LINK_STATUSES = [
    ACTOR_PACKAGE_LINK_STATUS.UP_TO_DATE,
    ACTOR_PACKAGE_LINK_STATUS.UPDATE_AVAILABLE,
    ACTOR_PACKAGE_LINK_STATUS.DIVERGED,
    ACTOR_PACKAGE_LINK_STATUS.UPDATE_AVAILABLE_WITH_LOCAL_CHANGES,
    ACTOR_PACKAGE_LINK_STATUS.DETACHED
  ];
  var ACTOR_PACKAGE_SYNC_MODE = {
    NOTIFY: MARKETPLACE_SYNC_MODE.NOTIFY,
    MANUAL_MERGE: MARKETPLACE_SYNC_MODE.MANUAL_MERGE
  };
  var ACTOR_PACKAGE_SYNC_MODES = [
    ACTOR_PACKAGE_SYNC_MODE.NOTIFY,
    ACTOR_PACKAGE_SYNC_MODE.MANUAL_MERGE
  ];
  var PLUGIN_INSTALL_ACTION_KIND = {
    AUTH_START: "auth_start",
    EXTERNAL_LINK: "external_link",
    NOOP: "noop"
  };
  var PLUGIN_INSTALL_ACTION_KINDS = [
    PLUGIN_INSTALL_ACTION_KIND.AUTH_START,
    PLUGIN_INSTALL_ACTION_KIND.EXTERNAL_LINK,
    PLUGIN_INSTALL_ACTION_KIND.NOOP
  ];
  var PLUGIN_AUTH_CHALLENGE_KIND = {
    REDIRECT: "redirect",
    QR_CODE: "qr_code",
    NONE: "none"
  };
  var PLUGIN_AUTH_CHALLENGE_KINDS = [
    PLUGIN_AUTH_CHALLENGE_KIND.REDIRECT,
    PLUGIN_AUTH_CHALLENGE_KIND.QR_CODE,
    PLUGIN_AUTH_CHALLENGE_KIND.NONE
  ];
  var PLUGIN_AUTH_CHALLENGE_OPEN_MODE = {
    POPUP: "popup",
    REPLACE: "replace"
  };
  var PLUGIN_AUTH_CHALLENGE_OPEN_MODES = [
    PLUGIN_AUTH_CHALLENGE_OPEN_MODE.POPUP,
    PLUGIN_AUTH_CHALLENGE_OPEN_MODE.REPLACE
  ];
  var MARKETPLACE_LINEAGE_KIND = {
    INSTALLED_COPY: "installed_copy",
    FORK: "fork",
    SHARE: "share"
  };
  var MARKETPLACE_LINEAGE_KINDS = [
    MARKETPLACE_LINEAGE_KIND.INSTALLED_COPY,
    MARKETPLACE_LINEAGE_KIND.FORK,
    MARKETPLACE_LINEAGE_KIND.SHARE
  ];
  var MARKETPLACE_REQUIREMENT_KIND = {
    REQUIRED: "required",
    RECOMMENDED: "recommended",
    OPTIONAL: "optional",
    CONFLICTS_WITH: "conflicts_with"
  };
  var MARKETPLACE_REQUIREMENT_KINDS = [
    MARKETPLACE_REQUIREMENT_KIND.REQUIRED,
    MARKETPLACE_REQUIREMENT_KIND.RECOMMENDED,
    MARKETPLACE_REQUIREMENT_KIND.OPTIONAL,
    MARKETPLACE_REQUIREMENT_KIND.CONFLICTS_WITH
  ];
  var MARKETPLACE_REQUIREMENT_TARGET_KIND = {
    PACKAGE: "package",
    TAG: "tag"
  };
  var MARKETPLACE_REQUIREMENT_TARGET_KINDS = [
    MARKETPLACE_REQUIREMENT_TARGET_KIND.PACKAGE,
    MARKETPLACE_REQUIREMENT_TARGET_KIND.TAG
  ];
  var MARKETPLACE_REQUIREMENT_STATUS = {
    SATISFIED: "satisfied",
    MISSING_REQUIRED: "missing_required",
    MISSING_RECOMMENDED: "missing_recommended",
    SCOPE_MISMATCH: "scope_mismatch",
    CONFIG_INCOMPLETE: "config_incomplete"
  };
  var MARKETPLACE_REQUIREMENT_STATUSES = [
    MARKETPLACE_REQUIREMENT_STATUS.SATISFIED,
    MARKETPLACE_REQUIREMENT_STATUS.MISSING_REQUIRED,
    MARKETPLACE_REQUIREMENT_STATUS.MISSING_RECOMMENDED,
    MARKETPLACE_REQUIREMENT_STATUS.SCOPE_MISMATCH,
    MARKETPLACE_REQUIREMENT_STATUS.CONFIG_INCOMPLETE
  ];
  var PLUGIN_CONFIG_FIELD_TYPE = {
    TEXT: "text",
    TEXTAREA: "textarea",
    NUMBER: "number",
    BOOLEAN: "boolean",
    SELECT: "select",
    MULTISELECT: "multiselect",
    SECRET: "secret",
    AUTH_CONNECTION: "auth_connection",
    FILE: "file"
  };
  var PLUGIN_CONFIG_FIELD_TYPES = [
    PLUGIN_CONFIG_FIELD_TYPE.TEXT,
    PLUGIN_CONFIG_FIELD_TYPE.TEXTAREA,
    PLUGIN_CONFIG_FIELD_TYPE.NUMBER,
    PLUGIN_CONFIG_FIELD_TYPE.BOOLEAN,
    PLUGIN_CONFIG_FIELD_TYPE.SELECT,
    PLUGIN_CONFIG_FIELD_TYPE.MULTISELECT,
    PLUGIN_CONFIG_FIELD_TYPE.SECRET,
    PLUGIN_CONFIG_FIELD_TYPE.AUTH_CONNECTION,
    PLUGIN_CONFIG_FIELD_TYPE.FILE
  ];
  var PLUGIN_INSTALL_STEP_KIND = {
    FORM: "form",
    AUTH: "auth",
    CHECK: "check",
    CONFIRM: "confirm",
    REUSE_SCOPE: "reuse_scope",
    INTEGRATION_EVENTS: "integration_events"
  };
  var PLUGIN_INSTALL_STEP_KINDS = [
    PLUGIN_INSTALL_STEP_KIND.FORM,
    PLUGIN_INSTALL_STEP_KIND.AUTH,
    PLUGIN_INSTALL_STEP_KIND.CHECK,
    PLUGIN_INSTALL_STEP_KIND.CONFIRM,
    PLUGIN_INSTALL_STEP_KIND.REUSE_SCOPE,
    PLUGIN_INSTALL_STEP_KIND.INTEGRATION_EVENTS
  ];
  var PLUGIN_INSTALL_STEP_SCOPE = {
    WORKSPACE: "workspace",
    PLUGIN: "plugin"
  };
  var PLUGIN_INSTALL_STEP_SCOPES = [
    PLUGIN_INSTALL_STEP_SCOPE.WORKSPACE,
    PLUGIN_INSTALL_STEP_SCOPE.PLUGIN
  ];
  var PLUGIN_AUTH_VALUE_SOURCE_KIND = {
    CONFIG: "config",
    ENV: "env",
    LITERAL: "literal",
    DERIVED: "derived"
  };
  var PLUGIN_AUTH_VALUE_SOURCE_KINDS = [
    PLUGIN_AUTH_VALUE_SOURCE_KIND.CONFIG,
    PLUGIN_AUTH_VALUE_SOURCE_KIND.ENV,
    PLUGIN_AUTH_VALUE_SOURCE_KIND.LITERAL,
    PLUGIN_AUTH_VALUE_SOURCE_KIND.DERIVED
  ];
  var PLUGIN_AUTH_DERIVED_VALUE_NAME = {
    APP_BASE_URL: "app_base_url",
    OAUTH_CALLBACK_URL: "oauth_callback_url"
  };
  var PLUGIN_AUTH_DERIVED_VALUE_NAMES = [
    PLUGIN_AUTH_DERIVED_VALUE_NAME.APP_BASE_URL,
    PLUGIN_AUTH_DERIVED_VALUE_NAME.OAUTH_CALLBACK_URL
  ];
  var PLUGIN_AUTH_BINDING_DRIVER_KIND = {
    OAUTH2_AUTHORIZATION_CODE_PKCE: "oauth2_authorization_code_pkce",
    MIJIA_QR_LOGIN: "mijia_qr_login",
    FEISHU_CLI_SETUP: "feishu_cli_setup"
  };
  var PLUGIN_AUTH_BINDING_DRIVER_KINDS = [
    PLUGIN_AUTH_BINDING_DRIVER_KIND.OAUTH2_AUTHORIZATION_CODE_PKCE,
    PLUGIN_AUTH_BINDING_DRIVER_KIND.MIJIA_QR_LOGIN,
    PLUGIN_AUTH_BINDING_DRIVER_KIND.FEISHU_CLI_SETUP
  ];
  var MCP_VALIDATION_RULE_KIND = {
    REQUIRED: "required",
    PATTERN: "pattern",
    URL: "url",
    MIN_LENGTH: "min_length",
    MAX_LENGTH: "max_length",
    PREFIX: "prefix",
    ENUM: "enum"
  };
  var MCP_VALIDATION_RULE_KINDS = [
    MCP_VALIDATION_RULE_KIND.REQUIRED,
    MCP_VALIDATION_RULE_KIND.PATTERN,
    MCP_VALIDATION_RULE_KIND.URL,
    MCP_VALIDATION_RULE_KIND.MIN_LENGTH,
    MCP_VALIDATION_RULE_KIND.MAX_LENGTH,
    MCP_VALIDATION_RULE_KIND.PREFIX,
    MCP_VALIDATION_RULE_KIND.ENUM
  ];
  var PLUGIN_INSTALLATION_MODE = {
    MANUAL: "manual",
    SEEDED: "seeded",
    PACKAGE_REQUIRED: "package_required",
    PACKAGE_RECOMMENDED: "package_recommended"
  };
  var PLUGIN_INSTALLATION_MODES = [
    PLUGIN_INSTALLATION_MODE.MANUAL,
    PLUGIN_INSTALLATION_MODE.SEEDED,
    PLUGIN_INSTALLATION_MODE.PACKAGE_REQUIRED,
    PLUGIN_INSTALLATION_MODE.PACKAGE_RECOMMENDED
  ];
  var PLUGIN_INSTALLATION_STATUS = {
    ACTIVE: "active",
    DISABLED: "disabled",
    ERROR: "error",
    ARCHIVED: "archived"
  };
  var PLUGIN_INSTALLATION_STATUSES = [
    PLUGIN_INSTALLATION_STATUS.ACTIVE,
    PLUGIN_INSTALLATION_STATUS.DISABLED,
    PLUGIN_INSTALLATION_STATUS.ERROR,
    PLUGIN_INSTALLATION_STATUS.ARCHIVED
  ];

  // ../shared/dist/constants/index.js
  var API_VERSION = "v1";
  var API_PREFIX = `/api/${API_VERSION}`;
  var AUTH_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
  var MCP_INSTANCE_TTL = {
    actor: 30 * 60 * 1e3,
    // 30 minutes
    workspace: 60 * 60 * 1e3
    // 60 minutes
  };

  // src/lib/chat-data.ts
  function createEmptyChatWorkspaceQueueState(workspaceId) {
    return {
      version: 2,
      workspaceId,
      inboxCursor: 0,
      pendingReads: {},
      outbox: {},
      tombstones: {}
    };
  }
  function readTimestamp(value) {
    return typeof value === "string" && isIsoInstant(value) ? value : void 0;
  }
  function normalizeTombstones(value) {
    if (!value || typeof value !== "object") {
      return {};
    }
    return Object.fromEntries(
      Object.values(value).filter(
        (entry) => Boolean(
          entry && typeof entry === "object" && typeof entry.conversationId === "string" && typeof entry.removedSeq === "number"
        )
      ).map((entry) => [entry.conversationId, entry])
    );
  }
  function normalizePendingReads(value, validConversationIds) {
    if (!value || typeof value !== "object") {
      return {};
    }
    return Object.fromEntries(
      Object.values(value).filter(
        (entry) => Boolean(
          entry && typeof entry === "object" && typeof entry.conversationId === "string" && typeof entry.readUpToSequence === "number" && typeof entry.lastVisibleSequence === "number" && typeof entry.updatedAt === "string"
        )
      ).filter(
        (entry) => !validConversationIds || validConversationIds.has(entry.conversationId)
      ).map((entry) => [entry.conversationId, entry])
    );
  }
  function normalizeOutbox(value, validConversationIds) {
    if (!value || typeof value !== "object") {
      return {};
    }
    return Object.fromEntries(
      Object.values(value).filter(
        (entry) => Boolean(
          entry && typeof entry === "object" && typeof entry.clientMessageId === "string" && typeof entry.conversationId === "string" && Array.isArray(entry.contentBlocks) && typeof entry.createdAt === "string" && typeof entry.optimisticSequence === "number" && typeof entry.status === "string" && typeof entry.attemptCount === "number"
        )
      ).filter(
        (entry) => !validConversationIds || validConversationIds.has(entry.conversationId)
      ).map((entry) => [entry.clientMessageId, entry])
    );
  }
  function normalizeChatWorkspaceQueueState(workspaceId, value) {
    if (!value || typeof value !== "object") {
      return createEmptyChatWorkspaceQueueState(workspaceId);
    }
    const queueState = value;
    const version = queueState.version ?? 0;
    const isV1 = version === 1;
    const isV2 = version === 2;
    if (!isV1 && !isV2 || queueState.workspaceId !== workspaceId) {
      return createEmptyChatWorkspaceQueueState(workspaceId);
    }
    return {
      version: 2,
      workspaceId,
      workspaceMemberId: typeof queueState.workspaceMemberId === "string" ? queueState.workspaceMemberId : void 0,
      clientInstanceId: typeof queueState.clientInstanceId === "string" && isUuid(queueState.clientInstanceId) ? queueState.clientInstanceId : void 0,
      inboxCursor: isV2 && typeof queueState.inboxCursor === "number" && Number.isFinite(queueState.inboxCursor) ? queueState.inboxCursor : 0,
      lastBootstrappedAt: readTimestamp(queueState.lastBootstrappedAt),
      pendingReads: normalizePendingReads(queueState.pendingReads),
      outbox: normalizeOutbox(queueState.outbox),
      tombstones: isV2 ? normalizeTombstones(queueState.tombstones) : {}
    };
  }

  // ../shared/dist/chat-queue/index.js
  var import_fast_deep_equal = __toESM(require_fast_deep_equal(), 1);
  var CHAT_QUEUE_DB_NAME = "synapse-chat-queue";
  var CHAT_QUEUE_DB_VERSION = 1;
  var CHAT_QUEUE_STATE_STORE = "workspace_queue_states";
  var CHAT_QUEUE_BROADCAST_CHANNEL = "synapse-chat-queue";
  var CHAT_SERVICE_WORKER_SYNC_TAG = "synapse-chat-sync";
  var CHAT_SERVICE_WORKER_PERIODIC_SYNC_TAG = "synapse-chat-periodic-sync";
  function sameEntry(left, right) {
    return (0, import_fast_deep_equal.default)(left ?? null, right ?? null);
  }
  function mergeQueueStateForSave(baseQueueState, latestQueueState, processedQueueState) {
    const next = {
      ...latestQueueState,
      workspaceId: latestQueueState.workspaceId,
      workspaceMemberId: latestQueueState.workspaceMemberId || processedQueueState.workspaceMemberId,
      clientInstanceId: latestQueueState.clientInstanceId || processedQueueState.clientInstanceId,
      inboxCursor: Math.max(latestQueueState.inboxCursor || 0, processedQueueState.inboxCursor || 0),
      lastBootstrappedAt: latestQueueState.lastBootstrappedAt || processedQueueState.lastBootstrappedAt,
      pendingReads: { ...latestQueueState.pendingReads },
      outbox: { ...latestQueueState.outbox },
      // The SW never mutates tombstones (it only flushes outbox/reads), so
      // preserve whatever the latest UI-thread state holds. Carried through so the
      // round-trip save doesn't strip the field.
      tombstones: latestQueueState.tombstones ? { ...latestQueueState.tombstones } : processedQueueState.tombstones ? { ...processedQueueState.tombstones } : void 0
    };
    for (const conversationId of Object.keys(baseQueueState.pendingReads)) {
      const baseEntry = baseQueueState.pendingReads[conversationId];
      const latestEntry = next.pendingReads[conversationId];
      const processedEntry = processedQueueState.pendingReads[conversationId];
      if (!sameEntry(latestEntry, baseEntry))
        continue;
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
      if (!sameEntry(latestEntry, baseEntry))
        continue;
      if (processedEntry) {
        next.outbox[clientMessageId] = processedEntry;
      } else {
        delete next.outbox[clientMessageId];
      }
    }
    return next;
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

  // src/lib/chat-web-queue-storage.ts
  var CHAT_WEB_QUEUE_DB_NAME = CHAT_QUEUE_DB_NAME;
  var CHAT_WEB_QUEUE_DB_VERSION = CHAT_QUEUE_DB_VERSION;
  var CHAT_WEB_QUEUE_STATE_STORE = CHAT_QUEUE_STATE_STORE;
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
            if (!database.objectStoreNames.contains(
              CHAT_WEB_WORKER_AUTH_CONTEXT_STORE
            )) {
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
    return createEmptyChatWorkspaceQueueState(workspaceId);
  }
  function normalizeStoredChatWorkspaceQueueState(workspaceId, value) {
    return normalizeChatWorkspaceQueueState(workspaceId, value);
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
      updatedAt: nowIsoInstant()
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
      updatedAt: nowIsoInstant()
    });
  }
  async function clearStoredChatWorkerAuthContext() {
    const database = await getWorkerDatabase();
    await database.delete(CHAT_WEB_WORKER_AUTH_CONTEXT_STORE, "active");
  }
  function sameStoredChatQueueState(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  // src/lib/storage-keys.ts
  var CHAT_WEB_SERVICE_WORKER_BROADCAST_CHANNEL = CHAT_QUEUE_BROADCAST_CHANNEL;
  var CHAT_WEB_SERVICE_WORKER_SYNC_TAG = CHAT_SERVICE_WORKER_SYNC_TAG;
  var CHAT_WEB_SERVICE_WORKER_PERIODIC_SYNC_TAG = CHAT_SERVICE_WORKER_PERIODIC_SYNC_TAG;

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
      const error = new Error(
        data && data.error || "Request failed"
      );
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
    return flushOutboxQueue(queueState, {
      now: () => nowIsoInstant(),
      failureMessage: "发送失败",
      send: async (entry) => {
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
      }
    });
  }
  async function broadcast(message) {
    try {
      if ("BroadcastChannel" in scope) {
        const channel = new BroadcastChannel(
          CHAT_WEB_SERVICE_WORKER_BROADCAST_CHANNEL
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
      processedQueueState = await flushPendingReads(
        effectiveAuth,
        processedQueueState
      );
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
