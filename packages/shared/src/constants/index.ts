export const APP_NAME = 'Synapse';
export const API_VERSION = 'v1';
export const API_PREFIX = `/api/${API_VERSION}`;

export const JWT_ACCESS_EXPIRY = '15m';
export const JWT_REFRESH_EXPIRY = '7d';
export const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const ACTOR_LOCK_TTL = 60_000; // 60 seconds
export const ACTOR_THINK_TIMEOUT = 120_000; // 2 minutes
export const SESSION_LOCK_TTL = 120_000; // 120 seconds
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 3;

export const MEMORY_EMBEDDING_DIMENSIONS = 1536;

export const WORK_ITEM_PRIORITIES_ORDER = ['low', 'medium', 'high', 'urgent'] as const;

export const REDIS_CHANNELS = {
  EVENTS: 'synapse:events',
  WORKSPACE_PREFIX: 'synapse:ws:',
  ACTOR_LOCK_PREFIX: 'synapse:actor:lock:',
  SESSION_LOCK_PREFIX: 'synapse:session:lock:',
  ACTOR_SESSIONS_PREFIX: 'synapse:actor:sessions:',
} as const;

export const QUEUE_NAMES = {
  ACTOR_THINKING: 'actor-thinking',
  SESSION_THINKING: 'session-thinking',
  SESSION_TIMEOUT: 'session-timeout',
  STANDING_ORDERS: 'standing-orders',
} as const;

export const WS_AUTH_TIMEOUT = 5000;
export const WS_HEARTBEAT_INTERVAL = 30000;

// MCP Plugin Marketplace
export const MCP_BUILTIN_ORG_SLUG = 'z_ai';
export const MCP_TOOL_NAMESPACE_SEPARATOR = '__';
export const MCP_INSTANCE_TTL = {
  actor: 30 * 60 * 1000,    // 30 minutes
  workspace: 60 * 60 * 1000, // 60 minutes
} as const;

// MCP Relay
export const RELAY_PROTOCOL_VERSION = 2 as const;
export const RELAY_AUTH_TIMEOUT = 5000;
export const RELAY_HEARTBEAT_INTERVAL = 30000;
export const RELAY_TOOL_CALL_TIMEOUT = 30000;
export const RELAY_PAIRING_TTL_MS = 10 * 60 * 1000;
export const RELAY_DELIVERY_ACK_TIMEOUT_MS = 15 * 1000;
export const RELAY_OPERATION_TTL_MS = 5 * 60 * 1000;

// A2A Protocol
export const A2A_PROTOCOL_VERSION = '0.3';
export const A2A_API_KEY_HEADER = 'x-api-key';
export const A2A_DEFAULT_RATE_LIMIT = 60;
