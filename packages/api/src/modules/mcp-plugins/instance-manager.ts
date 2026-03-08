import { createHash } from 'crypto';
import { ToolDefinition } from '@synapse/shared';
import { redis } from '../../infrastructure/redis/index.js';

const MCP_VERSION_KEY_PREFIX = 'mcp:v:';
const MCP_INSTANCE_TTL_ACTOR = 30 * 60 * 1000;    // 30 minutes
const MCP_INSTANCE_TTL_USER = 30 * 60 * 1000;     // 30 minutes
const MCP_INSTANCE_TTL_WORKSPACE = 60 * 60 * 1000; // 60 minutes
import { McpHttpClient } from './mcp-client.js';
import { getBuiltinHandler } from './builtin/index.js';
import { logEvent } from './audit.js';

export interface McpInstance {
  pluginId: string;
  pluginSlug: string;
  orgSlug: string;
  transport: string;
  scope: string;
  scopeId: string;
  workspaceId?: string;
  configHash: string;
  tools: ToolDefinition[];
  execute: (toolName: string, input: Record<string, unknown>) => Promise<string>;
  shutdown: () => Promise<void>;
  lastUsed: number;
  createdAt: number;
}

// In-memory cache: key = pluginId:scope:scopeId:configHash
const instanceCache = new Map<string, McpInstance>();
const ttlTimers = new Map<string, NodeJS.Timeout>();

function computeConfigHash(config: Record<string, unknown>): string {
  const json = JSON.stringify(config, Object.keys(config).sort());
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function buildInstanceKey(pluginId: string, scope: string, scopeId: string, configHash: string): string {
  return `${pluginId}:${scope}:${scopeId}:${configHash}`;
}

/**
 * Get or create an MCP instance for the given plugin + scope + config
 */
export async function getOrCreateInstance(params: {
  pluginId: string;
  pluginSlug: string;
  orgSlug: string;
  transport: string;
  entryPoint: string;
  scope: string;
  scopeId: string;
  config: Record<string, unknown>;
  workspaceId?: string;
}): Promise<McpInstance> {
  const configHash = computeConfigHash(params.config);
  const key = buildInstanceKey(params.pluginId, params.scope, params.scopeId, configHash);

  // Return cached instance if exists
  const cached = instanceCache.get(key);
  if (cached) {
    cached.lastUsed = Date.now();
    resetTTL(key, params.scope);
    return cached;
  }

  // Create new instance based on transport
  let instance: McpInstance;

  if (params.transport === 'builtin') {
    instance = await createBuiltinInstance(params, key, configHash);
  } else if (params.transport === 'http') {
    instance = await createHttpInstance(params, key, configHash);
  } else {
    throw new Error(`Unsupported transport: ${params.transport}`);
  }

  instanceCache.set(key, instance);
  resetTTL(key, params.scope);

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
  pluginSlug: string;
  orgSlug: string;
  transport: string;
  entryPoint: string;
  scope: string;
  scopeId: string;
  config: Record<string, unknown>;
  workspaceId?: string;
}, key: string, configHash: string): Promise<McpInstance> {
  const handler = getBuiltinHandler(params.entryPoint);
  if (!handler) {
    throw new Error(`No builtin handler found for: ${params.entryPoint}`);
  }

  const tools = handler.getTools();

  return {
    pluginId: params.pluginId,
    pluginSlug: params.pluginSlug,
    orgSlug: params.orgSlug,
    transport: 'builtin',
    scope: params.scope,
    scopeId: params.scopeId,
    workspaceId: params.workspaceId,
    configHash,
    tools,
    execute: async (toolName, input) => handler.execute(toolName, input, params.config),
    shutdown: async () => {
      instanceCache.delete(key);
      clearTTLTimer(key);
    },
    lastUsed: Date.now(),
    createdAt: Date.now(),
  };
}

async function createHttpInstance(params: {
  pluginId: string;
  pluginSlug: string;
  orgSlug: string;
  transport: string;
  entryPoint: string;
  scope: string;
  scopeId: string;
  config: Record<string, unknown>;
  workspaceId?: string;
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
  };
}

function resetTTL(key: string, scope: string) {
  clearTTLTimer(key);

  // Session scope: no TTL (cleaned up in finally block)
  if (scope === 'actor' || scope === 'user' || scope === 'workspace') {
    const ttl = scope === 'workspace' ? MCP_INSTANCE_TTL_WORKSPACE : scope === 'user' ? MCP_INSTANCE_TTL_USER : MCP_INSTANCE_TTL_ACTOR;
    const timer = setTimeout(() => {
      const instance = instanceCache.get(key);
      if (instance) {
        // Check if it was used recently
        if (Date.now() - instance.lastUsed > ttl) {
          instance.shutdown().catch(() => {});
          logEvent({
            pluginId: instance.pluginId,
            eventType: 'instance.shutdown',
            eventData: { pluginSlug: instance.pluginSlug, reason: 'ttl_expired', durationSec: Math.round((Date.now() - instance.createdAt) / 1000) },
          });
        } else {
          // Still in use, reset timer
          resetTTL(key, scope);
        }
      }
    }, ttl);
    ttlTimers.set(key, timer);
  }
}

function clearTTLTimer(key: string) {
  const timer = ttlTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    ttlTimers.delete(key);
  }
}

/**
 * Shutdown a specific session-scoped instance
 */
export async function shutdownSessionInstance(key: string) {
  const instance = instanceCache.get(key);
  if (instance) {
    await instance.shutdown();
    logEvent({
      pluginId: instance.pluginId,
      eventType: 'instance.shutdown',
      eventData: { pluginSlug: instance.pluginSlug, reason: 'session_complete', durationSec: Math.round((Date.now() - instance.createdAt) / 1000) },
    });
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

// Cleanup on process exit
process.on('SIGTERM', () => {
  shutdownAllInstances().catch(() => {});
});

process.on('SIGINT', () => {
  shutdownAllInstances().catch(() => {});
});
