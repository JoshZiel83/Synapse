/**
 * Personal-WeChat (ilink) protocol constants + shared request builders.
 *
 * Header names, magic enum values, the X-WECHAT-UIN scheme and the
 * iLink-App-Id / iLink-App-ClientVersion headers are transcribed verbatim
 * from the canonical upstream plugin `@tencent-weixin/openclaw-weixin`
 * (author: Tencent). See docs/weixin-ilink-integration-audit.md.
 *
 * IMPORTANT: do NOT "simplify" `randomWechatUin` — the random-uint32 scheme
 * matches upstream byte-for-byte and is intentional.
 */

import crypto from "node:crypto"

// ---------------------------------------------------------------------------
// Wire enums (proto-mirrored; values are load-bearing magic numbers)
// ---------------------------------------------------------------------------

/** WeixinMessage.message_type */
export const WEIXIN_MESSAGE_TYPE = { NONE: 0, USER: 1, BOT: 2 } as const

/** WeixinMessage.message_state */
export const WEIXIN_MESSAGE_STATE = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const

/** MessageItem.type (inbound + outbound item kinds). */
export const WEIXIN_ITEM_TYPE = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const

/**
 * getuploadurl `media_type` — DISTINCT numbering from WEIXIN_ITEM_TYPE.
 * (IMAGE=1, VIDEO=2, FILE=3, VOICE=4)
 */
export const WEIXIN_UPLOAD_MEDIA_TYPE = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const

/** sendtyping status: 1 = typing (begin), 2 = cancel. */
export const WEIXIN_TYPING_STATUS = { TYPING: 1, CANCEL: 2 } as const

/**
 * getupdates errcode meaning the bot session has expired and the account must
 * be re-authenticated (re-scan QR). Upstream pauses the account on this code
 * rather than hot-looping retries.
 */
export const WEIXIN_SESSION_EXPIRED_ERRCODE = -14

// ---------------------------------------------------------------------------
// Endpoint paths
// ---------------------------------------------------------------------------

export const WEIXIN_ENDPOINTS = {
  GET_UPDATES: "ilink/bot/getupdates",
  SEND_MESSAGE: "ilink/bot/sendmessage",
  SEND_TYPING: "ilink/bot/sendtyping",
  GET_CONFIG: "ilink/bot/getconfig",
  GET_UPLOAD_URL: "ilink/bot/getuploadurl",
  NOTIFY_START: "ilink/bot/msg/notifystart",
  NOTIFY_STOP: "ilink/bot/msg/notifystop",
  GET_BOT_QRCODE: "ilink/bot/get_bot_qrcode",
  GET_QRCODE_STATUS: "ilink/bot/get_qrcode_status",
} as const

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/**
 * iLink-App-Id. Upstream reads `package.json` top-level `ilink_appid`, whose
 * value is the constant string "bot".
 */
export const ILINK_APP_ID = "bot"

/**
 * Client version string we advertise. Mirrors a known-good upstream client
 * version so the gateway does not treat us as an outdated client.
 */
const ILINK_CLIENT_VERSION_STRING = "2.4.4"

/**
 * iLink-App-ClientVersion encoding: uint32 = (major<<16) | (minor<<8) | patch,
 * high byte fixed to 0. e.g. "1.0.11" -> 0x0001000B = 65547.
 */
export function encodeIlinkClientVersion(version: string): number {
  const parts = version.split(".").map((p) => parseInt(p, 10) || 0)
  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  const patch = parts[2] ?? 0
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

export const ILINK_APP_CLIENT_VERSION = String(
  encodeIlinkClientVersion(ILINK_CLIENT_VERSION_STRING)
)

/**
 * Headers shared by every ilink request (GET + POST), independent of auth.
 * The previous implementation omitted these entirely on POST and hard-coded a
 * malformed `iLink-App-ClientVersion: "1"` on a single QR call.
 */
export function buildIlinkCommonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
  }
}

/** X-WECHAT-UIN: random uint32 -> decimal string -> base64. Verbatim upstream. */
export function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), "utf8").toString("base64")
}

// ---------------------------------------------------------------------------
// base_info — attached to every CGI request body
// ---------------------------------------------------------------------------

/** Observability-only channel version reported in base_info.channel_version. */
const CHANNEL_VERSION = "synapse-weixin/1.0.0"

/**
 * Self-declared identity (UA-style), observability-only — not used by the
 * gateway for auth or routing.
 */
const BOT_AGENT = "Synapse"

export interface WeixinBaseInfo {
  channel_version: string
  bot_agent: string
}

/** Build the base_info object included in every request body. */
export function buildWeixinBaseInfo(): WeixinBaseInfo {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT }
}
