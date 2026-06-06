import { createHash, randomUUID } from "crypto"
import type { ToolDefinition } from "@synapse/shared"
import type { CapabilityInvocationContext } from "@synapse/shared/types"
import { redis } from "../../infrastructure/redis/index.js"
import { db } from "../../infrastructure/database/kysely.js"
import { McpRemoteClient, type RemoteMcpProtocol } from "./mcp-remote-client.js"
import { McpStdioClient } from "./mcp-stdio-client.js"
import { getBuiltinHandler } from "./builtin/index.js"
import {
  getTransportFactory,
  registerTransport,
} from "./transports/registry.js"
import {
  resolveRemoteEntryPoint,
  redactUrlForLog,
  type TemplateContext,
} from "./transports/entrypoint.js"
import { logEvent } from "./audit.js"
import {
  getRuntimeNodeId,
  initRuntimeControlPlane,
  registerRuntimeCommandHandler,
  sendRuntimeCommand,
  shutdownRuntimeControlPlane,
} from "./runtime-control-plane.js"
import { incrementMcpVersion } from "./runtime-version.js"

const RUNTIME_NODE_ID = getRuntimeNodeId()
const RUNTIME_LEASE_TTL_MS = 45_000
const RUNTIME_LEASE_RENEW_INTERVAL_MS = 15_000
const RUNTIME_REMOTE_COMMAND_TIMEOUT_MS = 30_000

const MCP_INSTANCE_TTL_TURN = 5 * 60 * 1000
const MCP_INSTANCE_TTL_SESSION = 1 * 60 * 60 * 1000
const MCP_INSTANCE_TTL_ACTOR = 2 * 60 * 60 * 1000
const MCP_INSTANCE_TTL_CONVERSATION = 1 * 60 * 60 * 1000
const MCP_INSTANCE_TTL_WORKSPACE = 24 * 60 * 60 * 1000

type InstanceTransport = "builtin" | "stdio" | "http" | "sse" | string

export type McpInstanceParams = {
  pluginId: string
  installationId: string
  pluginSlug: string
  orgSlug: string
  transport: InstanceTransport
  entryPoint: string
  scope: string
  scopeId: string
  config: Record<string, unknown>
  workspaceId?: string
  idleTtlMs?: number
  maxAgeMs?: number
}

type InstanceState = {
  kind: "local" | "proxy"
  params: McpInstanceParams
  instance: McpInstance
  configHash: string
  baseShutdown?: () => Promise<void>
  leaseToken?: string
  leaseHeartbeatTimer?: NodeJS.Timeout
}

type RuntimeLeaseMetadata = {
  nodeId: string
  token: string
  instanceKey: string
  updatedAt: number
}

type RemoteInstanceCommand =
  | {
      command: "execute"
      params: McpInstanceParams
      key: string
      configHash: string
      toolName: string
      input: Record<string, unknown>
      executionContext?: McpExecutionContext
    }
  | {
      command: "execute_with_binding"
      params: McpInstanceParams
      key: string
      configHash: string
      toolName: string
      input: Record<string, unknown>
      binding: unknown
      executionContext?: McpExecutionContext
    }
  | {
      command: "ensure_runtime_session"
      params: McpInstanceParams
      key: string
      configHash: string
    }
  | {
      command: "describe"
      params: McpInstanceParams
      key: string
      configHash: string
    }

export type McpExecutionContext = CapabilityInvocationContext

export interface McpInstance {
  pluginId: string
  installationId: string
  pluginSlug: string
  orgSlug: string
  transport: string
  scope: string
  scopeId: string
  workspaceId?: string
  configHash: string
  tools: ToolDefinition[]
  // Device-only metadata exposed at instance level so tool-resolver can
  // build a correct device origin BEFORE invoking execute (the
  // per-tool runtime context with deviceId/exposureStableKey isn't
  // populated until ensureRuntimeSession runs inside execute). Without
  // this, the failure path or the first tool call gets mis-tagged as
  // plugin origin — Phase 10 review fix.
  deviceInstanceMetadata?: {
    deviceId: string
    exposureId: string
    exposureStableKey: string
    exposureDisplayName?: string
  }
  execute: (
    toolName: string,
    input: Record<string, unknown>,
    executionContext?: McpExecutionContext
  ) => Promise<unknown>
  executeWithBinding?: (
    toolName: string,
    input: Record<string, unknown>,
    binding: unknown,
    executionContext?: McpExecutionContext
  ) => Promise<unknown>
  sanitizeInputForLogging?: (
    toolName: string,
    input: Record<string, unknown>
  ) => Record<string, unknown>
  ensureRuntimeSession?: () => Promise<string>
  getRuntimeSessionId?: () => string | undefined
  shutdown: () => Promise<void>
  lastUsed: number
  createdAt: number
  idleTtlMs: number
  maxAgeMs?: number
}

