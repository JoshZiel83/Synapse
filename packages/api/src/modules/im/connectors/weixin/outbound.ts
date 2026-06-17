/**
 * Personal-WeChat (ilink) outbound sender.
 *
 * The protocol requires a contextToken to address an outbound reply. The
 * worker pre-loads the recipient transport_address row's metadata (triggered by
 * `requiresRecipientAddressMetadata = true` on the connector) and passes it in
 * as `recipientAddressMetadata`; we fall back to the endpoint metadata. This
 * keeps the connector self-contained — it never reaches into modules/im/service.
 *
 * Media: when the message carries image/video/file parts (capabilities now
 * advertise them), each is uploaded to the WeChat CDN (media-cdn.ts) and sent
 * as its own sendmessage item, preceded by any text caption. Text-only messages
 * keep the original single-request path.
 */

import crypto from "node:crypto"
import type { TransportAccountSummary } from "@synapse/shared/types"
import {
  buildCanonicalMessage,
  type CanonicalPart,
} from "../../messaging/canonical-message.js"
import { degradeForCapabilities } from "../../messaging/degradation.js"
import { downloadToBuffer } from "../../../../infrastructure/storage/index.js"
import type { OutboundEndpointRef, OutboundSendResult } from "../types.js"
import { WEIXIN_MESSAGE_CAPABILITIES } from "./capabilities.js"
import {
  buildWeixinHeaders,
  getWeixinCredentialsOrThrow,
  nonEmpty,
} from "./client.js"
import { uploadWeixinMedia, WEIXIN_UPLOAD_MEDIA_TYPE } from "./media-cdn.js"
import { parseWeixinSendResponseText } from "./outbound-codec.js"
import {
  buildWeixinBaseInfo,
  WEIXIN_ENDPOINTS,
  WEIXIN_ITEM_TYPE,
  WEIXIN_MESSAGE_STATE,
  WEIXIN_MESSAGE_TYPE,
} from "./protocol.js"
import { renderWeixinMessage } from "./render.js"

export interface WeixinSendInput {
  account: TransportAccountSummary
  endpoint: OutboundEndpointRef
  message: import("../../messaging/canonical-message.js").CanonicalMessage
  /**
   * Metadata of the recipient transport_address row. Pre-loaded by the worker
   * because we set `requiresRecipientAddressMetadata = true` on the connector.
   * May be undefined if the worker found no row, in which case we fall back to
   * `endpoint.metadata`.
   */
  recipientAddressMetadata?: Record<string, unknown>
}

type WeixinMediaPart = Extract<
  CanonicalPart,
  { type: "image" } | { type: "video" } | { type: "file" }
>

function isWeixinMediaPart(part: CanonicalPart): part is WeixinMediaPart {
  return part.type === "image" || part.type === "video" || part.type === "file"
}

function requireMediaUrl(part: WeixinMediaPart): string {
  const url = part.fileRef.url?.trim()
  if (!url) {
    throw new Error(
      `Weixin ${part.type} part requires a CanonicalFileRef.url; got ${JSON.stringify(part.fileRef)}`
    )
  }
  return url
}

function readCdnBaseUrl(account: TransportAccountSummary): string {
  const v = account.config?.cdnBaseUrl
  return typeof v === "string" ? v : ""
}

function textItem(text: string): Record<string, unknown> {
  return { type: WEIXIN_ITEM_TYPE.TEXT, text_item: { text } }
}

