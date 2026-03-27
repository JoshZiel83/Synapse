import { createHash } from 'crypto';
import { ToolDefinition } from '@synapse/shared';
import { redis } from '../../infrastructure/redis/index.js';

const MCP_VERSION_KEY_PREFIX = 'mcp:v:';
const MCP_INSTANCE_TTL_TURN = 5 * 60 * 1000; // 5 minutes
const MCP_INSTANCE_TTL_ACTOR = 2 * 60 * 60 * 1000; // 2 hours
const MCP_INSTANCE_TTL_ACTOR_CONV = 1 * 60 * 60 * 1000; // 1 hour
const MCP_INSTANCE_TTL_CONV = 1 * 60 * 60 * 1000; // 1 hour
const MCP_INSTANCE_TTL_WORKSPACE = 24 * 60 * 60 * 1000; // 24 hours
import { McpHttpClient } from './mcp-client.js';
import { McpStdioClient } from './mcp-stdio-client.js';
import { getBuiltinHandler } from './builtin/index.js';
import { logEvent } from './audit.js';

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
  execute: (toolName: string, input: Record<string, unknown>) => Promise<unknown>;
  executeWithBinding?: (
    toolName: string,
    input: Record<string, unknown>,
    binding: unknown,
  ) => Promise<unknown>;
  ensureRuntimeSession?: () => Promise<string>;
  getRuntimeSessionId?: () => string | undefined;
  shutdown: () => Promise<void>;
  lastUsed: number;
  createdAt: number;
  idleTtlMs: number;
  maxAgeMs?: number;
}

// In-memory cache: key = installationId:configHash:reuseScope:ownerKey
const instanceCache = new Map<string, McpInstance>();
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
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function buildInstanceKey(installationId: string, configHash: string, scope: string, scopeId: string): string {
  return `${installationId}:${configHash}:${scope}:${scopeId}`;
}

/**
 * Get or create an MCP instance for the given plugin + scope + config
 */
export async function getOrCreateInstance(params: {
  pluginId: string;
  installationId: string;
  pluginSlug: string;
  orgSlug: string;
  transport: string;
  entryPoint: string;
  scope: string;
  scopeId: string;
  config: Record<string, unknown>;
  workspaceId?: string;
  idleTtlMs?: number;
  maxAgeMs?: number;
  factory?: (details: { key: string; configHash: string }) => Promise<McpInstance>;
}): Promise<McpInstance> {
  const configHash = computeConfigHash(params.config);
  const key = buildInstanceKey(params.installationId, configHash, params.scope, params.scopeId);

  // Return cached instance if exists
  const cached = instanceCache.get(key);
  if (cached) {
    if (cached.maxAgeMs && Date.now() - cached.createdAt > cached.maxAgeMs) {
      await cached.shutdown().catch(() => {});
      instanceCache.delete(key);
      clearTTLTimer(key);
    } else {
      cached.lastUsed = Date.now();
      resetTTL(key, cached.idleTtlMs);
      return cached;
    }
  }

  // Create new instance based on transport
  let instance: McpInstance;

  if (params.transport === 'builtin') {
    instance = await createBuiltinInstance(params, key, configHash);
  } else if (params.transport === 'stdio') {
    instance = await createStdioInstance(params, key, configHash);
  } else if (params.transport === 'http') {
    instance = await createHttpInstance(params, key, configHash);
  } else if (params.factory) {
    instance = await params.factory({ key, configHash });
  } else {
    throw new Error(`Unsupported transport: ${params.transport}`);
  }

  if (!(instance.idleTtlMs > 0)) {
    instance.idleTtlMs = params.idleTtlMs ?? getTTLForScope(params.scope);
  }

  instanceCache.set(key, instance);
  resetTTL(key, instance.idleTtlMs);

  // Log instance creation
  logEvent({
    workspaceId: params.workspaceId,
    pluginId: params.pluginId,
    eventType: 'instance.created',
    eventData: { pluginSlug: params.pluginSlug, scope: params.scope, scopeId: params.scopeId, configHash, transport: params.transport },
  });

  return instance;
}

