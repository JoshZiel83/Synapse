import { redis } from "../../infrastructure/redis/index.js";

const MCP_VERSION_KEY_PREFIX = "mcp:v:";

export async function incrementMcpVersion(workspaceId: string): Promise<void> {
  await redis.incr(`${MCP_VERSION_KEY_PREFIX}${workspaceId}`);
}

export async function getMcpVersion(workspaceId: string): Promise<number> {
  const val = await redis.get(`${MCP_VERSION_KEY_PREFIX}${workspaceId}`);
  return val ? parseInt(val, 10) : 0;
}
