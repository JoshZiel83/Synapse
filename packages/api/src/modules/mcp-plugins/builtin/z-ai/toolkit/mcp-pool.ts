import { McpHttpClient } from '../../../mcp-client.js';
import { ToolDefinition } from '@synapse/shared';

interface PoolEntry {
  client: McpHttpClient;
  lastUsed: number;
  initialized: boolean;
  initPromise?: Promise<McpHttpClient>;
}

const pool = new Map<string, PoolEntry>();
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

let cleanupTimer: NodeJS.Timeout | null = null;

function startCleanupTimer(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of pool) {
      if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
        entry.client.shutdown().catch(() => {});
        pool.delete(key);
      }
    }
    if (pool.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, 60_000);
  cleanupTimer.unref();
}

function poolKey(endpoint: string, apiKey: string): string {
  return `${endpoint}::${apiKey}`;
}

export async function getOrCreateMcpClient(
  endpoint: string,
  apiKey: string,
): Promise<McpHttpClient> {
  const key = poolKey(endpoint, apiKey);
  const existing = pool.get(key);
  if (existing && existing.initialized) {
    existing.lastUsed = Date.now();
    return existing.client;
  }
  // If another caller is already initializing, wait for its result
  if (existing && existing.initPromise) {
    return existing.initPromise;
  }

  const client = new McpHttpClient(endpoint, {
    'Authorization': `Bearer ${apiKey}`,
  });

  const entry: PoolEntry = { client, lastUsed: Date.now(), initialized: false };

  // Store the initialization promise to prevent concurrent init
  entry.initPromise = (async () => {
    try {
      await client.initialize();
      entry.initialized = true;
      entry.initPromise = undefined;
      startCleanupTimer();
      return client;
    } catch (err) {
      pool.delete(key);
      throw err;
    }
  })();

  pool.set(key, entry);
  return entry.initPromise;
}

export async function discoverTools(
  endpoint: string,
  apiKey: string,
  fallback: ToolDefinition[],
): Promise<ToolDefinition[]> {
  try {
    const client = await getOrCreateMcpClient(endpoint, apiKey);
    const tools = await client.listTools();
    return tools.length > 0 ? tools : fallback;
  } catch {
    return fallback;
  }
}

export async function callMcpTool(
  endpoint: string,
  apiKey: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<string> {
  const client = await getOrCreateMcpClient(endpoint, apiKey);
  return client.callTool(toolName, input);
}
