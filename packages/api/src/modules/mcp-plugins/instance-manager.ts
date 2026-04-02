import { createHash, randomUUID } from "crypto";
import type { ToolDefinition } from "@synapse/shared";
import { redis } from "../../infrastructure/redis/index.js";
import { db } from "../../infrastructure/database/kysely.js";
import { McpHttpClient } from "./mcp-client.js";
import { McpStdioClient } from "./mcp-stdio-client.js";
import { getBuiltinHandler } from "./builtin/index.js";
import { logEvent } from "./audit.js";
import {
  callRelayTool,
  closeRelayRuntimeSession,
  getConnectedRelaySessionId,
  openRelayRuntimeSession,
} from "./relay-manager.js";
import {
  getRuntimeNodeId,
  initRuntimeControlPlane,
  registerRuntimeCommandHandler,
  sendRuntimeCommand,
  shutdownRuntimeControlPlane,
} from "./runtime-control-plane.js";
import { incrementMcpVersion } from "./runtime-version.js";

const RUNTIME_NODE_ID = getRuntimeNodeId();
const RUNTIME_LEASE_TTL_MS = 45_000;
const RUNTIME_LEASE_RENEW_INTERVAL_MS = 15_000;
const RUNTIME_REMOTE_COMMAND_TIMEOUT_MS = 30_000;

const MCP_INSTANCE_TTL_TURN = 5 * 60 * 1000;
const MCP_INSTANCE_TTL_SESSION = 1 * 60 * 60 * 1000;
const MCP_INSTANCE_TTL_ACTOR = 2 * 60 * 60 * 1000;
const MCP_INSTANCE_TTL_CONVERSATION = 1 * 60 * 60 * 1000;
const MCP_INSTANCE_TTL_WORKSPACE = 24 * 60 * 60 * 1000;

type InstanceTransport = "builtin" | "stdio" | "http" | "relay" | string;

type McpInstanceParams = {
  pluginId: string;
  installationId: string;
  pluginSlug: string;
  orgSlug: string;
  transport: InstanceTransport;
  entryPoint: string;
  scope: string;
  scopeId: string;
  config: Record<string, unknown>;
  workspaceId?: string;
  idleTtlMs?: number;
  maxAgeMs?: number;
};

type InstanceState = {
  kind: "local" | "proxy";
  params: McpInstanceParams;
  instance: McpInstance;
  configHash: string;
  baseShutdown?: () => Promise<void>;
  leaseToken?: string;
  leaseHeartbeatTimer?: NodeJS.Timeout;
};

type RuntimeLeaseMetadata = {
  nodeId: string;
  token: string;
  instanceKey: string;
  updatedAt: number;
};

type RemoteInstanceCommand =
  | {
      command: "execute";
      params: McpInstanceParams;
      key: string;
      configHash: string;
      toolName: string;
      input: Record<string, unknown>;
      executionContext?: McpExecutionContext;
    }
  | {
      command: "execute_with_binding";
      params: McpInstanceParams;
      key: string;
      configHash: string;
      toolName: string;
      input: Record<string, unknown>;
      binding: unknown;
      executionContext?: McpExecutionContext;
    }
  | {
      command: "ensure_runtime_session";
      params: McpInstanceParams;
      key: string;
      configHash: string;
    };

export interface McpExecutionContext {
  sessionId?: string;
  conversationId?: string;
  actorId?: string;
  userId?: string;
  workspaceMemberId?: string;
  turnId?: string;
  toolCallId?: string;
  providerCallId?: string;
  namespacedToolName?: string;
}

export interface McpInstance {
  pluginId: string;
  installationId: string;
  pluginSlug: string;
  orgSlug: string;
  transport: string;
  scope: string;
  scopeId: string;
  workspaceId?: string;
  configHash: string;
  tools: ToolDefinition[];
  execute: (
    toolName: string,
    input: Record<string, unknown>,
    executionContext?: McpExecutionContext,
  ) => Promise<unknown>;
  executeWithBinding?: (
    toolName: string,
    input: Record<string, unknown>,
    binding: unknown,
    executionContext?: McpExecutionContext,
  ) => Promise<unknown>;
  ensureRuntimeSession?: () => Promise<string>;
  getRuntimeSessionId?: () => string | undefined;
  shutdown: () => Promise<void>;
  lastUsed: number;
  createdAt: number;
  idleTtlMs: number;
  maxAgeMs?: number;
}