const instanceCache = new Map<string, McpInstance>()
const instanceStates = new Map<string, InstanceState>()
const ttlTimers = new Map<string, NodeJS.Timeout>()

function stableSerialize(value: unknown): string {
  if (value === null) {
    return "null"
  }
  if (value === undefined) {
    return "undefined"
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, nestedValue]) =>
          `${JSON.stringify(key)}:${stableSerialize(nestedValue)}`
      )
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value)
}

function computeConfigHash(config: Record<string, unknown>): string {
  const json = stableSerialize(config)
  return createHash("sha256").update(json).digest("hex").slice(0, 16)
}

function buildInstanceKey(
  installationId: string,
  configHash: string,
  scope: string,
  scopeId: string
) {
  return `${installationId}:${configHash}:${scope}:${scopeId}`
}

function runtimeLeaseKey(instanceKey: string) {
  return `mcp:runtime:lease:${instanceKey}`
}

function runtimeLeaseMetaKey(instanceKey: string) {
  return `mcp:runtime:lease-meta:${instanceKey}`
}

function getTTLForScope(scope: string): number {
  switch (scope) {
    case "workspace":
      return MCP_INSTANCE_TTL_WORKSPACE
    case "conversation":
      return MCP_INSTANCE_TTL_CONVERSATION
    case "actor":
      return MCP_INSTANCE_TTL_ACTOR
    case "session":
      return MCP_INSTANCE_TTL_SESSION
    case "turn":
      return MCP_INSTANCE_TTL_TURN
    default:
      return MCP_INSTANCE_TTL_CONVERSATION
  }
}

function clearTTLTimer(key: string) {
  const timer = ttlTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    ttlTimers.delete(key)
  }
}

// NOTE: this is intentionally NOT the shared infrastructure/redis/lock helper.
// It is a richer 2-key lease that atomically maintains a companion metadata key
// (nodeId/token/updatedAt) alongside the lock so other replicas can READ who
// holds the runtime without taking it. Folding it into the single-key helper
// would lose that metadata atomicity, so it keeps its own fenced Lua scripts.
async function acquireRuntimeLease(instanceKey: string) {
  const token = `${RUNTIME_NODE_ID}:${randomUUID()}`
  const metadata: RuntimeLeaseMetadata = {
    nodeId: RUNTIME_NODE_ID,
    token,
    instanceKey,
    updatedAt: Date.now(),
  }
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
    JSON.stringify(metadata)
  )
  return Number(result) === 1 ? token : null
}

async function renewRuntimeLease(instanceKey: string, token: string) {
  const metadata: RuntimeLeaseMetadata = {
    nodeId: RUNTIME_NODE_ID,
    token,
    instanceKey,
    updatedAt: Date.now(),
  }
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
    JSON.stringify(metadata)
  )
  return Number(result) === 1
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
    token
  )
}