async function createBuiltinInstance(params: {
  pluginId: string;
  installationId: string;
  pluginSlug: string;
  orgSlug: string;
  transport: string;
  entryPoint: string;
  scope: string;
  scopeId: string;
  config: Record<string, unknown>;
  workspaceId?: string;
  idleTtlMs?: number;
  maxAgeMs?: number;
}, key: string, configHash: string): Promise<McpInstance> {
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
    transport: 'builtin',
    scope: params.scope,
    scopeId: params.scopeId,
    workspaceId: params.workspaceId,
    configHash,
    tools,
    execute: async (toolName, input) => {
      const configWithScope = { ...params.config, workspace_id: params.workspaceId || params.scopeId };
      return handler.execute(toolName, input, configWithScope);
    },
    shutdown: async () => {
      instanceCache.delete(key);
      clearTTLTimer(key);
    },
    lastUsed: Date.now(),
    createdAt: Date.now(),
    idleTtlMs: params.idleTtlMs ?? getTTLForScope(params.scope),
    maxAgeMs: params.maxAgeMs,
  };
}

async function createHttpInstance(params: {
  pluginId: string;
  installationId: string;
  pluginSlug: string;
  orgSlug: string;
  transport: string;
  entryPoint: string;
  scope: string;
  scopeId: string;
  config: Record<string, unknown>;
  workspaceId?: string;
  idleTtlMs?: number;
  maxAgeMs?: number;
}, key: string, configHash: string): Promise<McpInstance> {
  const apiKey = params.config.apiKey as string;
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const client = new McpHttpClient(params.entryPoint, headers);

  // Initialize the MCP connection
  try {
    const initResult = await client.initialize();

    logEvent({
      workspaceId: params.workspaceId,
      pluginId: params.pluginId,
      eventType: 'connection.init',
      eventData: { endpoint: params.entryPoint, success: true, serverInfo: initResult.serverInfo },
    });
  } catch (error: any) {
    logEvent({
      workspaceId: params.workspaceId,
      pluginId: params.pluginId,
      eventType: 'connection.error',
      eventData: { endpoint: params.entryPoint, error: error.message },
    });
    throw error;
  }

  // Discover tools from the MCP server
  let tools: ToolDefinition[];
  try {
    tools = await client.listTools();
  } catch {
    // Fallback to stored manifest if tools/list fails
    tools = [];
  }

  return {
    pluginId: params.pluginId,
    installationId: params.installationId,
    pluginSlug: params.pluginSlug,
    orgSlug: params.orgSlug,
    transport: 'http',
    scope: params.scope,
    scopeId: params.scopeId,
    workspaceId: params.workspaceId,
    configHash,
    tools,
    execute: async (toolName, input) => client.callTool(toolName, input),
    shutdown: async () => {
      await client.shutdown();
      instanceCache.delete(key);
      clearTTLTimer(key);
    },
    lastUsed: Date.now(),
    createdAt: Date.now(),
    idleTtlMs: params.idleTtlMs ?? getTTLForScope(params.scope),
    maxAgeMs: params.maxAgeMs,
  };
}