const instanceCache = new Map<string, McpInstance>();
const instanceStates = new Map<string, InstanceState>();
const ttlTimers = new Map<string, NodeJS.Timeout>();

function stableSerialize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => `${JSON.stringify(key)}:${stableSerialize(nestedValue)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function computeConfigHash(config: Record<string, unknown>): string {
  const json = stableSerialize(config);
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

function buildInstanceKey(
  installationId: string,
  configHash: string,
  scope: string,
  scopeId: string,
) {
  return `${installationId}:${configHash}:${scope}:${scopeId}`;
}

function runtimeLeaseKey(instanceKey: string) {
  return `mcp:runtime:lease:${instanceKey}`;
}

function runtimeLeaseMetaKey(instanceKey: string) {
  return `mcp:runtime:lease-meta:${instanceKey}`;
}

function getConfigValue(config: Record<string, unknown>, pathExpression: string): unknown {
  const pathParts = pathExpression.split(".").filter(Boolean);
  let current: unknown = config;
  for (const segment of pathParts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringifyTemplateValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function resolveTemplate(template: string, config: Record<string, unknown>): string {
  return template.replace(/\$\{([^}]+)\}/g, (_match, rawExpression: string) => {
    const expression = rawExpression.trim();
    if (expression.startsWith("env:")) {
      return process.env[expression.slice(4)] || "";
    }
    if (expression.startsWith("config:")) {
      return stringifyTemplateValue(getConfigValue(config, expression.slice(7)));
    }
    return "";
  });
}

function resolveHttpEntryPoint(
  entryPoint: string,
  config: Record<string, unknown>,
): { url: string; headers: Record<string, string> } {
  const trimmed = entryPoint.trim();
  if (!trimmed) {
    throw new Error("HTTP entry point is required");
  }

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const url =
      typeof parsed.url === "string"
        ? resolveTemplate(parsed.url, config)
        : typeof parsed.endpoint === "string"
          ? resolveTemplate(parsed.endpoint, config)
          : "";
    if (!url) {
      throw new Error("HTTP entry point JSON is missing url");
    }
    const headers =
      parsed.headers &&
      typeof parsed.headers === "object" &&
      !Array.isArray(parsed.headers)
        ? Object.fromEntries(
            Object.entries(parsed.headers as Record<string, unknown>)
              .filter(([, value]) => typeof value === "string")
              .map(([key, value]) => [key, resolveTemplate(value as string, config)]),
          )
        : {};
    return { url, headers };
  }

  return {
    url: resolveTemplate(trimmed, config),
    headers: {},
  };
}

function getTTLForScope(scope: string): number {
  switch (scope) {
    case "workspace":
      return MCP_INSTANCE_TTL_WORKSPACE;
    case "conversation":
      return MCP_INSTANCE_TTL_CONVERSATION;
    case "actor":
      return MCP_INSTANCE_TTL_ACTOR;
    case "session":
      return MCP_INSTANCE_TTL_SESSION;
    case "turn":
      return MCP_INSTANCE_TTL_TURN;
    default:
      return MCP_INSTANCE_TTL_CONVERSATION;
  }
}

function clearTTLTimer(key: string) {
  const timer = ttlTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    ttlTimers.delete(key);
  }
}

async function acquireRuntimeLease(instanceKey: string) {
  const token = `${RUNTIME_NODE_ID}:${randomUUID()}`;
  const metadata: RuntimeLeaseMetadata = {
    nodeId: RUNTIME_NODE_ID,
    token,
    instanceKey,
    updatedAt: Date.now(),
  };
  const result = await redis.eval(
    `if redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2], "NX") then
       redis.call("SET", KEYS[2], ARGV[3], "PX", ARGV[2])
       return 1
     else
       return 0
     end`,
    2,
    runtimeLeaseKey(instanceKey),
    runtimeLeaseMetaKey(instanceKey),
    token,
    String(RUNTIME_LEASE_TTL_MS),
    JSON.stringify(metadata),
  );
  return Number(result) === 1 ? token : null;
}

async function renewRuntimeLease(instanceKey: string, token: string) {
  const metadata: RuntimeLeaseMetadata = {
    nodeId: RUNTIME_NODE_ID,
    token,
    instanceKey,
    updatedAt: Date.now(),
  };
  const result = await redis.eval(
    `if redis.call("GET", KEYS[1]) == ARGV[1] then
       redis.call("PEXPIRE", KEYS[1], ARGV[2])
       redis.call("SET", KEYS[2], ARGV[3], "PX", ARGV[2])
       return 1
     else
       return 0
     end`,
    2,
    runtimeLeaseKey(instanceKey),
    runtimeLeaseMetaKey(instanceKey),
    token,
    String(RUNTIME_LEASE_TTL_MS),
    JSON.stringify(metadata),
  );
  return Number(result) === 1;
}

async function releaseRuntimeLease(instanceKey: string, token: string) {
  await redis.eval(
    `if redis.call("GET", KEYS[1]) == ARGV[1] then
       redis.call("DEL", KEYS[1])
       redis.call("DEL", KEYS[2])
       return 1
     else
       return 0
     end`,
    2,
    runtimeLeaseKey(instanceKey),
    runtimeLeaseMetaKey(instanceKey),
    token,
  );
}

async function readRuntimeLease(instanceKey: string): Promise<RuntimeLeaseMetadata | null> {
  const raw = await redis.get(runtimeLeaseMetaKey(instanceKey));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as RuntimeLeaseMetadata;
    if (!parsed.nodeId || !parsed.token) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function resetTTL(key: string, ttl: number) {
  clearTTLTimer(key);
  const timer = setTimeout(() => {
    void shutdownInstanceByKey(key, "ttl_expired");
  }, ttl);
  timer.unref?.();
  ttlTimers.set(key, timer);
}

function startLeaseHeartbeat(key: string, token: string) {
  const timer = setInterval(() => {
    void renewRuntimeLease(key, token).then((renewed) => {
      if (!renewed) {
        void shutdownInstanceByKey(key, "lease_lost");
      }
    }).catch(() => {
      void shutdownInstanceByKey(key, "lease_renew_failed");
    });
  }, RUNTIME_LEASE_RENEW_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

async function createBuiltinInstance(
  params: McpInstanceParams,
  configHash: string,
): Promise<McpInstance> {
  const handler = getBuiltinHandler(params.entryPoint);
  if (!handler) {
    throw new Error(`No builtin handler found for: ${params.entryPoint}`);
  }

  const tools = handler.getToolsFiltered
    ? handler.getToolsFiltered(params.config)
    : handler.getTools();

  return {
    pluginId: params.pluginId,
    installationId: params.installationId,
    pluginSlug: params.pluginSlug,
    orgSlug: params.orgSlug,
    transport: "builtin",
    scope: params.scope,
    scopeId: params.scopeId,
    workspaceId: params.workspaceId,
    configHash,
    tools,
    execute: async (toolName, input) => {
      const configWithScope = {
        ...params.config,
        workspace_id: params.workspaceId || params.scopeId,
      };
      return handler.execute(toolName, input, configWithScope);
    },
    shutdown: async () => {},
    lastUsed: Date.now(),
    createdAt: Date.now(),
    idleTtlMs: params.idleTtlMs ?? getTTLForScope(params.scope),
    maxAgeMs: params.maxAgeMs,
  };
}

async function createHttpInstance(
  params: McpInstanceParams,
  configHash: string,
): Promise<McpInstance> {
  const apiKey = params.config.apiKey as string;
  const resolvedEntryPoint = resolveHttpEntryPoint(params.entryPoint, params.config);
  const headers: Record<string, string> = {
    ...resolvedEntryPoint.headers,
  };
  if (apiKey) {
    headers.Authorization = headers.Authorization || `Bearer ${apiKey}`;
  }

  const client = new McpHttpClient(resolvedEntryPoint.url, headers);
  try {
    const initResult = await client.initialize();
    logEvent({
      workspaceId: params.workspaceId,
      pluginId: params.pluginId,
      eventType: "connection.init",
      eventData: {
        endpoint: resolvedEntryPoint.url,
        success: true,
        serverInfo: initResult.serverInfo,
      },
    });
  } catch (error: any) {
    logEvent({
      workspaceId: params.workspaceId,
      pluginId: params.pluginId,
      eventType: "connection.error",
      eventData: { endpoint: resolvedEntryPoint.url, error: error.message },
    });
    throw error;
  }

  let tools: ToolDefinition[];
  try {
    tools = await client.listTools();
  } catch {
    tools = [];
  }

  return {
    pluginId: params.pluginId,
    installationId: params.installationId,
    pluginSlug: params.pluginSlug,
    orgSlug: params.orgSlug,
    transport: "http",
    scope: params.scope,
    scopeId: params.scopeId,
    workspaceId: params.workspaceId,
    configHash,
    tools,
    execute: async (toolName, input) => client.callTool(toolName, input),
    shutdown: async () => {
      await client.shutdown();
    },
    lastUsed: Date.now(),
    createdAt: Date.now(),
    idleTtlMs: params.idleTtlMs ?? getTTLForScope(params.scope),
    maxAgeMs: params.maxAgeMs,
  };
}

async function createStdioInstance(
  params: McpInstanceParams,
  configHash: string,
  key: string,
): Promise<McpInstance> {
  const client = new McpStdioClient(params.entryPoint, params.config, key);

  try {
    const initResult = await client.initialize();
    logEvent({
      workspaceId: params.workspaceId,
      pluginId: params.pluginId,
      eventType: "connection.init",
      eventData: {
        endpoint: params.entryPoint,
        success: true,
        serverInfo: initResult.serverInfo,
        transport: "stdio",
      },
    });
  } catch (error: any) {
    logEvent({
      workspaceId: params.workspaceId,
      pluginId: params.pluginId,
      eventType: "connection.error",
      eventData: {
        endpoint: params.entryPoint,
        error: error.message,
        transport: "stdio",
      },
    });
    throw error;
  }

  let tools: ToolDefinition[];
  try {
    tools = await client.listTools();
  } catch {
    tools = [];
  }

  return {
    pluginId: params.pluginId,
    installationId: params.installationId,
    pluginSlug: params.pluginSlug,
    orgSlug: params.orgSlug,
    transport: "stdio",
    scope: params.scope,
    scopeId: params.scopeId,
    workspaceId: params.workspaceId,
    configHash,
    tools,
    execute: async (toolName, input) => client.callTool(toolName, input),
    shutdown: async () => {
      await client.shutdown();
    },
    lastUsed: Date.now(),
    createdAt: Date.now(),
    idleTtlMs: params.idleTtlMs ?? getTTLForScope(params.scope),
    maxAgeMs: params.maxAgeMs,
  };
}

async function createRelayInstance(
  params: McpInstanceParams,
  configHash: string,
): Promise<McpInstance> {
  const deviceId =
    typeof params.config.deviceId === "string" ? params.config.deviceId : "";
  const exposureId =
    typeof params.config.exposureId === "string" ? params.config.exposureId : "";
  const exposureStableKey =
    typeof params.config.exposureStableKey === "string"
      ? params.config.exposureStableKey
      : "";
  if (!deviceId || !exposureId || !exposureStableKey) {
    throw new Error("Relay instance config is missing device or exposure metadata");
  }

  let runtimeSessionId: string | undefined;
  let relaySessionId: string | null = null;

  const ensureRuntimeSession = async () => {
    const currentRelaySessionId = await getConnectedRelaySessionId(deviceId);
    if (!currentRelaySessionId) {
      runtimeSessionId = undefined;
      relaySessionId = null;
      throw new Error(`Relay device ${deviceId} is not connected`);
    }

    if (
      runtimeSessionId &&
      relaySessionId &&
      relaySessionId === currentRelaySessionId
    ) {
      return runtimeSessionId;
    }

    runtimeSessionId = await openRelayRuntimeSession({
      deviceId,
      exposureId,
      exposureStableKey,
    });
    relaySessionId = currentRelaySessionId;
    return runtimeSessionId;
  };

  const executeRelayCall = async (
    toolName: string,
    input: Record<string, unknown>,
    binding: unknown,
    executionContext?: McpExecutionContext,
  ) => {
    const nextRuntimeSessionId = await ensureRuntimeSession();
    return callRelayTool({
      conversationId: executionContext?.conversationId,
      sessionId: executionContext?.sessionId,
      requestedByWorkspaceMemberId: executionContext?.workspaceMemberId,
      requestedByActorId: executionContext?.actorId,
      deviceId,
      exposureId,
      visibleToolName: toolName,
      binding: binding as any,
      args: input,
      runtimeSessionId: nextRuntimeSessionId,
    });
  };

  return {
    pluginId: params.pluginId,
    installationId: params.installationId,
    pluginSlug: params.pluginSlug,
    orgSlug: params.orgSlug,
    transport: "relay",
    scope: params.scope,
    scopeId: params.scopeId,
    workspaceId: params.workspaceId,
    configHash,
    tools: [],
    execute: async (toolName, input, executionContext) =>
      executeRelayCall(toolName, input, params.config.binding || {}, executionContext),
    executeWithBinding: async (toolName, input, binding, executionContext) =>
      executeRelayCall(toolName, input, binding, executionContext),
    ensureRuntimeSession,
    getRuntimeSessionId: () => runtimeSessionId,
    shutdown: async () => {
      const activeRuntimeSessionId = runtimeSessionId;
      runtimeSessionId = undefined;
      relaySessionId = null;
      if (activeRuntimeSessionId) {
        await closeRelayRuntimeSession({
          deviceId,
          runtimeSessionId: activeRuntimeSessionId,
        }).catch(() => undefined);
      }
    },
    lastUsed: Date.now(),
    createdAt: Date.now(),
    idleTtlMs: params.idleTtlMs ?? getTTLForScope(params.scope),
    maxAgeMs: params.maxAgeMs,
  };
}

async function createTransportInstance(
  params: McpInstanceParams,
  key: string,
  configHash: string,
) {
  switch (params.transport) {
    case "builtin":
      return createBuiltinInstance(params, configHash);
    case "stdio":
      return createStdioInstance(params, configHash, key);
    case "http":
      return createHttpInstance(params, configHash);
    case "relay":
      return createRelayInstance(params, configHash);
    default:
      throw new Error(`Unsupported transport: ${params.transport}`);
  }
}

async function shutdownInstanceByKey(key: string, reason: string) {
  const state = instanceStates.get(key);
  if (!state) {
    clearTTLTimer(key);
    instanceCache.delete(key);
    return;
  }

  instanceStates.delete(key);
  instanceCache.delete(key);
  clearTTLTimer(key);

  if (state.leaseHeartbeatTimer) {
    clearInterval(state.leaseHeartbeatTimer);
  }

  try {
    await state.baseShutdown?.();
  } catch {
    // Ignore shutdown failures during cleanup.
  }

  if (state.leaseToken) {
    await releaseRuntimeLease(key, state.leaseToken).catch(() => undefined);
  }

  logEvent({
    workspaceId: state.instance.workspaceId,
    pluginId: state.instance.pluginId,
    eventType: "instance.shutdown",
    eventData: {
      pluginSlug: state.instance.pluginSlug,
      scope: state.instance.scope,
      reason,
      durationSec: Math.round((Date.now() - state.instance.createdAt) / 1000),
    },
  });
}

async function createOwnedInstance(
  params: McpInstanceParams,
  key: string,
  configHash: string,
  leaseToken?: string,
) {
  const underlying = await createTransportInstance(params, key, configHash);
  const wrapped: McpInstance = {
    ...underlying,
    shutdown: async () => {
      await shutdownInstanceByKey(key, "explicit");
    },
  };

  const state: InstanceState = {
    kind: "local",
    params,
    instance: wrapped,
    configHash,
    baseShutdown: underlying.shutdown,
    leaseToken,
    leaseHeartbeatTimer:
      leaseToken && params.scope !== "turn"
        ? startLeaseHeartbeat(key, leaseToken)
        : undefined,
  };

  instanceStates.set(key, state);
  instanceCache.set(key, wrapped);
  resetTTL(key, wrapped.idleTtlMs);

  logEvent({
    workspaceId: params.workspaceId,
    pluginId: params.pluginId,
    eventType: "instance.created",
    eventData: {
      pluginSlug: params.pluginSlug,
      scope: params.scope,
      scopeId: params.scopeId,
      configHash,
      transport: params.transport,
      ownerNodeId: RUNTIME_NODE_ID,
    },
  });

  return wrapped;
}

function createProxyInstance(
  params: McpInstanceParams,
  key: string,
  configHash: string,
): McpInstance {
  let runtimeSessionId: string | undefined;
  const idleTtlMs = params.idleTtlMs ?? getTTLForScope(params.scope);
  const createdAt = Date.now();

  const proxy: McpInstance = {
    pluginId: params.pluginId,
    installationId: params.installationId,
    pluginSlug: params.pluginSlug,
    orgSlug: params.orgSlug,
    transport: params.transport,
    scope: params.scope,
    scopeId: params.scopeId,
    workspaceId: params.workspaceId,
    configHash,
    tools: [],
    execute: async (toolName, input, executionContext) => {
      const response = await invokeDistributedInstanceCommand<{
        result: unknown;
        runtimeSessionId?: string;
      }>({
        command: "execute",
        params,
        key,
        configHash,
        toolName,
        input,
        executionContext,
      });
      runtimeSessionId = response.runtimeSessionId;
      return response.result;
    },
    executeWithBinding: async (toolName, input, binding, executionContext) => {
      const response = await invokeDistributedInstanceCommand<{
        result: unknown;
        runtimeSessionId?: string;
      }>({
        command: "execute_with_binding",
        params,
        key,
        configHash,
        toolName,
        input,
        binding,
        executionContext,
      });
      runtimeSessionId = response.runtimeSessionId;
      return response.result;
    },
    ensureRuntimeSession: async () => {
      const response = await invokeDistributedInstanceCommand<{
        runtimeSessionId?: string;
      }>({
        command: "ensure_runtime_session",
        params,
        key,
        configHash,
      });
      if (!response.runtimeSessionId) {
        throw new Error(`Instance ${key} does not expose a runtime session`);
      }
      runtimeSessionId = response.runtimeSessionId;
      return response.runtimeSessionId;
    },
    getRuntimeSessionId: () => runtimeSessionId,
    shutdown: async () => {
      await shutdownInstanceByKey(key, "explicit");
    },
    lastUsed: createdAt,
    createdAt,
    idleTtlMs,
    maxAgeMs: params.maxAgeMs,
  };

  instanceStates.set(key, {
    kind: "proxy",
    params,
    instance: proxy,
    configHash,
  });
  instanceCache.set(key, proxy);
  resetTTL(key, idleTtlMs);
  return proxy;
}

async function ensureLocallyOwnedInstance(
  params: McpInstanceParams,
  key: string,
  configHash: string,
) {
  const existing = instanceStates.get(key);
  if (existing?.kind === "local") {
    return existing.instance;
  }

  const token =
    params.scope === "turn" ? null : await acquireRuntimeLease(key);
  if (params.scope !== "turn" && !token) {
    throw new Error(`Runtime lease for ${key} is held by another node`);
  }

  return createOwnedInstance(params, key, configHash, token || undefined);
}

async function resolveDistributedOwnerNode(
  params: McpInstanceParams,
  key: string,
  configHash: string,
) {
  if (params.scope === "turn") {
    return RUNTIME_NODE_ID;
  }

  const cached = instanceStates.get(key);
  if (cached?.kind === "local") {
    return RUNTIME_NODE_ID;
  }

  const acquiredToken = await acquireRuntimeLease(key);
  if (acquiredToken) {
    await createOwnedInstance(params, key, configHash, acquiredToken);
    return RUNTIME_NODE_ID;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lease = await readRuntimeLease(key);
    if (lease?.nodeId) {
      return lease.nodeId;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Unable to resolve runtime owner for ${key}`);
}

