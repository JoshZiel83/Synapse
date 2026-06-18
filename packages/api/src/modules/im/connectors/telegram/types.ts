/**
 * Telegram Bot API constant + type vocabulary.
 *
 * Centralized so:
 *   - connector files import names instead of magic strings/numbers,
 *   - the cloud size caps + the API host live in one place,
 *   - tests reference the same constants the runtime uses.
 *
 * The Update/Message/PhotoSize/... interfaces are intentionally MINIMAL —
 * just the fields the connector reads. Anything else stays on the raw
 * object (we stash whole raw payloads in `.original` for the side-effecting
 * enrich pass).
 */

// ───────────────────────── Hosts ─────────────────────────

/** Default Bot API host. A self-hosted (local) Bot API server overrides this. */
export const TELEGRAM_API_ROOT = "https://api.telegram.org"

/** Build the method URL: `<root>/bot<token>/<method>`. */
export function telegramMethodUrl(
  apiRoot: string,
  token: string,
  method: string
): string {
  return `${apiRoot}/bot${token}/${method}`
}

/** Build the (unauthenticated) file-download URL: `<root>/file/bot<token>/<file_path>`. */
export function telegramFileUrl(
  apiRoot: string,
  token: string,
  filePath: string
): string {
  return `${apiRoot}/file/bot${token}/${filePath}`
}

// ───────────────────────── Size caps (cloud) ─────────────────────────

/** getFile download cap on the public cloud Bot API. */
export const TELEGRAM_CLOUD_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024 // 20 MB
/** Multipart upload-on-send cap on the public cloud Bot API. */
export const TELEGRAM_CLOUD_UPLOAD_MAX_BYTES = 50 * 1024 * 1024 // 50 MB

// ───────────────────────── Text limits ─────────────────────────

/** Max length of a text message body, in UTF-16 code units. */
export const TELEGRAM_MAX_TEXT_LENGTH = 4096
/** Max length of a media caption, in UTF-16 code units. */
export const TELEGRAM_MAX_CAPTION_LENGTH = 1024

// ───────────────────────── Long-poll tuning ─────────────────────────

/** getUpdates long-poll timeout (seconds the server holds the request open). */
export const TELEGRAM_LONG_POLL_TIMEOUT_SEC = 30
/** Max updates per getUpdates batch. */
export const TELEGRAM_GET_UPDATES_LIMIT = 100
/**
 * `allowed_updates` is STICKY: an empty list yields all types EXCEPT
 * `chat_member` / `message_reaction` / `message_reaction_count`. We send
 * this explicit list on the FIRST poll so reactions + membership land.
 */
export const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "channel_post",
  "message_reaction",
  "chat_member",
  "my_chat_member",
] as const

// ───────────────────────── Error codes ─────────────────────────

/**
 * Bot API `error_code` values the connector branches on. 401/409 are FATAL
 * for the poll loop (bad token / another getUpdates holder); 429 carries
 * `parameters.retry_after`; 5xx + network are retryable.
 */
export const TELEGRAM_ERROR_CODE = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
} as const

// ───────────────────────── Wire types (minimal) ─────────────────────────

export interface TelegramApiResponse<T> {
  ok: boolean
  result?: T
  error_code?: number
  description?: string
  parameters?: { retry_after?: number; migrate_to_chat_id?: number }
}

export interface TelegramUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

export interface TelegramChat {
  id: number
  type: "private" | "group" | "supergroup" | "channel"
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

export interface TelegramPhotoSize {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

export interface TelegramFileMeta {
  file_id: string
  file_unique_id: string
  file_size?: number
  mime_type?: string
  file_name?: string
  duration?: number
  width?: number
  height?: number
  thumbnail?: TelegramPhotoSize
}

export interface TelegramMessageEntity {
  type: string
  offset: number
  length: number
  url?: string
  user?: TelegramUser
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  date: number
  chat: TelegramChat
  text?: string
  caption?: string
  entities?: TelegramMessageEntity[]
  caption_entities?: TelegramMessageEntity[]
  reply_to_message?: TelegramMessage
  photo?: TelegramPhotoSize[]
  voice?: TelegramFileMeta
  audio?: TelegramFileMeta
  video?: TelegramFileMeta
  video_note?: TelegramFileMeta & { length?: number }
  document?: TelegramFileMeta
  animation?: TelegramFileMeta
  sticker?: TelegramFileMeta & { is_animated?: boolean; is_video?: boolean }
}

export interface TelegramMessageReactionUpdated {
  chat: TelegramChat
  message_id: number
  user?: TelegramUser
  date: number
  new_reaction?: Array<{ type: string; emoji?: string }>
  old_reaction?: Array<{ type: string; emoji?: string }>
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  channel_post?: TelegramMessage
  message_reaction?: TelegramMessageReactionUpdated
  // chat_member / my_chat_member intentionally untyped — logged at debug only.
  [key: string]: unknown
}

/** `getFile` result. */
export interface TelegramFile {
  file_id: string
  file_unique_id: string
  file_size?: number
  file_path?: string
}

/** `getMe` result (controller probe). */
export interface TelegramBotInfo {
  id: number
  is_bot: boolean
  first_name: string
  username?: string
}