async function createStdioInstance(params: {
  pluginId: string;
  installationId: string;
  pluginSlug: string;
  orgSlug: string;
  transport: string;
  entryPoint: string;
  scope: string;
  scopeId: string;
  config: Record<string, unknown>;
  workspaceId?: string;
  idleTtlMs?: number;
  maxAgeMs?: number;
}, key: string, configHash: string): Promise<McpInstance> {
  const client = new McpStdioClient(params.entryPoint, params.config, key);

  try {
    const initResult = await client.initialize();

    logEvent({
      workspaceId: params.workspaceId,
      pluginId: params.pluginId,
      eventType: 'connection.init',
      eventData: { endpoint: params.entryPoint, success: true, serverInfo: initResult.serverInfo, transport: 'stdio' },
    });
  } catch (error: any) {
    logEvent({
      workspaceId: params.workspaceId,
      pluginId: params.pluginId,
      eventType: 'connection.error',
      eventData: { endpoint: params.entryPoint, error: error.message, transport: 'stdio' },
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
    transport: 'stdio',
    scope: params.scope,
    scopeId: params.scopeId,
    workspaceId: params.workspaceId,
    configHash,
    tools,
    execute: async (toolName, input) => client.callTool(toolName, input),
    shutdown: async () => {
      await client.shutdown();
      instanceCache.delete(key);
      clearTTLTimer(key);
    },
    lastUsed: Date.now(),
    createdAt: Date.now(),
    idleTtlMs: params.idleTtlMs ?? getTTLForScope(params.scope),
    maxAgeMs: params.maxAgeMs,
  };
}

function getTTLForScope(scope: string): number {
  switch (scope) {
    case 'workspace': return MCP_INSTANCE_TTL_WORKSPACE;
    case 'conversation': return MCP_INSTANCE_TTL_CONV;
    case 'actor': return MCP_INSTANCE_TTL_ACTOR;
    case 'actor_global': return MCP_INSTANCE_TTL_ACTOR;
    case 'actor_conversation': return MCP_INSTANCE_TTL_ACTOR_CONV;
    case 'turn': return MCP_INSTANCE_TTL_TURN;
    default: return MCP_INSTANCE_TTL_CONV;
  }
}

function resetTTL(key: string, ttl: number) {
  clearTTLTimer(key);

  const timer = setTimeout(() => {
    const instance = instanceCache.get(key);
    if (instance) {
      // Check if it was used recently
      if (Date.now() - instance.lastUsed > ttl) {
        instance.shutdown().catch(() => {});
        instanceCache.delete(key);
        clearTTLTimer(key);
        logEvent({
          pluginId: instance.pluginId,
          eventType: 'instance.shutdown',
          eventData: { pluginSlug: instance.pluginSlug, reason: 'ttl_expired', scope: instance.scope, durationSec: Math.round((Date.now() - instance.createdAt) / 1000) },
        });
      } else {
        // Still in use, reset timer
        resetTTL(key, ttl);
      }
    }
  }, ttl);
  ttlTimers.set(key, timer);
}

function clearTTLTimer(key: string) {
  const timer = ttlTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    ttlTimers.delete(key);
  }
}

/**
 * Shutdown all turn-scoped instances that were created while processing a session.
 * Turn-scoped instances use owner keys prefixed with `session:${sessionId}:`.
 */
export async function shutdownSessionInstances(sessionId: string) {
  const keysToRemove: string[] = [];
  for (const [key, instance] of instanceCache) {
    if (instance.scope === 'turn' && instance.scopeId.startsWith(`session:${sessionId}:`)) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) {
    const instance = instanceCache.get(key);
    if (instance) {
      await instance.shutdown().catch(() => {});
      instanceCache.delete(key);
      clearTTLTimer(key);
      logEvent({
        pluginId: instance.pluginId,
        eventType: 'instance.shutdown',
        eventData: { pluginSlug: instance.pluginSlug, reason: 'session_terminated', durationSec: Math.round((Date.now() - instance.createdAt) / 1000) },
      });
    }
  }
}

/**
 * Increment the MCP version counter for a workspace.
 * Sessions compare this to their last-seen version to know when to refresh tools.
 */
export async function incrementMcpVersion(workspaceId: string): Promise<void> {
  await redis.incr(`${MCP_VERSION_KEY_PREFIX}${workspaceId}`);
}

/**
 * Get the current MCP version counter for a workspace.
 */
export async function getMcpVersion(workspaceId: string): Promise<number> {
  const val = await redis.get(`${MCP_VERSION_KEY_PREFIX}${workspaceId}`);
  return val ? parseInt(val, 10) : 0;
}

/**
 * Handle config change: bump version counter instead of immediately shutting down instances.
 * Old instances with stale configHash won't be reused by getOrCreateInstance (different key).
 * They'll TTL out or get cleaned when sessions end.
 */
export async function restartInstancesForConfig(pluginId: string, workspaceId?: string) {
  if (workspaceId) {
    await incrementMcpVersion(workspaceId);
  }
  logEvent({
    workspaceId,
    pluginId,
    eventType: 'instance.restart',
    eventData: { reason: 'config_changed_version_bumped' },
  });
}

/**
 * Shutdown all instances (called on process termination)
 */
export async function shutdownAllInstances() {
  const promises: Promise<void>[] = [];
  for (const [, instance] of instanceCache) {
    promises.push(instance.shutdown());
  }
  await Promise.allSettled(promises);
  instanceCache.clear();
  for (const timer of ttlTimers.values()) {
    clearTimeout(timer);
  }
  ttlTimers.clear();
}

// Listen for config changes via event bus.
// Note: version counter is now bumped directly by service.ts functions (install/uninstall/update).
// This listener is kept for any external emitters but avoids double-bumping from our own service calls.
export function initInstanceManagerListeners() {
  // No-op — version bumps are handled directly by service layer.
  // Event is still emitted for WebSocket frontend notifications (backward compat).
}