/** Send a single message item (text or media) as one sendmessage request. */
async function sendWeixinItem(params: {
  baseUrl: string
  token: string
  toUserId: string
  contextToken: string
  item: Record<string, unknown>
}): Promise<OutboundSendResult> {
  const clientId = crypto.randomUUID()
  const body = JSON.stringify({
    msg: {
      from_user_id: "",
      to_user_id: params.toUserId,
      client_id: clientId,
      message_type: WEIXIN_MESSAGE_TYPE.BOT,
      message_state: WEIXIN_MESSAGE_STATE.FINISH,
      item_list: [params.item],
      context_token: params.contextToken,
    },
    base_info: buildWeixinBaseInfo(),
  })
  const response = await fetch(
    `${params.baseUrl.replace(/\/+$/, "")}/${WEIXIN_ENDPOINTS.SEND_MESSAGE}`,
    { method: "POST", headers: buildWeixinHeaders(params.token), body }
  )
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Weixin send failed with ${response.status}: ${text}`)
  }
  // Parse the protocol response for a real message id; ilink may return an
  // empty/`{}` body. We still fail closed on a non-JSON 200 (provider drift).
  const parsed = parseWeixinSendResponseText(text)
  if (!parsed) {
    throw new Error("Weixin send returned invalid provider response")
  }
  return { externalMessageId: parsed.externalMessageId || clientId, raw: text }
}

async function uploadAndBuildMediaItem(params: {
  part: WeixinMediaPart
  baseUrl: string
  token: string
  cdnBaseUrl: string
  toUserId: string
}): Promise<Record<string, unknown>> {
  const { part, baseUrl, token, cdnBaseUrl, toUserId } = params
  const url = requireMediaUrl(part)
  const { buffer } = await downloadToBuffer(url)

  const mediaType =
    part.type === "image"
      ? WEIXIN_UPLOAD_MEDIA_TYPE.IMAGE
      : part.type === "video"
        ? WEIXIN_UPLOAD_MEDIA_TYPE.VIDEO
        : WEIXIN_UPLOAD_MEDIA_TYPE.FILE
  const uploaded = await uploadWeixinMedia({
    buffer,
    toUserId,
    mediaType,
    baseUrl,
    token,
    cdnBaseUrl,
  })
  const media = {
    encrypt_query_param: uploaded.encryptQueryParam,
    aes_key: uploaded.aesKeyBase64,
    encrypt_type: 1,
  }
  if (part.type === "image") {
    return {
      type: WEIXIN_ITEM_TYPE.IMAGE,
      image_item: { media, mid_size: uploaded.cipherSize },
    }
  }
  if (part.type === "video") {
    return {
      type: WEIXIN_ITEM_TYPE.VIDEO,
      video_item: { media, video_size: uploaded.cipherSize },
    }
  }
  return {
    type: WEIXIN_ITEM_TYPE.FILE,
    file_item: {
      media,
      file_name: part.fileRef.name,
      len: String(uploaded.rawSize),
    },
  }
}

export async function sendWeixinMessage(
  input: WeixinSendInput
): Promise<OutboundSendResult> {
  const { token, baseUrl } = getWeixinCredentialsOrThrow(input.account)
  const toUserId = input.endpoint.externalId

  // Resolve contextToken: prefer the pre-loaded transport_address metadata
  // (refreshed by every inbound), fall back to the endpoint metadata.
  const contextToken =
    nonEmpty(input.recipientAddressMetadata?.contextToken) ||
    nonEmpty(input.endpoint.metadata.contextToken)
  if (!contextToken) {
    throw new Error(
      `Weixin direct conversation ${toUserId} is missing contextToken`
    )
  }

  const degraded = degradeForCapabilities(
    input.message,
    WEIXIN_MESSAGE_CAPABILITIES
  )
  const mediaParts = degraded.parts.filter(isWeixinMediaPart)

  // Text-only: keep the original single-request behavior.
  if (mediaParts.length === 0) {
    const rendered = renderWeixinMessage(degraded)
    return sendWeixinItem({
      baseUrl: baseUrl!,
      token,
      toUserId,
      contextToken,
      item: textItem(rendered.text),
    })
  }

  // Mixed: send the text caption (if any) first, then each media item.
  const nonMedia = degraded.parts.filter((p) => !isWeixinMediaPart(p))
  const caption = nonMedia.length
    ? buildCanonicalMessage(nonMedia).plainText.trim()
    : ""
  const cdnBaseUrl = readCdnBaseUrl(input.account)

  let last: OutboundSendResult | null = null
  if (caption) {
    last = await sendWeixinItem({
      baseUrl: baseUrl!,
      token,
      toUserId,
      contextToken,
      item: textItem(caption),
    })
  }
  for (const part of mediaParts) {
    const item = await uploadAndBuildMediaItem({
      part,
      baseUrl: baseUrl!,
      token,
      cdnBaseUrl,
      toUserId,
    })
    last = await sendWeixinItem({
      baseUrl: baseUrl!,
      token,
      toUserId,
      contextToken,
      item,
    })
  }
  // mediaParts.length > 0 guarantees at least one send above.
  return last!
}