async function readRuntimeLease(
  instanceKey: string
): Promise<RuntimeLeaseMetadata | null> {
  const raw = await redis.get(runtimeLeaseMetaKey(instanceKey))
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as RuntimeLeaseMetadata
    if (!parsed.nodeId || !parsed.token) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function resetTTL(key: string, ttl: number) {
  clearTTLTimer(key)
  const timer = setTimeout(() => {
    void shutdownInstanceByKey(key, "ttl_expired")
  }, ttl)
  timer.unref?.()
  ttlTimers.set(key, timer)
}

function startLeaseHeartbeat(key: string, token: string) {
  const timer = setInterval(() => {
    void renewRuntimeLease(key, token)
      .then((renewed) => {
        if (!renewed) {
          void shutdownInstanceByKey(key, "lease_lost")
        }
      })
      .catch(() => {
        void shutdownInstanceByKey(key, "lease_renew_failed")
      })
  }, RUNTIME_LEASE_RENEW_INTERVAL_MS)
  timer.unref?.()
  return timer
}

async function createBuiltinInstance(
  params: McpInstanceParams,
  configHash: string
): Promise<McpInstance> {
  const handler = getBuiltinHandler(params.entryPoint)
  if (!handler) {
    throw new Error(`No builtin handler found for: ${params.entryPoint}`)
  }

  const tools = handler.getToolsFiltered
    ? handler.getToolsFiltered(params.config)
    : handler.getTools()

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
      }
      return handler.execute(toolName, input, configWithScope)
    },
    shutdown: async () => {},
    lastUsed: Date.now(),
    createdAt: Date.now(),
    idleTtlMs: params.idleTtlMs ?? getTTLForScope(params.scope),
    maxAgeMs: params.maxAgeMs,
  }
}

function buildTemplateContext(params: McpInstanceParams): TemplateContext {
  return {
    config: params.config,
    runtime: {
      installationId: params.installationId,
      pluginId: params.pluginId,
      workspaceId: params.workspaceId ?? "",
      scopeId: params.scopeId,
    },
  }
}

async function createRemoteInstance(
  params: McpInstanceParams,
  configHash: string,
  defaultProtocol: RemoteMcpProtocol
): Promise<McpInstance> {
  const ctx = buildTemplateContext(params)
  const resolved = resolveRemoteEntryPoint(
    params.entryPoint,
    ctx,
    defaultProtocol
  )
  const safeEndpoint = redactUrlForLog(resolved.url)

  const client = new McpRemoteClient(
    resolved.url,
    resolved.headers,
    resolved.protocol
  )
  try {
    const initResult = await client.initialize()
    logEvent({
      workspaceId: params.workspaceId,
      pluginId: params.pluginId,
      eventType: "connection.init",
      eventData: {
        endpoint: safeEndpoint,
        success: true,
        serverInfo: initResult.serverInfo,
        transport: resolved.protocol,
      },
    })
  } catch (error: any) {
    logEvent({
      workspaceId: params.workspaceId,
      pluginId: params.pluginId,
      eventType: "connection.error",
      eventData: {
        endpoint: safeEndpoint,
        error: error?.message,
        transport: resolved.protocol,
      },
    })
    await client.shutdown().catch(() => {})
    throw error
  }

  // Fail-fast on tool discovery: these plugins ship empty static manifests, so
  // silently degrading to [] would make the plugin's tools vanish. Surface the
  // error (instance creation fails) instead.
  let tools: ToolDefinition[]
  try {
    tools = await client.listTools()
  } catch (error: any) {
    logEvent({
      workspaceId: params.workspaceId,
      pluginId: params.pluginId,
      eventType: "connection.error",
      eventData: {
        endpoint: safeEndpoint,
        error: `listTools failed: ${error?.message}`,
        transport: resolved.protocol,
      },
    })
    await client.shutdown().catch(() => {})
    throw error
  }

  return {
    pluginId: params.pluginId,
    installationId: params.installationId,
    pluginSlug: params.pluginSlug,
    orgSlug: params.orgSlug,
    transport: resolved.protocol === "sse" ? "sse" : "http",
    scope: params.scope,
    scopeId: params.scopeId,
    workspaceId: params.workspaceId,
    configHash,
    tools,
    execute: async (toolName, input) => client.callTool(toolName, input),
    shutdown: async () => {
      await client.shutdown()
    },
    lastUsed: Date.now(),
    createdAt: Date.now(),
    idleTtlMs: params.idleTtlMs ?? getTTLForScope(params.scope),
    maxAgeMs: params.maxAgeMs,
  }
}

async function createStdioInstance(
  params: McpInstanceParams,
  configHash: string,
  key: string
): Promise<McpInstance> {
  const client = new McpStdioClient(params.entryPoint, params.config, key)

  try {
    const initResult = await client.initialize()
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
    })
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
    })
    throw error
  }

  let tools: ToolDefinition[]
  try {
    tools = await client.listTools()
  } catch {
    tools = []
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
      await client.shutdown()
    },
    lastUsed: Date.now(),
    createdAt: Date.now(),
    idleTtlMs: params.idleTtlMs ?? getTTLForScope(params.scope),
    maxAgeMs: params.maxAgeMs,
  }
}

