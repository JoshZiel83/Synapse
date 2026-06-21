/**
 * Outbound: render a CanonicalMessage onto the live Baileys socket.
 *
 *   degradeForCapabilities → resolve the live socket (running-registry) →
 *   build AnyMessageContent (media bytes from CAS, voice transcode) → send →
 *   return { externalMessageId: sent.key.id }.
 *
 * Failure posture:
 *   - paused (session-guard) OR no live socket → RetryableTransportError
 *     (the runtime will retry; a reconnect/lease-handoff may make it work).
 *   - empty render / missing sha256 with no fallback → PermanentTransportError.
 *
 * `requiresRecipientAddressMetadata` stays UNSET on the connector — a JID is a
 * self-contained endpoint id, so no address-row prefetch is needed.
 */

import type { AnyMessageContent, WASocket } from "baileys"
import { createLogger } from "../../../../infrastructure/logger/index.js"
import { readContentBuffer } from "../../../../infrastructure/storage/content-store.js"
import { transcodeToOpusVoiceNote } from "../../../../infrastructure/media/transcode.js"
import { degradeForCapabilities } from "../../messaging/degradation.js"
import {
  PermanentTransportError,
  RetryableTransportError,
  type ConnectorLogger,
  type MessageRef,
  type OutboundEndpointRef,
  type OutboundSendResult,
} from "../types.js"
import type { TransportAccountSummary } from "@synapse/shared/types"
import { WHATSAPP_UNOFFICIAL_MESSAGE_CAPABILITIES } from "./capabilities.js"
import {
  buildOutboundContent,
  type ReadContentFn,
  type TranscodeVoiceFn,
} from "./media.js"
import type { CanonicalMessage } from "../../messaging/canonical-message.js"
import { getHandle } from "./running-registry.js"
import { isSessionPaused } from "./session-guard.js"
import { normalizeJid } from "./types.js"

// Root scope (mapped in SCOPE_TO_DOMAIN); component is implied by the file.
const log = createLogger("im.whatsapp_unofficial")

const moduleLogger: ConnectorLogger = {
  debug: (msg, fields) => log.debug(fields ?? {}, msg),
  info: (msg, fields) => log.info(fields ?? {}, msg),
  warn: (msg, fields) => log.warn(fields ?? {}, msg),
  error: (msg, err, fields) => log.error({ err, ...(fields ?? {}) }, msg),
}

export interface SendWhatsappInput {
  account: TransportAccountSummary
  endpoint: OutboundEndpointRef
  message: CanonicalMessage
  replyTo?: MessageRef
  logger?: ConnectorLogger
}

export interface SendWhatsappDeps {
  /** Resolve the live socket for the account (default: running-registry). */
  resolveSocket?: (accountId: string) => WASocket | null
  paused?: (accountId: string) => Promise<boolean>
  readContent?: ReadContentFn
  transcodeVoice?: TranscodeVoiceFn
}

function defaultResolveSocket(accountId: string): WASocket | null {
  const handle = getHandle(accountId)
  if (!handle || !handle.connected || !handle.socket) return null
  return handle.socket
}

export async function sendWhatsappMessage(
  input: SendWhatsappInput,
  deps: SendWhatsappDeps = {}
): Promise<OutboundSendResult> {
  const accountId = input.account.id
  const logger = input.logger ?? moduleLogger
  const resolveSocket = deps.resolveSocket ?? defaultResolveSocket
  const paused = deps.paused ?? isSessionPaused
  const readContent = deps.readContent ?? readContentBuffer
  const transcodeVoice = deps.transcodeVoice ?? transcodeToOpusVoiceNote

  if (await paused(accountId)) {
    throw new RetryableTransportError(
      `whatsapp_unofficial: session paused for account ${accountId}`
    )
  }

  const socket = resolveSocket(accountId)
  if (!socket) {
    throw new RetryableTransportError(
      `whatsapp_unofficial: no live socket for account ${accountId} (reconnecting?)`
    )
  }

  const degraded = degradeForCapabilities(
    input.message,
    WHATSAPP_UNOFFICIAL_MESSAGE_CAPABILITIES
  )

  // Reaction parts are a single-slot side-channel (handled via sendMessage too).
  const reaction = degraded.parts.find((p) => p.type === "reaction")
  const jid = normalizeJid(input.endpoint.externalId)
  if (!jid) {
    throw new PermanentTransportError(
      "whatsapp_unofficial: empty recipient JID",
      { code: "whatsapp_unofficial_empty_jid" }
    )
  }

  if (reaction && reaction.type === "reaction") {
    const targetId = reaction.target.externalMessageId
    if (!targetId) {
      throw new PermanentTransportError(
        "whatsapp_unofficial: reaction without target message id",
        { code: "whatsapp_unofficial_reaction_no_target" }
      )
    }
    const reactionContent: AnyMessageContent = {
      react: {
        text: reaction.emoji,
        key: { remoteJid: jid, id: targetId, fromMe: false },
      },
    }
    const sent = await sendOrThrow(
      socket,
      jid,
      reactionContent,
      undefined,
      logger
    )
    return { externalMessageId: sent }
  }

  const { content, mentionedJid } = await buildOutboundContent(degraded, {
    readContent,
    transcodeVoice,
    logger,
  })

  // Empty text + no media → nothing to send.
  if (isEmptyContent(content)) {
    throw new PermanentTransportError(
      "whatsapp_unofficial: nothing to send after degradation",
      { code: "whatsapp_unofficial_empty_message" }
    )
  }

  const withMentions =
    mentionedJid.length > 0
      ? ({ ...content, mentions: mentionedJid } as AnyMessageContent)
      : content

  const quoted = input.replyTo
    ? buildQuotedStub(jid, input.replyTo.externalMessageId)
    : undefined

  const sentId = await sendOrThrow(socket, jid, withMentions, quoted, logger)
  return { externalMessageId: sentId }
}

function isEmptyContent(content: AnyMessageContent): boolean {
  const c = content as Record<string, unknown>
  if ("text" in c) {
    return typeof c.text !== "string" || c.text.trim().length === 0
  }
  return false
}

/** Minimal quoted-message stub for `MiscMessageGenerationOptions.quoted`. */
function buildQuotedStub(
  remoteJid: string,
  externalMessageId: string
): {
  key: { remoteJid: string; id: string; fromMe: boolean }
  message: Record<string, never>
} {
  return {
    key: { remoteJid, id: externalMessageId, fromMe: false },
    message: {},
  }
}

async function sendOrThrow(
  socket: WASocket,
  jid: string,
  content: AnyMessageContent,
  quoted: ReturnType<typeof buildQuotedStub> | undefined,
  logger: ConnectorLogger
): Promise<string> {
  try {
    const result = await socket.sendMessage(
      jid,
      content,
      quoted ? ({ quoted } as never) : undefined
    )
    const id = result?.key?.id
    if (!id) {
      // The socket accepted but returned no id — treat as ambiguous-but-retryable.
      throw new RetryableTransportError(
        "whatsapp_unofficial: sendMessage returned no message id"
      )
    }
    return id
  } catch (err) {
    if (
      err instanceof RetryableTransportError ||
      err instanceof PermanentTransportError
    ) {
      throw err
    }
    // Socket-level failures (closed, timeout) are transient → retryable.
    logger.error("whatsapp_unofficial: sendMessage failed", err, { jid })
    throw new RetryableTransportError(
      `whatsapp_unofficial: sendMessage failed: ${(err as Error).message}`,
      { cause: err }
    )
  }
}
