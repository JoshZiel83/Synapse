/**
 * QQ open-platform constant + type vocabulary.
 *
 * Sourced from the official wiki (https://bot.q.qq.com/wiki/) and
 * cross-checked against `tencent-connect/openclaw-qqbot/src/api.ts`.
 * Centralized here so:
 *   - connector files import names instead of magic numbers
 *   - upgrade-time changes to msg_type / opcode / close codes live in
 *     one place
 *   - tests can reference the same constants the runtime uses
 */

// ───────────────────────── HTTP / Token ─────────────────────────

/** Base URL for the OpenAPI surface (messages, files, gateway, …). */
export const QQ_API_BASE = "https://api.sgroup.qq.com"
/** Token endpoint, distinct from the OpenAPI host. */
export const QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"

/**
 * Default access_token TTL hint. The server may return a different
 * `expires_in`; we cache against that value, this only seeds the
 * "refresh ahead of time" arithmetic.
 */
export const QQ_DEFAULT_TOKEN_TTL_SECONDS = 7200

// ───────────────────────── Message type ─────────────────────────

/**
 * `msg_type` field on POST .../messages requests + INTERACTION_CREATE
 * delivery. See QQ wiki "消息收发 → 发送消息".
 */
export const QQ_MSG_TYPE = {
  TEXT: 0,
  MARKDOWN: 2,
  ARK: 3,
  EMBED: 4,
  MEDIA: 7,
} as const
export type QqMsgType = (typeof QQ_MSG_TYPE)[keyof typeof QQ_MSG_TYPE]

/**
 * `message_type` field on incoming messages — flags the body as a
 * quoted/reference message when set to 103.
 */
export const QQ_INCOMING_MESSAGE_TYPE_QUOTE = 103

// ───────────────────────── WebSocket ────────────────────────────

/**
 * Gateway opcodes. Sourced from wiki "事件订阅与通知". Used by both
 * webhook (op 0 dispatch / op 13 URL verification) and the
 * long-connection gateway client.
 */
export const QQ_OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
  /** Webhook ACK (server expects {op:12} on the response body). */
  HTTP_CALLBACK_ACK: 12,
  /** Webhook URL-verification challenge. */
  WEBHOOK_VERIFY: 13,
} as const
export type QqOp = (typeof QQ_OP)[keyof typeof QQ_OP]

/**
 * Intents bitmask values. We use a fixed subset in v1 (no Guild/Forum/
 * Audio); other bits are listed here so the constant table stays
 * complete for future stages.
 */
export const QQ_INTENT = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGE: 1 << 12,
  // SDK name: botpy `public_messages` / botgo `IntentGroupMessages`.
  // Delivers group@ + C2C messages AND the lifecycle events FRIEND_ADD/DEL,
  // GROUP_ADD_ROBOT/DEL_ROBOT, *_MSG_REJECT/RECEIVE. Public guild @ is the
  // separate bit 1<<30 (PUBLIC_GUILD_MESSAGES), not this one.
  GROUP_AND_C2C_EVENT: 1 << 25,
  INTERACTION: 1 << 26,
  MESSAGE_AUDIT: 1 << 27,
  FORUMS_EVENT: 1 << 28,
  AUDIO_ACTION: 1 << 29,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
} as const

/**
 * v1 intent mask: GROUP_AND_C2C_EVENT (C2C + group @ + group robot
 * lifecycle) + INTERACTION (button callbacks for Stage 8). Excludes
 * GUILD_MESSAGE / DIRECT_MESSAGE / PUBLIC_GUILD_MESSAGES (no channel
 * support in v1) and MESSAGE_AUDIT / FORUMS / AUDIO (not in scope).
 */
export const QQ_V1_INTENTS =
  QQ_INTENT.GROUP_AND_C2C_EVENT | QQ_INTENT.INTERACTION

/**
 * WebSocket close codes. 4xxx codes from the wiki + the openclaw
 * gateway implementation. Documented here so the reconnect policy in
 * inbound-ws.ts is reviewable in one place.
 */
export const QQ_CLOSE_CODE = {
  TOKEN_INVALID: 4004,
  SESSION_INVALID: 4006,
  RESUME_SEQ_INVALID: 4007,
  RATE_LIMITED: 4008,
  SESSION_TIMEOUT: 4009,
  /** Identify sent an illegal intents bitmask (botgo 4013). */
  INVALID_INTENTS: 4013,
  /** Identify used intents the bot is not authorized for (botgo 4014). */
  DISALLOWED_INTENTS: 4014,
  BOT_OFFLINE: 4914,
  BOT_BANNED: 4915,
} as const

// ───────────────────────── Events (t field) ─────────────────────

/**
 * Dispatch event names handed back via op=0. v1 only handles a subset
 * (C2C/GROUP_AT/INTERACTION); the rest are logged at debug for
 * observability.
 */
export const QQ_EVENT = {
  READY: "READY",
  RESUMED: "RESUMED",
  C2C_MESSAGE_CREATE: "C2C_MESSAGE_CREATE",
  GROUP_AT_MESSAGE_CREATE: "GROUP_AT_MESSAGE_CREATE",
  /** Non-@ group message — v1 ignores; only here for ergonomic switch coverage. */
  GROUP_MESSAGE_CREATE: "GROUP_MESSAGE_CREATE",
  AT_MESSAGE_CREATE: "AT_MESSAGE_CREATE",
  DIRECT_MESSAGE_CREATE: "DIRECT_MESSAGE_CREATE",
  INTERACTION_CREATE: "INTERACTION_CREATE",
  FRIEND_ADD: "FRIEND_ADD",
  FRIEND_DEL: "FRIEND_DEL",
  GROUP_ADD_ROBOT: "GROUP_ADD_ROBOT",
  GROUP_DEL_ROBOT: "GROUP_DEL_ROBOT",
} as const
export type QqEventName = (typeof QQ_EVENT)[keyof typeof QQ_EVENT]