// Register the built-in server transports. builtin/stdio keep their existing
// behaviour; http/sse both route through the official-SDK remote client.
registerTransport("builtin", (params, _key, configHash) =>
  createBuiltinInstance(params, configHash)
)
registerTransport("stdio", (params, key, configHash) =>
  createStdioInstance(params, configHash, key)
)
registerTransport("http", (params, _key, configHash) =>
  createRemoteInstance(params, configHash, "streamable-http")
)
registerTransport("sse", (params, _key, configHash) =>
  createRemoteInstance(params, configHash, "sse")
)

async function createTransportInstance(
  params: McpInstanceParams,
  key: string,
  configHash: string
) {
  const factory = getTransportFactory(params.transport)
  if (!factory) {
    throw new Error(`Unsupported transport: ${params.transport}`)
  }
  return factory(params, key, configHash)
}

async function shutdownInstanceByKey(key: string, reason: string) {
  const state = instanceStates.get(key)
  if (!state) {
    clearTTLTimer(key)
    instanceCache.delete(key)
    return
  }

  instanceStates.delete(key)
  instanceCache.delete(key)
  clearTTLTimer(key)

  if (state.leaseHeartbeatTimer) {
    clearInterval(state.leaseHeartbeatTimer)
  }

  try {
    await state.baseShutdown?.()
  } catch {
    // Ignore shutdown failures during cleanup.
  }

  if (state.leaseToken) {
    await releaseRuntimeLease(key, state.leaseToken).catch(() => undefined)
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
  })
}

async function createOwnedInstance(
  params: McpInstanceParams,
  key: string,
  configHash: string,
  leaseToken?: string
) {
  let underlying: McpInstance
  try {
    underlying = await createTransportInstance(params, key, configHash)
  } catch (error) {
    // Transport creation (e.g. remote init / fail-fast listTools) threw before
    // any state was registered, so shutdownInstanceByKey will never run to
    // release the lease. Release it here so a transient connection failure does
    // not pin this instance key until the Redis lease TTL expires.
    if (leaseToken) {
      await releaseRuntimeLease(key, leaseToken).catch(() => undefined)
    }
    throw error
  }
  const wrapped: McpInstance = {
    ...underlying,
    shutdown: async () => {
      await shutdownInstanceByKey(key, "explicit")
    },
  }

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
  }

  instanceStates.set(key, state)
  instanceCache.set(key, wrapped)
  resetTTL(key, wrapped.idleTtlMs)

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
  })

  return wrapped
}

async function createProxyInstance(
  params: McpInstanceParams,
  key: string,
  configHash: string
): Promise<McpInstance> {
  let runtimeSessionId: string | undefined
  const idleTtlMs = params.idleTtlMs ?? getTTLForScope(params.scope)
  const createdAt = Date.now()

  // Fetch the resolved tool list from the lease owner BEFORE returning. The
  // tool-resolver reads `runtimeInstance.tools` synchronously and remote
  // plugins ship empty static manifests, so a proxy with tools:[] would make
  // the plugin's tools vanish on non-owner nodes. A describe failure is treated
  // like an init failure (throws / triggers owner re-resolution).
  const describeResponse = await invokeDistributedInstanceCommand<{
    tools: ToolDefinition[]
  }>({
    command: "describe",
    params,
    key,
    configHash,
  })
  const tools = describeResponse.tools ?? []

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
    tools,
    execute: async (toolName, input, executionContext) => {
      const response = await invokeDistributedInstanceCommand<{
        result: unknown
        runtimeSessionId?: string
      }>({
        command: "execute",
        params,
        key,
        configHash,
        toolName,
        input,
        executionContext,
      })
      runtimeSessionId = response.runtimeSessionId
      return response.result
    },
    executeWithBinding: async (toolName, input, binding, executionContext) => {
      const response = await invokeDistributedInstanceCommand<{
        result: unknown
        runtimeSessionId?: string
      }>({
        command: "execute_with_binding",
        params,
        key,
        configHash,
        toolName,
        input,
        binding,
        executionContext,
      })
      runtimeSessionId = response.runtimeSessionId
      return response.result
    },
    ensureRuntimeSession: async () => {
      const response = await invokeDistributedInstanceCommand<{
        runtimeSessionId?: string
      }>({
        command: "ensure_runtime_session",
        params,
        key,
        configHash,
      })
      if (!response.runtimeSessionId) {
        throw new Error(`Instance ${key} does not expose a runtime session`)
      }
      runtimeSessionId = response.runtimeSessionId
      return response.runtimeSessionId
    },
    getRuntimeSessionId: () => runtimeSessionId,
    shutdown: async () => {
      await shutdownInstanceByKey(key, "explicit")
    },
    lastUsed: createdAt,
    createdAt,
    idleTtlMs,
    maxAgeMs: params.maxAgeMs,
  }

  instanceStates.set(key, {
    kind: "proxy",
    params,
    instance: proxy,
    configHash,
  })
  instanceCache.set(key, proxy)
  resetTTL(key, idleTtlMs)
  return proxy
}

