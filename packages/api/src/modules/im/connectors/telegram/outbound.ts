/**
 * Telegram outbound — sendMessage.
 *
 * Flow: `degradeForCapabilities` → `planTelegramSends` → execute each item
 * in order (reply only on the first) → return `{ externalMessageId }` for the
 * FIRST sent item (the message the agent "is" in the conversation).
 *
 * Error taxonomy (plan §3.6):
 *   - `migrate_to_chat_id` (group→supergroup): swap chat_id + retry once.
 *   - 429: honor `parameters.retry_after` → RetryableTransportError.
 *   - 5xx / network: RetryableTransportError (bare-ish; worker retries).
 *   - 4xx business (chat not found / blocked / file too big): PermanentTransportError
 *     `{code:"telegram_<n>"}`.
 */

import {
  PermanentTransportError,
  RetryableTransportError,
  type OutboundSendInput,
  type OutboundSendResult,
} from "../types.js"
import { degradeForCapabilities } from "../../messaging/degradation.js"
import { TELEGRAM_MESSAGE_CAPABILITIES } from "./capabilities.js"
import { callMethod, callMethodMultipart, TelegramApiError } from "./client.js"
import { getTelegramCredentialsOrThrow } from "./credentials.js"
import { planTelegramSends, type TelegramSendItem } from "./render.js"
import {
  preparePhotoUpload,
  prepareVideoUpload,
  prepareVoiceUpload,
  prepareDocumentUpload,
} from "./media-upload.js"
import { TELEGRAM_ERROR_CODE, type TelegramMessage } from "./types.js"
import type { TelegramCredentials } from "./credentials.js"

interface SendContext {
  creds: TelegramCredentials
  chatId: string
  replyToMessageId?: number
}

/** Map a TelegramApiError to the worker's retry/permanent taxonomy and throw. */
function throwClassified(err: TelegramApiError): never {
  const code = err.errorCode
  if (code === TELEGRAM_ERROR_CODE.TOO_MANY_REQUESTS) {
    throw new RetryableTransportError(
      `telegram 429${err.retryAfter ? ` (retry_after=${err.retryAfter}s)` : ""}: ${err.description}`,
      { cause: err }
    )
  }
  if (code >= 500) {
    throw new RetryableTransportError(`telegram ${code}: ${err.description}`, {
      cause: err,
    })
  }
  // 4xx business → permanent.
  throw new PermanentTransportError(`telegram ${code}: ${err.description}`, {
    code: `telegram_${code}`,
    cause: err,
  })
}

/** Execute a single planned item, returning the sent message_id. */
async function executeItem(
  ctx: SendContext,
  item: TelegramSendItem,
  isFirst: boolean
): Promise<number> {
  const replyFields =
    isFirst && ctx.replyToMessageId
      ? {
          reply_parameters: JSON.stringify({
            message_id: ctx.replyToMessageId,
          }),
        }
      : {}
  const replyJson =
    isFirst && ctx.replyToMessageId
      ? { reply_parameters: { message_id: ctx.replyToMessageId } }
      : {}

  if (item.kind === "text") {
    const msg = await callMethod<TelegramMessage>(ctx.creds, "sendMessage", {
      chat_id: ctx.chatId,
      text: item.html,
      parse_mode: "HTML",
      ...replyJson,
    })
    return msg.message_id
  }

  // Media items go through multipart upload.
  const prepared = await prepareForItem(item)
  const msg = await callMethodMultipart<TelegramMessage>(
    ctx.creds,
    prepared.method,
    {
      chat_id: ctx.chatId,
      caption: item.caption,
      ...prepared.extraFields,
      ...replyFields,
    },
    [
      {
        field: prepared.fileField,
        filename: prepared.filename,
        buffer: prepared.buffer,
        contentType: prepared.contentType,
      },
    ]
  )
  return msg.message_id
}

async function prepareForItem(item: TelegramSendItem) {
  switch (item.kind) {
    case "photo":
      return preparePhotoUpload(item.fileRef)
    case "voice":
      return prepareVoiceUpload(item.fileRef, { durationSec: item.durationSec })
    case "video":
      return prepareVideoUpload(item.fileRef, {
        durationSec: item.durationSec,
        width: item.width,
        height: item.height,
      })
    case "document":
      return prepareDocumentUpload(item.fileRef)
    case "text":
      // unreachable — text is handled before prepareForItem
      throw new Error("text item routed to prepareForItem")
  }
}

export async function sendTelegramMessage(
  input: OutboundSendInput
): Promise<OutboundSendResult> {
  const creds = getTelegramCredentialsOrThrow(input.account)

  // 1. Degrade to Telegram's capability envelope FIRST.
  const degraded = degradeForCapabilities(
    input.message,
    TELEGRAM_MESSAGE_CAPABILITIES
  )

  // 2. Plan ordered sends.
  const plan = planTelegramSends(degraded)
  if (plan.length === 0) {
    throw new PermanentTransportError(
      "telegram: refusing to send empty message",
      { code: "telegram_empty_message" }
    )
  }

  let chatId = input.endpoint.externalId
  const replyToMessageId = input.replyTo
    ? Number.parseInt(input.replyTo.externalMessageId, 10)
    : undefined
  const ctx: SendContext = {
    creds,
    chatId,
    ...(replyToMessageId && Number.isFinite(replyToMessageId)
      ? { replyToMessageId }
      : {}),
  }

  let firstMessageId: number | undefined
  for (let i = 0; i < plan.length; i++) {
    const item = plan[i]!
    try {
      const id = await executeItem(ctx, item, i === 0)
      if (firstMessageId === undefined) firstMessageId = id
    } catch (err) {
      // migrate_to_chat_id: group was upgraded to supergroup → swap + retry.
      if (
        err instanceof TelegramApiError &&
        err.migrateToChatId != null &&
        chatId !== String(err.migrateToChatId)
      ) {
        chatId = String(err.migrateToChatId)
        ctx.chatId = chatId
        const id = await retryItem(ctx, item, i === 0)
        if (firstMessageId === undefined) firstMessageId = id
        continue
      }
      if (err instanceof TelegramApiError) throwClassified(err)
      // Network/other error → retryable (bare throw lets the worker retry).
      throw new RetryableTransportError(
        `telegram send failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      )
    }
  }

  if (firstMessageId === undefined) {
    throw new PermanentTransportError(
      "telegram: no message_id returned for any send item",
      { code: "telegram_no_message_id" }
    )
  }
  return { externalMessageId: String(firstMessageId) }
}

/** Re-execute one item after a chat_id swap; classify a second failure. */
async function retryItem(
  ctx: SendContext,
  item: TelegramSendItem,
  isFirst: boolean
): Promise<number> {
  try {
    return await executeItem(ctx, item, isFirst)
  } catch (err) {
    if (err instanceof TelegramApiError) throwClassified(err)
    throw new RetryableTransportError(
      `telegram send failed after chat migration: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    )
  }
}