async function handleLocalInstanceCommand(payload: RemoteInstanceCommand) {
  const instance = await ensureLocallyOwnedInstance(
    payload.params,
    payload.key,
    payload.configHash,
  );

  switch (payload.command) {
    case "execute":
      return {
        result: await instance.execute(
          payload.toolName,
          payload.input,
          payload.executionContext,
        ),
        runtimeSessionId: instance.getRuntimeSessionId?.(),
      };
    case "execute_with_binding":
      if (instance.executeWithBinding) {
        return {
          result: await instance.executeWithBinding(
            payload.toolName,
            payload.input,
            payload.binding,
            payload.executionContext,
          ),
          runtimeSessionId: instance.getRuntimeSessionId?.(),
        };
      }
      return {
        result: await instance.execute(
          payload.toolName,
          payload.input,
          payload.executionContext,
        ),
        runtimeSessionId: instance.getRuntimeSessionId?.(),
      };
    case "ensure_runtime_session":
      return {
        runtimeSessionId: instance.ensureRuntimeSession
          ? await instance.ensureRuntimeSession()
          : instance.getRuntimeSessionId?.(),
      };
    default:
      throw new Error(
        `Unsupported instance command '${(payload as { command: string }).command}'`,
      );
  }
}

async function invokeDistributedInstanceCommand<T>(payload: RemoteInstanceCommand) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ownerNodeId = await resolveDistributedOwnerNode(
      payload.params,
      payload.key,
      payload.configHash,
    );
    if (ownerNodeId === RUNTIME_NODE_ID) {
      return handleLocalInstanceCommand(payload) as Promise<T>;
    }

    try {
      return await sendRuntimeCommand<T>(
        ownerNodeId,
        "mcp.instance.command",
        payload,
        RUNTIME_REMOTE_COMMAND_TIMEOUT_MS,
      );
    } catch (error) {
      if (attempt === 0) {
        clearTTLTimer(payload.key);
        instanceCache.delete(payload.key);
        instanceStates.delete(payload.key);
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Failed to route distributed runtime command for ${payload.key}`);
}

function maybeExpireInstance(key: string, instance: McpInstance) {
  if (instance.maxAgeMs && Date.now() - instance.createdAt > instance.maxAgeMs) {
    void shutdownInstanceByKey(key, "max_age_exceeded");
    return true;
  }
  return false;
}

export async function getOrCreateInstance(
  params: McpInstanceParams,
): Promise<McpInstance> {
  const configHash = computeConfigHash(params.config);
  const key = buildInstanceKey(
    params.installationId,
    configHash,
    params.scope,
    params.scopeId,
  );

  const cached = instanceCache.get(key);
  if (cached) {
    if (!maybeExpireInstance(key, cached)) {
      cached.lastUsed = Date.now();
      resetTTL(key, cached.idleTtlMs);
      return cached;
    }
  }

  if (params.scope === "turn") {
    return createOwnedInstance(params, key, configHash);
  }

  const ownerNodeId = await resolveDistributedOwnerNode(params, key, configHash);
  if (ownerNodeId === RUNTIME_NODE_ID) {
    const local = instanceCache.get(key);
    if (local) {
      local.lastUsed = Date.now();
      resetTTL(key, local.idleTtlMs);
      return local;
    }
    return ensureLocallyOwnedInstance(params, key, configHash);
  }

  const proxy = createProxyInstance(params, key, configHash);
  proxy.lastUsed = Date.now();
  resetTTL(key, proxy.idleTtlMs);
  return proxy;
}

async function scanLeaseKeys(pattern: string) {
  const matched: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100,
    );
    cursor = nextCursor;
    matched.push(...keys);
  } while (cursor !== "0");
  return matched;
}

export async function shutdownSessionInstances(sessionId: string) {
  const sessionScopeId = `session:${sessionId}`;

  const keysToRemove: string[] = [];
  for (const [key, instance] of instanceCache) {
    if (instance.scope === "turn" && instance.scopeId.startsWith(`session:${sessionId}:`)) {
      keysToRemove.push(key);
      continue;
    }
    if (instance.scope === "session" && instance.scopeId === sessionScopeId) {
      keysToRemove.push(key);
    }
  }

  for (const key of keysToRemove) {
    await shutdownInstanceByKey(key, "session_terminated");
  }

  const leaseKeys = await scanLeaseKeys(
    `mcp:runtime:lease:*:*:session:${sessionScopeId}`,
  );
  if (leaseKeys.length > 0) {
    const metaKeys = leaseKeys.map((key) => key.replace(":lease:", ":lease-meta:"));
    await redis.del(...leaseKeys, ...metaKeys).catch(() => undefined);
  }
}

export async function restartInstancesForConfig(pluginId: string, workspaceId?: string) {
  if (workspaceId) {
    await incrementMcpVersion(workspaceId);
  }
  logEvent({
    workspaceId,
    pluginId,
    eventType: "instance.restart",
    eventData: { reason: "config_changed_version_bumped" },
  });
}

export async function shutdownAllInstances() {
  const keys = Array.from(instanceStates.keys());
  for (const key of keys) {
    await shutdownInstanceByKey(key, "process_shutdown");
  }
  for (const timer of ttlTimers.values()) {
    clearTimeout(timer);
  }
  ttlTimers.clear();
  instanceCache.clear();
  instanceStates.clear();
  await shutdownRuntimeControlPlane();
}

let instanceManagerInitialized = false;

export function initInstanceManagerListeners() {
  if (instanceManagerInitialized) {
    return;
  }
  instanceManagerInitialized = true;
  registerRuntimeCommandHandler("mcp.instance.command", async (payload) => {
    return handleLocalInstanceCommand(payload as RemoteInstanceCommand);
  });
  void initRuntimeControlPlane();
}