async function ensureLocallyOwnedInstance(
  params: McpInstanceParams,
  key: string,
  configHash: string
) {
  const existing = instanceStates.get(key)
  if (existing?.kind === "local") {
    return existing.instance
  }

  const token = params.scope === "turn" ? null : await acquireRuntimeLease(key)
  if (params.scope !== "turn" && !token) {
    throw new Error(`Runtime lease for ${key} is held by another node`)
  }

  return createOwnedInstance(params, key, configHash, token || undefined)
}

async function resolveDistributedOwnerNode(
  params: McpInstanceParams,
  key: string,
  configHash: string
) {
  if (params.scope === "turn") {
    return RUNTIME_NODE_ID
  }

  const cached = instanceStates.get(key)
  if (cached?.kind === "local") {
    return RUNTIME_NODE_ID
  }

  const acquiredToken = await acquireRuntimeLease(key)
  if (acquiredToken) {
    await createOwnedInstance(params, key, configHash, acquiredToken)
    return RUNTIME_NODE_ID
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lease = await readRuntimeLease(key)
    if (lease?.nodeId) {
      return lease.nodeId
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`Unable to resolve runtime owner for ${key}`)
}

async function handleLocalInstanceCommand(payload: RemoteInstanceCommand) {
  const instance = await ensureLocallyOwnedInstance(
    payload.params,
    payload.key,
    payload.configHash
  )

  switch (payload.command) {
    case "execute":
      return {
        result: await instance.execute(
          payload.toolName,
          payload.input,
          payload.executionContext
        ),
        runtimeSessionId: instance.getRuntimeSessionId?.(),
      }
    case "execute_with_binding":
      if (instance.executeWithBinding) {
        return {
          result: await instance.executeWithBinding(
            payload.toolName,
            payload.input,
            payload.binding,
            payload.executionContext
          ),
          runtimeSessionId: instance.getRuntimeSessionId?.(),
        }
      }
      return {
        result: await instance.execute(
          payload.toolName,
          payload.input,
          payload.executionContext
        ),
        runtimeSessionId: instance.getRuntimeSessionId?.(),
      }
    case "ensure_runtime_session":
      return {
        runtimeSessionId: instance.ensureRuntimeSession
          ? await instance.ensureRuntimeSession()
          : instance.getRuntimeSessionId?.(),
      }
    case "describe":
      // Owner-node tool discovery for proxies. The proxy node has no live
      // client, and remote plugins ship empty static manifests, so it asks the
      // lease owner for the resolved tool list.
      return { tools: instance.tools }
    default:
      throw new Error(
        `Unsupported instance command '${(payload as { command: string }).command}'`
      )
  }
}

async function invokeDistributedInstanceCommand<T>(
  payload: RemoteInstanceCommand
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ownerNodeId = await resolveDistributedOwnerNode(
      payload.params,
      payload.key,
      payload.configHash
    )
    if (ownerNodeId === RUNTIME_NODE_ID) {
      return handleLocalInstanceCommand(payload) as Promise<T>
    }

    try {
      return await sendRuntimeCommand<T>(
        ownerNodeId,
        "mcp.instance.command",
        payload,
        RUNTIME_REMOTE_COMMAND_TIMEOUT_MS
      )
    } catch (error) {
      if (attempt === 0) {
        clearTTLTimer(payload.key)
        instanceCache.delete(payload.key)
        instanceStates.delete(payload.key)
        continue
      }
      throw error
    }
  }

  throw new Error(
    `Failed to route distributed runtime command for ${payload.key}`
  )
}

