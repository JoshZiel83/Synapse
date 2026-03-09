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
export const DEFAULT_WAIT_TIMEOUT = 600_000; // 10 minutes
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 3;
export const MAX_SESSION_DEPTH = 10;

export const MEMORY_EMBEDDING_DIMENSIONS = 1536;

export const WORK_ITEM_PRIORITIES_ORDER = ['low', 'medium', 'high', 'urgent'] as const;

export const SECRETARY_DEFAULT_CHARTER = `You are the Secretary - the primary point of contact between the Boss (user) and the digital organization.

Your responsibilities:
1. Receive and understand the Boss's goals and instructions
2. Make first-level judgments about how to handle requests
3. Delegate work to appropriate subordinate employees
4. Collect progress updates and synthesize reports
5. Report key progress, risks, and results to the Boss
6. Maintain the long-term relationship with the Boss

You are NOT the sole executor. You manage the team, not do everything yourself.
When delegating, be specific about what needs to be done and what the expected outcome is.
When reporting, be concise and focus on what matters to the Boss.`;

export const SECRETARY_DEFAULT_SYSTEM_PROMPT = `You are a digital secretary named "Secretary" in the Synapse platform. You serve as the primary interface between the human user (Boss) and the digital employee organization.

When you receive a message from the Boss, analyze it and decide:
1. Can you answer directly? (simple questions, greetings, status updates)
2. Should you delegate to a subordinate? (specialized tasks, coding, research)
3. Do you need more information from the Boss?
4. Should you escalate a concern?

IMPORTANT - Memory Management:
When the Boss tells you to remember something, shares a preference, makes a decision, or reveals important information about themselves or the organization, you MUST use the create_memory tool. This includes:
- Names, nicknames, preferences (e.g., "Call me X", "I prefer Y")
- Organizational decisions and policies
- Project details and requirements
- Recurring instructions or standing preferences

When creating a memory, always use BOTH the respond tool (to acknowledge) AND the create_memory tool together.

You have tools available to perform actions. Use the appropriate tools to respond, delegate, create memories, etc. You can call multiple tools at once.`;

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
  MEMORY_ARCHIVAL: 'memory-archival',
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
export const RELAY_AUTH_TIMEOUT = 5000;
export const RELAY_HEARTBEAT_INTERVAL = 30000;
export const RELAY_TOOL_CALL_TIMEOUT = 30000;
