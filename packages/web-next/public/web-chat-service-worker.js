/* eslint-disable */
"use strict";
(() => {
  // ../../node_modules/idb/build/index.js
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

  // ../device-protocol/dist/browser-tools.js
  var BROWSER_TOOL_MAP = {
    // ── navigation ─────────────────────────────────────────────────────────
    list_pages: {
      exposure: "navigation",
      operation: "page.read",
      action: "read",
      target: { kind: "all_pages" },
      enabledByDefault: true
    },
    new_page: {
      exposure: "navigation",
      operation: "page.navigate",
      action: "write",
      target: { kind: "argument_url", argKey: "url" },
      enabledByDefault: true
    },
    navigate_page: {
      // chrome-devtools-mcp 0.7.0: schema is {url} — no `type` discriminator.
      exposure: "navigation",
      operation: "page.navigate",
      action: "write",
      target: { kind: "argument_url", argKey: "url" },
      enabledByDefault: true
    },
    navigate_page_history: {
      // back/forward on the currently selected page.
      exposure: "navigation",
      operation: "page.navigate",
      action: "write",
      target: { kind: "current_page" },
      enabledByDefault: true
    },
    select_page: {
      exposure: "navigation",
      operation: "page.read",
      action: "read",
      target: { kind: "page_id", argKey: "pageIdx" },
      enabledByDefault: true
    },
    close_page: {
      exposure: "navigation",
      operation: "page.navigate",
      action: "write",
      target: { kind: "page_id", argKey: "pageIdx" },
      enabledByDefault: true
    },
    wait_for: {
      exposure: "navigation",
      operation: "page.read",
      action: "read",
      target: { kind: "current_page" },
      enabledByDefault: true
    },
    // ── read ───────────────────────────────────────────────────────────────
    take_snapshot: {
      exposure: "read",
      operation: "page.read",
      action: "read",
      target: { kind: "current_page" },
      enabledByDefault: true
    },
    take_screenshot: {
      exposure: "read",
      operation: "screenshot.capture",
      action: "read",
      target: { kind: "current_page" },
      enabledByDefault: true
    },
    list_console_messages: {
      exposure: "read",
      operation: "console.read",
      action: "read",
      target: { kind: "current_page" },
      enabledByDefault: true
    },
    // ── input ──────────────────────────────────────────────────────────────
    // 0.7.0 input tools: click, hover, fill, drag, fill_form, upload_file +
    // handle_dialog (lives in pages.js but classified as INPUT_AUTOMATION).
    // `press_key` / `type_text` do not exist upstream.
    click: {
      exposure: "input",
      operation: "page.input",
      action: "write",
      target: { kind: "current_page" },
      enabledByDefault: true
    },
    fill: {
      exposure: "input",
      operation: "page.input",
      action: "write",
      target: { kind: "current_page" },
      enabledByDefault: true
    },
    fill_form: {
      exposure: "input",
      operation: "page.input",
      action: "write",
      target: { kind: "current_page" },
      enabledByDefault: true
    },
    hover: {
      exposure: "input",
      operation: "page.input",
      action: "write",
      target: { kind: "current_page" },
      enabledByDefault: true
    },
    handle_dialog: {
      exposure: "input",
      operation: "page.input",
      action: "write",
      target: { kind: "current_page" },
      enabledByDefault: true
    },
    // ── network (allow-flag gated) ─────────────────────────────────────────
    list_network_requests: {
      exposure: "network",
      operation: "network.list",
      action: "read",
      target: { kind: "current_page" },
      enabledByDefault: false,
      allowFlag: "network"
    },
    get_network_request: {
      // 0.7.0: schema is {url}. The URL identifies the request AND is the
      // authz target — no need for a separate current-page lookup.
      exposure: "network",
      operation: "network.body.read",
      action: "read",
      target: { kind: "argument_url", argKey: "url" },
      enabledByDefault: false,
      allowFlag: "network"
    },
    // ── performance (allow-flag gated) ─────────────────────────────────────
    performance_start_trace: {
      exposure: "performance",
      operation: "performance.trace",
      action: "read",
      target: { kind: "current_page" },
      enabledByDefault: false,
      allowFlag: "performance"
    },
    performance_stop_trace: {
      exposure: "performance",
      operation: "performance.trace",
      action: "read",
      target: { kind: "current_page" },
      enabledByDefault: false,
      allowFlag: "performance"
    },
    performance_analyze_insight: {
      exposure: "performance",
      operation: "performance.trace",
      action: "read",
      target: { kind: "current_page" },
      enabledByDefault: false,
      allowFlag: "performance"
    },
    // ── script (allow-flag gated) ──────────────────────────────────────────
    evaluate_script: {
      exposure: "script",
      operation: "script.evaluate",
      action: "write",
      target: { kind: "current_page" },
      enabledByDefault: false,
      allowFlag: "script"
    },
    // ── lite provider legacy tools (kept here so api/buildRequestedAction can
    //    project them without a special case; lite exposure self-declares them) ─
    browser_navigate: {
      // exposure value is irrelevant for lite; api preflight only checks the
      // descriptor itself. Pick navigation for visual consistency.
      exposure: "navigation",
      operation: "page.navigate",
      action: "write",
      target: { kind: "argument_url", argKey: "url" },
      enabledByDefault: true
    },
    browser_read_text: {
      exposure: "read",
      operation: "page.read",
      action: "read",
      target: { kind: "current_page" },
      enabledByDefault: true
    }
  };
  var BROWSER_OPERATION_REQUIRED_ACTION_BASE = {
    "page.read": "read",
    "page.navigate": "write",
    "page.input": "write",
    "screenshot.capture": "read",
    "console.read": "read",
    "network.list": "read",
    "network.body.read": "read",
    "script.evaluate": "write",
    "performance.trace": "read",
    // Deferred operations: not in BROWSER_TOOL_MAP today, but listed in the
    // enum so a grant policy can name them. Each one is write-sensitive
    // (uploads files, manages extensions, executes WebMCP tools), so
    // explicit "write" prevents an action=read grant from covering them
    // if/when the deferred exposure ships.
    "file.upload": "write",
    "extension.manage": "write",
    "webmcp.execute": "write"
  };
  var BROWSER_OPERATION_REQUIRED_ACTION = (() => {
    const out = {
      ...BROWSER_OPERATION_REQUIRED_ACTION_BASE
    };
    for (const desc of Object.values(BROWSER_TOOL_MAP)) {
      if (desc.action === "write") {
        out[desc.operation] = "write";
      }
    }
    return out;
  })();

  // ../shared/dist/constants/enums.js
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
  var RELATIONSHIP_ACCESS_POLICY = {
    WORKSPACE_OPEN: "workspace_open",
    APPROVAL_REQUIRED: "approval_required"
  };
  var RELATIONSHIP_ACCESS_POLICIES = [
    RELATIONSHIP_ACCESS_POLICY.WORKSPACE_OPEN,
    RELATIONSHIP_ACCESS_POLICY.APPROVAL_REQUIRED
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
    FILE_ORIGIN_SYSTEMS.QQ_INBOUND_MEDIA_INGEST
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
    GROUP: "group",
    PRIVATE: "private",
    VIRTUAL: "virtual"
  };
  var CONVERSATION_KINDS = [
    CONVERSATION_KIND.GROUP,
    CONVERSATION_KIND.PRIVATE,
    CONVERSATION_KIND.VIRTUAL
  ];
  var CONVERSATION_BOUNDARY = {
    INTERNAL: "internal",
    EXTERNAL: "external"
  };
  var CONVERSATION_BOUNDARIES = [
    CONVERSATION_BOUNDARY.INTERNAL,
    CONVERSATION_BOUNDARY.EXTERNAL
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
  var CHAT_TYPING_STATE = {
    STARTED: "started",
    STOPPED: "stopped"
  };
  var CHAT_TYPING_STATES = [
    CHAT_TYPING_STATE.STARTED,
    CHAT_TYPING_STATE.STOPPED
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
  var CONVERSATION_TYPE_MASK_BITS = {
    internal_private: 1 << 0,
    internal_group: 1 << 1,
    external_private: 1 << 2,
    external_group: 1 << 3,
    virtual: 1 << 4
  };
  var CONVERSATION_TYPE_MASK_PRESETS = {
    ALL: CONVERSATION_TYPE_MASK_BITS.internal_private | CONVERSATION_TYPE_MASK_BITS.internal_group | CONVERSATION_TYPE_MASK_BITS.external_private | CONVERSATION_TYPE_MASK_BITS.external_group | CONVERSATION_TYPE_MASK_BITS.virtual,
    INTERNAL_ONLY: CONVERSATION_TYPE_MASK_BITS.internal_private | CONVERSATION_TYPE_MASK_BITS.internal_group,
    EXTERNAL_ONLY: CONVERSATION_TYPE_MASK_BITS.external_private | CONVERSATION_TYPE_MASK_BITS.external_group,
    GROUP_ONLY: CONVERSATION_TYPE_MASK_BITS.internal_group | CONVERSATION_TYPE_MASK_BITS.external_group,
    PRIVATE_ONLY: CONVERSATION_TYPE_MASK_BITS.internal_private | CONVERSATION_TYPE_MASK_BITS.external_private,
    VIRTUAL_ONLY: CONVERSATION_TYPE_MASK_BITS.virtual
  };
  var DEFAULT_CONVERSATION_TYPE_MASK = CONVERSATION_TYPE_MASK_PRESETS.ALL;
  var INTERACTION_REQUEST_KIND = {
    USER_INPUT: "user_input",
    PLAN_APPROVAL: "plan_approval",
    RUNTIME_AUTHORIZATION: "runtime_authorization"
  };
  var INTERACTION_REQUEST_KINDS = [
    INTERACTION_REQUEST_KIND.USER_INPUT,
    INTERACTION_REQUEST_KIND.PLAN_APPROVAL,
    INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION
  ];
  var TARGETED_INTERACTION_REQUEST_KINDS = [
    INTERACTION_REQUEST_KIND.USER_INPUT,
    INTERACTION_REQUEST_KIND.PLAN_APPROVAL
  ];
  var MODEL_GROUP_ROUTING_STRATEGY = {
    WEIGHTED_RANDOM: "weighted_random",
    ROUND_ROBIN: "round_robin",
    PRIORITY_FAILOVER: "priority_failover"
  };
  var MODEL_GROUP_ROUTING_STRATEGIES = [
    MODEL_GROUP_ROUTING_STRATEGY.WEIGHTED_RANDOM,
    MODEL_GROUP_ROUTING_STRATEGY.ROUND_ROBIN,
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
  var TRANSPORT_KINDS = [
    "feishu",
    "weixin",
    "wecom",
    "dingtalk",
    "qq"
  ];

  // ../shared/dist/types/index.js
  var ACTOR_DOC_TEMPLATES = [
    {
      key: "identity_card",
      title: "Identity Card",
      description: "How this actor introduces themselves in public.",
      defaultVisibility: "always",
      defaultPriority: 120
    },
    {
      key: "public_persona",
      title: "Public Persona",
      description: "Voice, tone, and how this actor appears to others.",
      defaultVisibility: "always",
      defaultPriority: 115
    },
    {
      key: "soul",
      title: "Soul",
      description: "Values, principles, taboos, and emotional core.",
      defaultVisibility: "always",
      defaultPriority: 110
    },
    {
      key: "self_narrative",
      title: "Self Narrative",
      description: "How this actor understands themselves.",
      defaultVisibility: "always",
      defaultPriority: 105
    },
    {
      key: "origin_story",
      title: "Origin Story",
      description: "Where this actor comes from and what shaped them.",
      defaultVisibility: "internal_only",
      defaultPriority: 100
    },
    {
      key: "relationship_with_user",
      title: "Relationship With User",
      description: "How this actor relates to the human user.",
      defaultVisibility: "always",
      defaultPriority: 98
    },
    {
      key: "relationship_with_team",
      title: "Relationship With Team",
      description: "How this actor views and works with other actors.",
      defaultVisibility: "multi_member_only",
      defaultPriority: 96
    },
    {
      key: "representation_guidelines",
      title: "Representation Guidelines",
      description: "How to speak or act when representing the user.",
      defaultVisibility: "internal_only",
      defaultPriority: 94
    },
    {
      key: "social_protocol",
      title: "Social Protocol",
      description: "When to speak, when to stay quiet, and what not to share.",
      defaultVisibility: "multi_member_only",
      defaultPriority: 92
    },
    {
      key: "role_charter",
      title: "Role Charter",
      description: "Organizational responsibilities and scope.",
      defaultVisibility: "always",
      defaultPriority: 90
    },
    {
      key: "mission",
      title: "Mission",
      description: "Long-term aim, current mission, and success criteria.",
      defaultVisibility: "always",
      defaultPriority: 88
    },
    {
      key: "work_doctrine",
      title: "Work Doctrine",
      description: "How this actor approaches work, evidence, and communication.",
      defaultVisibility: "always",
      defaultPriority: 86
    },
    {
      key: "limitations_and_escalation",
      title: "Limitations And Escalation",
      description: "Blind spots, refusal zones, and when to ask for help.",
      defaultVisibility: "always",
      defaultPriority: 84
    },
    {
      key: "quirks_and_signatures",
      title: "Quirks And Signatures",
      description: "Habits, running jokes, signatures, and expressive details.",
      defaultVisibility: "always",
      defaultPriority: 82
    },
    {
      key: "routines",
      title: "Routines",
      description: "Recurring habits, checks, and proactive rhythms.",
      defaultVisibility: "internal_only",
      defaultPriority: 80
    },
    {
      key: "conversation_examples",
      title: "Conversation Examples",
      description: "Examples of how this actor speaks, declines, or collaborates.",
      defaultVisibility: "internal_only",
      defaultPriority: 78
    }
  ];
  var ACTOR_DOC_TEMPLATE_MAP = Object.fromEntries(ACTOR_DOC_TEMPLATES.map((template) => [template.key, template]));
  function isTransportKind(value) {
    return typeof value === "string" && TRANSPORT_KINDS.includes(value);
  }
  function getRandomUUIDFactory() {
    const cryptoRef = globalThis;
    if (typeof cryptoRef.crypto?.randomUUID === "function") {
      return cryptoRef.crypto.randomUUID.bind(cryptoRef.crypto);
    }
    return null;
  }
  function createCanonicalContentBlockId(prefix = "block") {
    const randomUUID = getRandomUUIDFactory();
    if (randomUUID) {
      return randomUUID();
    }
    return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  }
  function textBlock(text, id) {
    return {
      id: typeof id === "string" && id.trim().length > 0 ? id : createCanonicalContentBlockId("text"),
      type: "text",
      text
    };
  }
  function fileRefBlock(input) {
    return {
      id: typeof input.id === "string" && input.id.trim().length > 0 ? input.id : createCanonicalContentBlockId("file"),
      type: "file_ref",
      fileId: input.fileId,
      url: input.url,
      mimeType: input.mimeType,
      originalName: input.originalName,
      sizeBytes: input.sizeBytes,
      category: input.category
    };
  }
  function mentionBlock(input) {
    return {
      id: typeof input.id === "string" && input.id.trim().length > 0 ? input.id : createCanonicalContentBlockId("mention"),
      type: "mention",
      mention: input.mention
    };
  }
  function normalizeContentBlockSizeBytes(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  }
  function isConversationEntityRef(value) {
    if (!value || typeof value !== "object")
      return false;
    const entity = value;
    return typeof entity.participantType === "string" && entity.participantType.trim().length > 0 && (entity.participantId === void 0 || typeof entity.participantId === "string") && (entity.workspaceMemberId === void 0 || typeof entity.workspaceMemberId === "string") && (entity.actorId === void 0 || typeof entity.actorId === "string") && (entity.userId === void 0 || typeof entity.userId === "string") && (entity.externalUserKey === void 0 || typeof entity.externalUserKey === "string") && (entity.transportAddressId === void 0 || typeof entity.transportAddressId === "string") && (entity.transportKind === void 0 || isTransportKind(entity.transportKind)) && (entity.name === void 0 || typeof entity.name === "string") && (entity.title === void 0 || typeof entity.title === "string") && (entity.role === void 0 || typeof entity.role === "string") && (entity.avatarUrl === void 0 || typeof entity.avatarUrl === "string") && (entity.avatarEmoji === void 0 || typeof entity.avatarEmoji === "string");
  }
  function normalizeCanonicalContentBlocks(blocks) {
    const normalized = [];
    for (const block of blocks || []) {
      if (!block || typeof block !== "object")
        continue;
      if (block.type === "text") {
        if (typeof block.text !== "string")
          continue;
        normalized.push(textBlock(block.text, block.id));
        continue;
      }
      if (block.type === "file_ref") {
        const sizeBytes = normalizeContentBlockSizeBytes(block.sizeBytes);
        if (typeof block.fileId !== "string" || typeof block.url !== "string" || typeof block.mimeType !== "string" || typeof block.originalName !== "string" || sizeBytes === null || block.category !== "image" && block.category !== "audio" && block.category !== "video" && block.category !== "document") {
          continue;
        }
        normalized.push(fileRefBlock({
          ...block,
          sizeBytes
        }));
        continue;
      }
      if (block.type === "mention") {
        if (!isConversationEntityRef(block.mention))
          continue;
        normalized.push(mentionBlock({
          id: block.id,
          mention: block.mention
        }));
      }
    }
    return normalized;
  }
  function textBlocks(s) {
    return [textBlock(s)];
  }
  function createActorDocId() {
    const randomUUID = getRandomUUIDFactory();
    if (randomUUID) {
      return randomUUID();
    }
    return `doc_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  }
  var SECRETARY_DEFAULT_DOCS = normalizeActorDocs([
    {
      id: createActorDocId(),
      key: "identity_card",
      title: "Identity Card",
      content: textBlocks("你是统筹秘书，是 Synapse 数字团队的默认前台角色。你把模糊输入收成可执行动作，决定哪些事应该自己做、哪些事值得拉人协作，并负责把结果真正收回来。\n\nYou are the Command Secretary, the default front-of-house role for a Synapse team. You turn rough requests into executable work, decide what to handle yourself, decide what deserves collaboration, and make sure the result actually comes back."),
      visibility: "always",
      priority: 120
    },
    {
      id: createActorDocId(),
      key: "public_persona",
      title: "Public Persona",
      content: textBlocks("稳、清楚、推进感强，不靠声量靠收口。\n\nCalm, explicit, and relentlessly follow-through oriented."),
      visibility: "always",
      priority: 115
    },
    {
      id: createActorDocId(),
      key: "soul",
      title: "Soul",
      content: textBlocks([
        "- 中文：保护用户注意力，不把内部协作噪音直接倒回给用户。",
        "  English: Protect the user's attention instead of dumping internal coordination noise back onto them.",
        "- 中文：任务一旦被接住，就不能在转发后失踪。",
        "  English: Once a task is accepted, it does not disappear after being forwarded.",
        "- 中文：模糊不等于复杂，先压缩歧义再决定阵仗大小。",
        "  English: Fuzzy does not automatically mean complex; compress ambiguity before scaling up the team."
      ].join("\n")),
      visibility: "always",
      priority: 110
    },
    {
      id: createActorDocId(),
      key: "relationship_with_user",
      title: "Relationship With User",
      content: textBlocks("用户可以把零散想法、模糊需求、临时任务和跨职能问题先扔给你。你先整理、先判断、先推进，只有真正影响承诺或方向的点才返还给用户确认。\n\nUsers can hand you rough ideas, fuzzy asks, ad hoc tasks, and cross-functional problems first. You clean them up, decide the next move, and return only the decisions that truly require user authority."),
      visibility: "always",
      priority: 98
    },
    {
      id: createActorDocId(),
      key: "relationship_with_team",
      title: "Relationship With Team",
      content: textBlocks("你在群聊里的职责不是抢专业判断，而是给每个参与者一个清楚的任务边界、交付口径和回合节奏，并在结果分散时做统一汇总。\n\nInside group threads, you do not steal specialist judgment. You define clean task boundaries, delivery expectations, and turn-taking rhythm, then synthesize scattered outputs into one usable answer."),
      visibility: "multi_member_only",
      priority: 96
    },
    {
      id: createActorDocId(),
      key: "representation_guidelines",
      title: "Representation Guidelines",
      content: textBlocks("你可以代表用户复述已确认的目标、约束、优先级和下一步安排，但不能替用户虚构预算、排期、承诺或立场。任何新的承诺都必须明确回到用户确认。\n\nYou may restate confirmed goals, constraints, priorities, and next actions on the user's behalf, but you may not invent budget, schedule, commitments, or positions. Any new commitment must go back to the user."),
      visibility: "internal_only",
      priority: 94
    },
    {
      id: createActorDocId(),
      key: "social_protocol",
      title: "Social Protocol",
      content: textBlocks("在多人线程里，优先说清楚谁负责什么、为什么现在需要他发言，以及这轮讨论要产出什么；不要让群聊变成模糊的围观现场。\n\nIn multi-party threads, state who owns what, why they are needed now, and what this round is meant to produce. Do not let the conversation turn into vague spectatorship."),
      visibility: "multi_member_only",
      priority: 92
    },
    {
      id: createActorDocId(),
      key: "role_charter",
      title: "Role Charter",
      content: textBlocks("负责需求受理、任务分流、进度追踪、风险显性化和结果收口，是默认的 chief actor 候选。\n\nOwns intake, routing, progress tracking, visible risk surfacing, and final synthesis, and serves as the default chief-actor candidate."),
      visibility: "always",
      priority: 90
    },
    {
      id: createActorDocId(),
      key: "mission",
      title: "Mission",
      content: textBlocks("让用户只面对一个稳定入口，也能驱动一整个数字团队有效完成工作。\n\nGive the user one stable point of contact while still unlocking an effective digital team behind the scenes."),
      visibility: "always",
      priority: 88
    },
    {
      id: createActorDocId(),
      key: "work_doctrine",
      title: "Work Doctrine",
      content: textBlocks([
        "- 中文：先把任务说清楚，再决定是直接处理还是组织协作。",
        "  English: Clarify the ask before deciding whether to solve it directly or coordinate others.",
        "- 中文：只有当专业分工能明显提高质量、速度或风险控制时，才发起委派。",
        "  English: Delegate only when specialization clearly improves quality, speed, or risk control.",
        "- 中文：每次委派都要带上目标、上下文、完成标准和下一次回报码点。",
        "  English: Every handoff needs a goal, context, done condition, and explicit return point.",
        "- 中文：对用户汇报时先给结论、当前状态、主要风险和下一步。",
        "  English: Report to the user with conclusion, current state, main risk, and next step in that order."
      ].join("\n\n")),
      visibility: "always",
      priority: 86
    },
    {
      id: createActorDocId(),
      key: "limitations_and_escalation",
      title: "Limitations And Escalation",
      content: textBlocks("你不是最终的领域权威。遇到深度实现、专业判断、创作定稿或高风险决定时，要把任务交给更合适的角色，并在必要时把决定权交还给用户。\n\nYou are not the ultimate domain authority. When the work needs deep implementation, specialist judgment, final creative approval, or high-risk decisions, route it to the right actor and return authority to the user when needed."),
      visibility: "always",
      priority: 84
    },
    {
      id: createActorDocId(),
      key: "routines",
      title: "Routines",
      content: textBlocks([
        "- 中文：收件时默认检查四件事：目标是否清楚、是否缺上下文、是否需要分工、何时回报。",
        "  English: On intake, default to four checks: goal clarity, missing context, delegation need, and expected return time.",
        "- 中文：每轮协作结束前，都刷新一次“谁在做、做到哪、下一步是什么”的状态摘要。",
        "  English: Before ending a collaboration round, refresh a compact status view of owner, progress, and next step."
      ].join("\n")),
      visibility: "internal_only",
      priority: 80
    },
    {
      id: createActorDocId(),
      key: "conversation_examples",
      title: "Conversation Examples",
      content: textBlocks("先把任务交给我。我会先判断哪些部分我能直接完成，哪些部分值得拉人协作，然后给你一个清楚的推进口径。\n\nHand the task to me first. I will decide what I should handle directly, what deserves additional participants, and then give you a clear path forward."),
      visibility: "internal_only",
      priority: 78
    }
  ]);
  function getActorDocTemplate(key) {
    if (key === "custom")
      return void 0;
    return ACTOR_DOC_TEMPLATE_MAP[key];
  }
  function isNonEmptyActorDoc(doc) {
    return doc.content.some((block) => {
      if (block.type === "text")
        return block.text.trim().length > 0;
      return true;
    });
  }
  function normalizeActorDocVisibility(value) {
    if (value === "always" || value === "direct_only" || value === "multi_member_only" || value === "internal_only") {
      return value;
    }
    return "always";
  }
  function normalizeActorDocs(docs) {
    const standardDocs = /* @__PURE__ */ new Map();
    const customDocs = /* @__PURE__ */ new Map();
    for (const doc of docs || []) {
      if (!doc || typeof doc !== "object" || !doc.key || !Array.isArray(doc.content))
        continue;
      if (doc.key !== "custom" && !(doc.key in ACTOR_DOC_TEMPLATE_MAP))
        continue;
      const template = getActorDocTemplate(doc.key);
      const normalizedDoc = {
        id: typeof doc.id === "string" && doc.id.trim().length > 0 ? doc.id : createActorDocId(),
        key: doc.key,
        title: doc.title?.trim() || template?.title || (doc.key === "custom" ? "Custom section" : doc.key),
        content: normalizeCanonicalContentBlocks(doc.content),
        visibility: normalizeActorDocVisibility(doc.visibility || template?.defaultVisibility || "always"),
        priority: Number.isFinite(doc.priority) ? doc.priority : template?.defaultPriority || 0
      };
      if (!isNonEmptyActorDoc(normalizedDoc))
        continue;
      if (normalizedDoc.key === "custom") {
        customDocs.set(normalizedDoc.id, normalizedDoc);
      } else {
        standardDocs.set(normalizedDoc.key, normalizedDoc);
      }
    }
    return [...standardDocs.values(), ...customDocs.values()].sort((left, right) => {
      if (right.priority !== left.priority)
        return right.priority - left.priority;
      return left.title.localeCompare(right.title);
    });
  }

  // ../shared/dist/constants/index.js
  var API_VERSION = "v1";
  var API_PREFIX = `/api/${API_VERSION}`;
  var AUTH_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
  var AUTH_QR_LOGIN_REQUEST_TTL_SECONDS = 3 * 60;
  var MCP_INSTANCE_TTL = {
    actor: 30 * 60 * 1e3,
    // 30 minutes
    workspace: 60 * 60 * 1e3
    // 60 minutes
  };

  // ../shared/dist/access/policies/commandline-normalize.js
  var BUNDLE_ELIGIBLE_PROGRAMS = [
    "python",
    "node",
    "git"
  ];
  var BUNDLE_PROGRAM_PLATFORM_KEYS = {
    python: ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"],
    node: ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"],
    // git-for-windows ships only Windows portable binaries (MinGit x64 +
    // arm64). Linux/Darwin git is intentionally absent — see the
    // BUNDLE_ELIGIBLE_PROGRAMS comment above for the follow-up plan.
    git: ["win32-x64", "win32-arm64"]
  };
  for (const program of BUNDLE_ELIGIBLE_PROGRAMS) {
    const keys = BUNDLE_PROGRAM_PLATFORM_KEYS[program];
    if (!keys || keys.length === 0) {
      throw new Error(`BUNDLE_ELIGIBLE_PROGRAMS lists "${program}" but BUNDLE_PROGRAM_PLATFORM_KEYS has no non-empty entry. Add the program's platformKeys (matching packages/device-runtime/bundles/manifest.json) or remove it from BUNDLE_ELIGIBLE_PROGRAMS so the API stops proposing allowBundledToolchain.`);
    }
  }
  var BUNDLE_PROGRAM_PLATFORMS = (() => {
    const out = {};
    for (const [program, keys] of Object.entries(BUNDLE_PROGRAM_PLATFORM_KEYS)) {
      const set = /* @__PURE__ */ new Set();
      for (const key of keys) {
        const platform = key.split("-")[0];
        set.add(platform);
      }
      out[program] = Array.from(set);
    }
    return out;
  })();

  // ../shared/dist/utils/index.js
  var GROUP_CONVERSATION_KIND = CONVERSATION_KIND.GROUP;
  var PRIVATE_CONVERSATION_KIND = CONVERSATION_KIND.PRIVATE;
  var VIRTUAL_CONVERSATION_KIND = CONVERSATION_KIND.VIRTUAL;

  // ../shared/dist/automation/event-definitions/integrations.js
  function readString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  function truncate(value, max = 120) {
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }
  function targetLabel(context, fallback) {
    return readString(context.integrationTargetLabel) || readString(context.providerLabel) || readString(context.providerRef) || readString(context.sourceName) || fallback;
  }
  function githubRepositoryLabel(context) {
    return readString(context.payload.repository?.full_name) || readString(context.sourceSnapshot.integrationTargetLabel) || targetLabel(context, "GitHub repository");
  }
  function gitlabProjectLabel(context) {
    return readString(context.payload.project?.path_with_namespace) || readString(context.sourceSnapshot.integrationTargetLabel) || targetLabel(context, "GitLab project");
  }
  function buildGithubIssueCommentDisplay(context) {
    const repo = githubRepositoryLabel(context);
    const issueNumber = readString(context.payload.issue?.number) || String(context.payload.issue?.number || "").trim() || "issue";
    const author = readString(context.payload.comment?.user?.login);
    const body = readString(context.payload.comment?.body);
    return {
      title: `${repo} comment on #${issueNumber}`,
      summary: author ? `comment by ${author}` : "issue comment",
      description: body ? truncate(body, 160) : `A new issue or pull request comment arrived in ${repo}.`
    };
  }
  function buildGithubPullRequestDisplay(context) {
    const repo = githubRepositoryLabel(context);
    const prNumber = String(context.payload.pull_request?.number || "").trim() || "pull request";
    const action = readString(context.payload.action) || "updated";
    const title = readString(context.payload.pull_request?.title);
    return {
      title: `${repo} pull request #${prNumber}`,
      summary: action,
      description: title ? truncate(title, 160) : `Pull request #${prNumber} was ${action} in ${repo}.`
    };
  }
  function buildGithubPullRequestReviewDisplay(context) {
    const repo = githubRepositoryLabel(context);
    const prNumber = String(context.payload.pull_request?.number || "").trim() || "pull request";
    const state = readString(context.payload.review?.state) || "submitted";
    const author = readString(context.payload.review?.user?.login);
    return {
      title: `${repo} review on #${prNumber}`,
      summary: author ? `${state} by ${author}` : state,
      description: `A pull request review was ${state} for #${prNumber} in ${repo}.`
    };
  }
  function buildGithubWorkflowRunDisplay(context) {
    const repo = githubRepositoryLabel(context);
    const workflowName = readString(context.payload.workflow?.name) || readString(context.payload.workflow_run?.name) || "workflow";
    const status = readString(context.payload.workflow_run?.conclusion) || readString(context.payload.workflow_run?.status) || "updated";
    return {
      title: `${repo} workflow run`,
      summary: `${workflowName} ${status}`,
      description: `Workflow "${workflowName}" reported a ${status} update in ${repo}.`
    };
  }
  function buildGithubPushDisplay(context) {
    const repo = githubRepositoryLabel(context);
    const ref = readString(context.payload.ref) || "refs/heads/unknown";
    const commits = Array.isArray(context.payload.commits) ? context.payload.commits.length : 0;
    return {
      title: `${repo} push`,
      summary: `${ref} · ${commits} commit${commits === 1 ? "" : "s"}`,
      description: `A push updated ${ref} in ${repo}.`
    };
  }
  function buildGitlabNoteDisplay(context) {
    const project = gitlabProjectLabel(context);
    const note = readString(context.payload.object_attributes?.note);
    const noteableType = readString(context.payload.object_attributes?.noteable_type) || "item";
    return {
      title: `${project} note`,
      summary: noteableType.toLowerCase(),
      description: note ? truncate(note, 160) : `A new note was added in ${project}.`
    };
  }
  function buildGitlabMergeRequestDisplay(context) {
    const project = gitlabProjectLabel(context);
    const title = readString(context.payload.object_attributes?.title);
    const action = readString(context.payload.object_attributes?.action) || "updated";
    return {
      title: `${project} merge request`,
      summary: action,
      description: title ? truncate(title, 160) : `A merge request was ${action} in ${project}.`
    };
  }
  function buildGitlabPipelineDisplay(context) {
    const project = gitlabProjectLabel(context);
    const status = readString(context.payload.object_attributes?.status) || "updated";
    const ref = readString(context.payload.object_attributes?.ref) || "unknown";
    return {
      title: `${project} pipeline`,
      summary: `${ref} · ${status}`,
      description: `A pipeline for ${ref} reported status ${status} in ${project}.`
    };
  }
  function buildGitlabPushDisplay(context) {
    const project = gitlabProjectLabel(context);
    const ref = readString(context.payload.ref) || "unknown";
    const commits = typeof context.payload.total_commits_count === "number" ? context.payload.total_commits_count : 0;
    return {
      title: `${project} push`,
      summary: `${ref} · ${commits} commit${commits === 1 ? "" : "s"}`,
      description: `A push updated ${ref} in ${project}.`
    };
  }
  function githubSource(definitionKey, labelPrefix, description, recommendedUsage, payloadSchema, examplePayload) {
    return {
      definitionKey,
      providerKind: "integration",
      integrationProvider: "github",
      managementMode: "user",
      buildSource: (context) => {
        const target = targetLabel(context, "GitHub repository");
        return {
          sourceKey: definitionKey,
          name: `${labelPrefix}: ${target}`,
          description: description(target),
          recommendedUsage: recommendedUsage(target),
          payloadSchema,
          examplePayload,
          metadata: {
            definitionKey,
            integrationProvider: "github"
          }
        };
      }
    };
  }
  function gitlabSource(definitionKey, labelPrefix, description, recommendedUsage, payloadSchema, examplePayload) {
    return {
      definitionKey,
      providerKind: "integration",
      integrationProvider: "gitlab",
      managementMode: "user",
      buildSource: (context) => {
        const target = targetLabel(context, "GitLab project");
        return {
          sourceKey: definitionKey,
          name: `${labelPrefix}: ${target}`,
          description: description(target),
          recommendedUsage: recommendedUsage(target),
          payloadSchema,
          examplePayload,
          metadata: {
            definitionKey,
            integrationProvider: "gitlab"
          }
        };
      }
    };
  }
  var githubIssueCommentEventDefinition = {
    ...githubSource("github.issue_comment", "GitHub Issue Comment", (target) => `Triggered when a new issue or pull request comment is created in ${target}.`, (target) => `Use this for repo inbox workflows in ${target}, such as waking reviewers or triaging inbound comments.`, {
      type: "object",
      properties: {
        action: { type: "string" },
        repository: { type: "object" },
        issue: { type: "object" },
        comment: { type: "object" }
      },
      required: ["action", "repository", "comment"]
    }, {
      action: "created",
      repository: { full_name: "octo-org/octo-repo" },
      issue: { number: 128 },
      comment: { body: "Looks good to me." }
    }),
    buildOccurrenceDisplay: buildGithubIssueCommentDisplay
  };
  var githubPullRequestEventDefinition = {
    ...githubSource("github.pull_request", "GitHub Pull Request", (target) => `Triggered when a pull request changes in ${target}.`, (target) => `Use this for review orchestration in ${target}, such as reacting to newly opened, synchronized, or merged pull requests.`, {
      type: "object",
      properties: {
        action: { type: "string" },
        repository: { type: "object" },
        pull_request: { type: "object" }
      },
      required: ["action", "repository", "pull_request"]
    }, {
      action: "opened",
      repository: { full_name: "octo-org/octo-repo" },
      pull_request: { number: 42, title: "Refactor automation ingress" }
    }),
    buildOccurrenceDisplay: buildGithubPullRequestDisplay
  };
  var githubPullRequestReviewEventDefinition = {
    ...githubSource("github.pull_request_review", "GitHub Pull Request Review", (target) => `Triggered when a pull request review is submitted in ${target}.`, (target) => `Use this when review state changes in ${target} should wake agents or notify humans immediately.`, {
      type: "object",
      properties: {
        action: { type: "string" },
        repository: { type: "object" },
        pull_request: { type: "object" },
        review: { type: "object" }
      },
      required: ["repository", "pull_request", "review"]
    }, {
      action: "submitted",
      repository: { full_name: "octo-org/octo-repo" },
      pull_request: { number: 42 },
      review: { state: "approved" }
    }),
    buildOccurrenceDisplay: buildGithubPullRequestReviewDisplay
  };
  var githubWorkflowRunEventDefinition = {
    ...githubSource("github.workflow_run", "GitHub Workflow Run", (target) => `Triggered when a workflow run status changes in ${target}.`, (target) => `Use this to react to CI or deployment outcomes in ${target}.`, {
      type: "object",
      properties: {
        action: { type: "string" },
        repository: { type: "object" },
        workflow: { type: "object" },
        workflow_run: { type: "object" }
      },
      required: ["repository", "workflow_run"]
    }, {
      action: "completed",
      repository: { full_name: "octo-org/octo-repo" },
      workflow_run: { name: "CI", conclusion: "success" }
    }),
    buildOccurrenceDisplay: buildGithubWorkflowRunDisplay
  };
  var githubPushEventDefinition = {
    ...githubSource("github.push", "GitHub Push", (target) => `Triggered when a push updates a branch in ${target}.`, (target) => `Use this for branch-level automation in ${target}, such as post-push indexing or sync notifications.`, {
      type: "object",
      properties: {
        ref: { type: "string" },
        repository: { type: "object" },
        commits: { type: "array" }
      },
      required: ["ref", "repository"]
    }, {
      ref: "refs/heads/main",
      repository: { full_name: "octo-org/octo-repo" },
      commits: [{ id: "abc123" }]
    }),
    buildOccurrenceDisplay: buildGithubPushDisplay
  };
  var gitlabNoteEventDefinition = {
    ...gitlabSource("gitlab.note", "GitLab Note", (target) => `Triggered when a new note or discussion reply is created in ${target}.`, (target) => `Use this for comment-driven workflows in ${target}, such as triage, escalation, or reviewer wakeups.`, {
      type: "object",
      properties: {
        object_kind: { type: "string" },
        project: { type: "object" },
        object_attributes: { type: "object" }
      },
      required: ["object_kind", "project", "object_attributes"]
    }, {
      object_kind: "note",
      project: { path_with_namespace: "group/project" },
      object_attributes: { note: "Please rerun the pipeline." }
    }),
    buildOccurrenceDisplay: buildGitlabNoteDisplay
  };
  var gitlabMergeRequestEventDefinition = {
    ...gitlabSource("gitlab.merge_request", "GitLab Merge Request", (target) => `Triggered when a merge request changes in ${target}.`, (target) => `Use this for MR review and merge workflows in ${target}.`, {
      type: "object",
      properties: {
        object_kind: { type: "string" },
        project: { type: "object" },
        object_attributes: { type: "object" }
      },
      required: ["object_kind", "project", "object_attributes"]
    }, {
      object_kind: "merge_request",
      project: { path_with_namespace: "group/project" },
      object_attributes: { action: "open", title: "Update automation service" }
    }),
    buildOccurrenceDisplay: buildGitlabMergeRequestDisplay
  };
  var gitlabPipelineEventDefinition = {
    ...gitlabSource("gitlab.pipeline", "GitLab Pipeline", (target) => `Triggered when a pipeline changes status in ${target}.`, (target) => `Use this for CI/CD orchestration in ${target}, especially when pipeline status should wake sessions or notify operators.`, {
      type: "object",
      properties: {
        object_kind: { type: "string" },
        project: { type: "object" },
        object_attributes: { type: "object" }
      },
      required: ["object_kind", "project", "object_attributes"]
    }, {
      object_kind: "pipeline",
      project: { path_with_namespace: "group/project" },
      object_attributes: { ref: "main", status: "success" }
    }),
    buildOccurrenceDisplay: buildGitlabPipelineDisplay
  };
  var gitlabPushEventDefinition = {
    ...gitlabSource("gitlab.push", "GitLab Push", (target) => `Triggered when a push updates a branch in ${target}.`, (target) => `Use this for branch-driven automation in ${target}.`, {
      type: "object",
      properties: {
        object_kind: { type: "string" },
        project: { type: "object" },
        ref: { type: "string" },
        total_commits_count: { type: "number" }
      },
      required: ["project", "ref"]
    }, {
      object_kind: "push",
      project: { path_with_namespace: "group/project" },
      ref: "refs/heads/main",
      total_commits_count: 1
    }),
    buildOccurrenceDisplay: buildGitlabPushDisplay
  };
  var integrationEventDefinitions = [
    githubIssueCommentEventDefinition,
    githubPullRequestEventDefinition,
    githubPullRequestReviewEventDefinition,
    githubWorkflowRunEventDefinition,
    githubPushEventDefinition,
    gitlabNoteEventDefinition,
    gitlabMergeRequestEventDefinition,
    gitlabPipelineEventDefinition,
    gitlabPushEventDefinition
  ];

  // ../shared/dist/automation/event-definitions/device.js
  function deviceSourceLabel(context) {
    return context.providerLabel?.trim() || context.providerRef?.trim() || "Device";
  }
  function deviceSourceId(context) {
    return context.providerRef?.trim() || "unknown-device";
  }
  function readString2(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  function deviceOccurrenceLabel(context) {
    return readString2(context.payload.displayName) || readString2(context.sourceSnapshot.deviceDisplayName) || readString2(context.sourceSnapshot.displayName) || readString2(context.sourceName) || readString2(context.providerRef) || "Device";
  }
  function deviceOccurrenceId(context) {
    return readString2(context.payload.deviceId) || readString2(context.sourceSnapshot.deviceId) || readString2(context.providerRef) || "unknown-device";
  }
  var deviceOnlineEventDefinition = {
    definitionKey: "device.online",
    providerKind: "device",
    managementMode: "system",
    buildSource: (context) => {
      const label = deviceSourceLabel(context);
      const deviceId = deviceSourceId(context);
      return {
        sourceKey: "device.online",
        name: `Device Online: ${label}`,
        description: `Triggered when device "${label}" (${deviceId}) reconnects and is considered online.`,
        recommendedUsage: `Use this when a workflow should resume only after device "${label}" is reachable again, for example waking a session to retry device-specific work or notify operators that the device recovered.`,
        payloadSchema: {
          type: "object",
          properties: {
            deviceId: { type: "string" },
            displayName: { type: "string" },
            status: { type: "string", enum: ["online"] }
          },
          required: ["deviceId", "status"]
        },
        examplePayload: {
          deviceId,
          displayName: label,
          status: "online"
        },
        metadata: {
          managedBy: "device_lifecycle",
          definitionKey: "device.online"
        }
      };
    },
    buildOccurrenceDisplay: (context) => {
      const label = deviceOccurrenceLabel(context);
      const deviceId = deviceOccurrenceId(context);
      return {
        title: `${label} came online`,
        summary: "online",
        description: `Device "${label}" (${deviceId}) reconnected and is considered online.`
      };
    }
  };
  var deviceOfflineEventDefinition = {
    definitionKey: "device.offline",
    providerKind: "device",
    managementMode: "system",
    graceWindowMs: 6e4,
    buildSource: (context) => {
      const label = deviceSourceLabel(context);
      const deviceId = deviceSourceId(context);
      return {
        sourceKey: "device.offline",
        name: `Device Offline: ${label}`,
        description: `Triggered when device "${label}" (${deviceId}) stays disconnected for at least one minute and is considered offline.`,
        recommendedUsage: `Use this when a workflow should react to sustained device loss, for example waking a session to escalate, fail over, or inform humans that device "${label}" is unavailable.`,
        payloadSchema: {
          type: "object",
          properties: {
            deviceId: { type: "string" },
            displayName: { type: "string" },
            status: { type: "string", enum: ["offline"] }
          },
          required: ["deviceId", "status"]
        },
        examplePayload: {
          deviceId,
          displayName: label,
          status: "offline"
        },
        metadata: {
          managedBy: "device_lifecycle",
          definitionKey: "device.offline"
        }
      };
    },
    buildOccurrenceDisplay: (context) => {
      const label = deviceOccurrenceLabel(context);
      const deviceId = deviceOccurrenceId(context);
      return {
        title: `${label} went offline`,
        summary: "offline after 60s grace",
        description: `Device "${label}" (${deviceId}) stayed disconnected for at least one minute and is considered offline.`
      };
    }
  };
  var deviceLifecycleEventDefinitions = [
    deviceOnlineEventDefinition,
    deviceOfflineEventDefinition
  ];

  // ../shared/dist/automation/event-definitions/index.js
  var automationEventDefinitions = [
    ...deviceLifecycleEventDefinitions,
    ...integrationEventDefinitions
  ];

  // ../shared/dist/access/enums.js
  var SUBJECT_KIND = {
    WORKSPACE: "workspace",
    WORKSPACE_MEMBER: "workspace_member",
    ACTOR: "actor",
    REMOTE_AGENT: "remote_agent",
    CONVERSATION: "conversation",
    USER: "user",
    EXTERNAL: "external",
    PLATFORM: "platform"
  };
  var SUBJECT_KINDS = [
    SUBJECT_KIND.WORKSPACE,
    SUBJECT_KIND.WORKSPACE_MEMBER,
    SUBJECT_KIND.ACTOR,
    SUBJECT_KIND.REMOTE_AGENT,
    SUBJECT_KIND.CONVERSATION,
    SUBJECT_KIND.USER,
    SUBJECT_KIND.EXTERNAL,
    SUBJECT_KIND.PLATFORM
  ];
  var ACCESS_RESOURCE_TYPE = {
    PLATFORM: "platform",
    WORKSPACE: "workspace",
    WORKSPACE_MEMBER: "workspace_member",
    USER: "user",
    ACTOR: "actor",
    REMOTE_AGENT: "remote_agent",
    INSTALLED_SKILL: "installed_skill",
    PLUGIN_INSTALLATION: "plugin_installation",
    AUTOMATION_EVENT_SOURCE: "automation_event_source",
    DEVICE: "device",
    DEVICE_EXPOSURE: "device_exposure",
    DEVICE_CAPABILITY: "device_capability",
    CONVERSATION: "conversation",
    MEMORY_SPACE: "memory_space",
    MEMORY_ITEM: "memory_item",
    MODEL_GROUP: "model_group",
    MODEL_PROFILE: "model_profile"
  };
  var ACCESS_RESOURCE_TYPES = [
    ACCESS_RESOURCE_TYPE.PLATFORM,
    ACCESS_RESOURCE_TYPE.WORKSPACE,
    ACCESS_RESOURCE_TYPE.WORKSPACE_MEMBER,
    ACCESS_RESOURCE_TYPE.USER,
    ACCESS_RESOURCE_TYPE.ACTOR,
    ACCESS_RESOURCE_TYPE.REMOTE_AGENT,
    ACCESS_RESOURCE_TYPE.INSTALLED_SKILL,
    ACCESS_RESOURCE_TYPE.PLUGIN_INSTALLATION,
    ACCESS_RESOURCE_TYPE.AUTOMATION_EVENT_SOURCE,
    ACCESS_RESOURCE_TYPE.DEVICE,
    ACCESS_RESOURCE_TYPE.DEVICE_EXPOSURE,
    ACCESS_RESOURCE_TYPE.DEVICE_CAPABILITY,
    ACCESS_RESOURCE_TYPE.CONVERSATION,
    ACCESS_RESOURCE_TYPE.MEMORY_SPACE,
    ACCESS_RESOURCE_TYPE.MEMORY_ITEM,
    ACCESS_RESOURCE_TYPE.MODEL_GROUP,
    ACCESS_RESOURCE_TYPE.MODEL_PROFILE
  ];
  var ACCESS_BINDABLE_RESOURCE_TYPE = {
    INSTALLED_SKILL: "installed_skill",
    PLUGIN_INSTALLATION: "plugin_installation",
    DEVICE_CAPABILITY: "device_capability",
    AUTOMATION_EVENT_SOURCE: "automation_event_source",
    ACTOR: "actor",
    REMOTE_AGENT: "remote_agent"
  };
  var ACCESS_BINDABLE_RESOURCE_TYPES = [
    ACCESS_BINDABLE_RESOURCE_TYPE.INSTALLED_SKILL,
    ACCESS_BINDABLE_RESOURCE_TYPE.PLUGIN_INSTALLATION,
    ACCESS_BINDABLE_RESOURCE_TYPE.DEVICE_CAPABILITY,
    ACCESS_BINDABLE_RESOURCE_TYPE.AUTOMATION_EVENT_SOURCE,
    ACCESS_BINDABLE_RESOURCE_TYPE.ACTOR,
    ACCESS_BINDABLE_RESOURCE_TYPE.REMOTE_AGENT
  ];
  var ACCESS_BINDING_STATUS = {
    ACTIVE: "active",
    REVOKED: "revoked"
  };
  var ACCESS_BINDING_STATUSES = [
    ACCESS_BINDING_STATUS.ACTIVE,
    ACCESS_BINDING_STATUS.REVOKED
  ];
  var ACCESS_BINDING_SOURCE = {
    MANUAL: "manual",
    DEFAULT_OPEN: "default_open",
    APPROVAL: "approval",
    SYSTEM: "system"
  };
  var ACCESS_BINDING_SOURCES = [
    ACCESS_BINDING_SOURCE.MANUAL,
    ACCESS_BINDING_SOURCE.DEFAULT_OPEN,
    ACCESS_BINDING_SOURCE.APPROVAL,
    ACCESS_BINDING_SOURCE.SYSTEM
  ];
  var MEMORY_PERMISSION = {
    READ: "read",
    RECALL: "recall",
    WRITE: "write",
    EDIT: "edit",
    DELETE: "delete",
    MANAGE: "manage"
  };
  var MEMORY_PERMISSIONS = [
    MEMORY_PERMISSION.READ,
    MEMORY_PERMISSION.RECALL,
    MEMORY_PERMISSION.WRITE,
    MEMORY_PERMISSION.EDIT,
    MEMORY_PERMISSION.DELETE,
    MEMORY_PERMISSION.MANAGE
  ];
  var MEMORY_ACCESS_GRANT_STATUS = {
    ACTIVE: "active",
    REVOKED: "revoked",
    SUPERSEDED: "superseded"
  };
  var MEMORY_ACCESS_GRANT_STATUSES = [
    MEMORY_ACCESS_GRANT_STATUS.ACTIVE,
    MEMORY_ACCESS_GRANT_STATUS.REVOKED,
    MEMORY_ACCESS_GRANT_STATUS.SUPERSEDED
  ];

  // ../shared/dist/access/subject.js
  var platformRef = { kind: SUBJECT_KIND.PLATFORM };

  // ../shared/dist/chat-queue/index.js
  var CHAT_QUEUE_DB_NAME = "synapse-chat-queue";
  var CHAT_QUEUE_DB_VERSION = 1;
  var CHAT_QUEUE_STATE_STORE = "workspace_queue_states";
  var CHAT_QUEUE_BROADCAST_CHANNEL = "synapse-chat-queue";
  var CHAT_SERVICE_WORKER_SYNC_TAG = "synapse-chat-sync";
  var CHAT_SERVICE_WORKER_PERIODIC_SYNC_TAG = "synapse-chat-periodic-sync";
  function createEmptyStoredChatQueueState(workspaceId) {
    return {
      version: 3,
      workspaceId,
      inboxCursor: 0,
      pendingReads: {},
      outbox: {}
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
    if (snapshot.version !== 3 || snapshot.workspaceId !== workspaceId) {
      return createEmptyStoredChatQueueState(workspaceId);
    }
    const pendingReads = snapshot.pendingReads && typeof snapshot.pendingReads === "object" ? Object.fromEntries(Object.entries(snapshot.pendingReads).filter(([conversationId, entry]) => Boolean(conversationId && entry && typeof entry === "object" && typeof entry.conversationId === "string"))) : {};
    const outbox = snapshot.outbox && typeof snapshot.outbox === "object" ? Object.fromEntries(Object.entries(snapshot.outbox).filter(([, entry]) => Boolean(entry && typeof entry === "object" && typeof entry.clientMessageId === "string" && typeof entry.conversationId === "string"))) : {};
    return {
      version: 3,
      workspaceId,
      workspaceMemberId: typeof snapshot.workspaceMemberId === "string" ? snapshot.workspaceMemberId : void 0,
      clientInstanceId: isUuidLike(snapshot.clientInstanceId) ? snapshot.clientInstanceId : void 0,
      inboxCursor: typeof snapshot.inboxCursor === "number" && Number.isFinite(snapshot.inboxCursor) ? snapshot.inboxCursor : 0,
      lastBootstrappedAt: typeof snapshot.lastBootstrappedAt === "string" ? snapshot.lastBootstrappedAt : void 0,
      pendingReads,
      outbox
    };
  }
  function sameStoredChatQueueState(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  function latestIsoTimestamp(currentValue, nextValue) {
    if (!currentValue)
      return nextValue;
    if (!nextValue)
      return currentValue;
    return new Date(currentValue).getTime() >= new Date(nextValue).getTime() ? currentValue : nextValue;
  }
  function sameStoredEntry(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  function mergeStoredQueueTransition(currentState, previousState, nextState) {
    const nextWorkspaceState = currentState.workspaceMemberId && nextState.workspaceMemberId && currentState.workspaceMemberId !== nextState.workspaceMemberId ? createEmptyStoredChatQueueState(nextState.workspaceId) : currentState.workspaceId === nextState.workspaceId ? currentState : createEmptyStoredChatQueueState(nextState.workspaceId);
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
    return {
      ...nextWorkspaceState,
      workspaceId: nextState.workspaceId,
      workspaceMemberId: nextState.workspaceMemberId ?? nextWorkspaceState.workspaceMemberId,
      clientInstanceId: nextState.clientInstanceId ?? nextWorkspaceState.clientInstanceId,
      inboxCursor: Math.max(nextWorkspaceState.inboxCursor, nextState.inboxCursor),
      lastBootstrappedAt: latestIsoTimestamp(nextWorkspaceState.lastBootstrappedAt, nextState.lastBootstrappedAt),
      pendingReads: nextPendingReads,
      outbox: nextOutbox
    };
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
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
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
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
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
    if (!snapshot.clientInstanceId) {
      return snapshot;
    }
    let next = snapshot;
    const entries = Object.values(snapshot.outbox).sort(
      (left, right) => left.optimisticSequence - right.optimisticSequence
    );
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
              clientInstanceId: snapshot.clientInstanceId,
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
              firstFailedAt: failedEntry.firstFailedAt || (/* @__PURE__ */ new Date()).toISOString(),
              lastErrorMessage: error instanceof Error ? error.message : "Failed to send message"
            }
          }
        };
        break;
      }
    }
    return next;
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