function maybeExpireInstance(key: string, instance: McpInstance) {
  if (
    instance.maxAgeMs &&
    Date.now() - instance.createdAt > instance.maxAgeMs
  ) {
    void shutdownInstanceByKey(key, "max_age_exceeded")
    return true
  }
  return false
}

export async function getOrCreateInstance(
  params: McpInstanceParams
): Promise<McpInstance> {
  const configHash = computeConfigHash(params.config)
  const key = buildInstanceKey(
    params.installationId,
    configHash,
    params.scope,
    params.scopeId
  )

  const cached = instanceCache.get(key)
  if (cached) {
    if (!maybeExpireInstance(key, cached)) {
      cached.lastUsed = Date.now()
      resetTTL(key, cached.idleTtlMs)
      return cached
    }
  }

  if (params.scope === "turn") {
    return createOwnedInstance(params, key, configHash)
  }

  const ownerNodeId = await resolveDistributedOwnerNode(params, key, configHash)
  if (ownerNodeId === RUNTIME_NODE_ID) {
    const local = instanceCache.get(key)
    if (local) {
      local.lastUsed = Date.now()
      resetTTL(key, local.idleTtlMs)
      return local
    }
    return ensureLocallyOwnedInstance(params, key, configHash)
  }

  const proxy = await createProxyInstance(params, key, configHash)
  proxy.lastUsed = Date.now()
  resetTTL(key, proxy.idleTtlMs)
  return proxy
}

async function scanLeaseKeys(pattern: string) {
  const matched: string[] = []
  let cursor = "0"
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100
    )
    cursor = nextCursor
    matched.push(...keys)
  } while (cursor !== "0")
  return matched
}

export async function shutdownSessionInstances(sessionId: string) {
  const sessionScopeId = `session:${sessionId}`

  const keysToRemove: string[] = []
  for (const [key, instance] of instanceCache) {
    if (
      instance.scope === "turn" &&
      instance.scopeId.startsWith(`session:${sessionId}:`)
    ) {
      keysToRemove.push(key)
      continue
    }
    if (instance.scope === "session" && instance.scopeId === sessionScopeId) {
      keysToRemove.push(key)
    }
  }

  for (const key of keysToRemove) {
    await shutdownInstanceByKey(key, "session_terminated")
  }

  const leaseKeys = await scanLeaseKeys(
    `mcp:runtime:lease:*:*:session:${sessionScopeId}`
  )
  if (leaseKeys.length > 0) {
    const metaKeys = leaseKeys.map((key) =>
      key.replace(":lease:", ":lease-meta:")
    )
    await redis.del(...leaseKeys, ...metaKeys).catch(() => undefined)
  }
}

export async function restartInstancesForConfig(
  pluginId: string,
  workspaceId?: string
) {
  if (workspaceId) {
    await incrementMcpVersion(workspaceId)
  }
  logEvent({
    workspaceId,
    pluginId,
    eventType: "instance.restart",
    eventData: { reason: "config_changed_version_bumped" },
  })
}

export async function shutdownAllInstances() {
  const keys = Array.from(instanceStates.keys())
  for (const key of keys) {
    await shutdownInstanceByKey(key, "process_shutdown")
  }
  for (const timer of ttlTimers.values()) {
    clearTimeout(timer)
  }
  ttlTimers.clear()
  instanceCache.clear()
  instanceStates.clear()
  await shutdownRuntimeControlPlane()
}

let instanceManagerInitialized = false

export function initInstanceManagerListeners() {
  if (instanceManagerInitialized) {
    return
  }
  instanceManagerInitialized = true
  registerRuntimeCommandHandler("mcp.instance.command", async (payload) => {
    return handleLocalInstanceCommand(payload as RemoteInstanceCommand)
  })
  void initRuntimeControlPlane()
}
