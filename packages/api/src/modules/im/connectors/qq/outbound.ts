/**
 * QQ outbound (Stage 4 — text via passive-reply anchor + crash-safe
 * reservation).
 *
 * Implements the G6 seven-step flow:
 *
 *  Step 0 — Local determinism BEFORE reserving anchor quota:
 *     • render payload, validate URL hosts against
 *       account.config.configuredUrlDomains; both throw
 *       PermanentTransportError if they fail
 *     • (Stage 5) media preflight upload + cache lookup; retryable
 *       upload errors propagate as RetryableTransportError so we don't
 *       burn quota on a transient 5xx
 *  Step 1 — Crash recovery: any `attemptNumber < input.attemptNumber`
 *     entry under `metadata.qq.attempts.{n}` with outcome="in_flight"
 *     is reclassified as "unknown_assumed". Lets the duplicate-code
 *     branch (step 7) recognize that an earlier attempt may have
 *     actually reached the platform.
 *  Step 2 — If neither `metadata.qq.anchor` nor a Redis reservation
 *     exists for this link, atomically reserveFirstSend(): pick anchor
 *     from latest-inbound-store, INCR per-anchor quota (capped 5),
 *     persist {anchor, msgSeq, reservedAt, expiresAt} to both Redis +
 *     link metadata.
 *  Step 3 — Otherwise read the persisted anchor: from metadata if
 *     present, falling back to Redis reservation (recovers from crash
 *     between Redis write and DB write). Never re-picks latest.
 *  Step 3.5 — Pre-POST: check `anchor.expiresAt` hasn't elapsed (QQ's
 *     reply window has hard cap), then mark this attempt in_flight in
 *     link metadata so step 1 of a future retry can reclassify if we
 *     crash between POST and result.
 *  Step 4 — POST `/v2/users/{openid}/messages` or
 *     `/v2/groups/{group_openid}/messages` with body {msg_type,
 *     content, msg_id or event_id, msg_seq, msg_reference}.
 *  Step 5/6 — On 2xx, mark attempt "delivered" + return externalMessageId.
 *     Network error → mark "unknown" + throw RetryableTransportError.
 *  Step 7 — On a QQ "duplicate msg_seq" response, IF the
 *     code appears in `QQ_DUPLICATE_MSG_SEQ_CODES` AND any prior attempt
 *     is in {unknown, unknown_assumed}, the message was almost
 *     certainly delivered earlier — return {} (no externalMessageId) +
 *     mark deliveryAmbiguous="success_likely". The code allow-list is
 *     intentionally empty in v1 (third-party error-code readings
 *     turned out unreliable; see the constant's doc comment). Until
 *     sandbox-verified codes are added, every duplicate-shaped response
 *     falls through to the generic 4xx branch and the link is marked
 *     failed — the operator sees the exact business code and can
 *     investigate, instead of silently believing a never-sent message
 *     was delivered.
 */

import { redis } from "../../../../infrastructure/redis/index.js"
import {
  PermanentTransportError,
  RetryableTransportError,
  type OutboundSendInput,
  type OutboundSendResult,
} from "../types.js"
import { qqApiFetch } from "./client.js"
import { decodeUserOpenid } from "./address-encoding.js"
import type { QqKeyboardPayload } from "./keyboard.js"
import {
  getLatestInboundAnchor,
  type QqLatestInboundAnchor,
} from "./latest-inbound-store.js"
import { downloadForQqUpload, uploadQqMedia } from "./media-upload.js"
import { QQ_FILE_TYPE, type QqFileType } from "./media-constants.js"
import {
  readQqAccountConfig,
  type QqAccountConfig,
} from "./qq-account-config.js"
import { planQqSends, type QqSendPlanItem } from "./render.js"
import {
  getReservation,
  reserveFirstSend,
  type QqReservation,
} from "./reply-quota.js"
import { QQ_MSG_TYPE } from "./types.js"

type AttemptOutcome =
  | "in_flight"
  | "delivered"
  | "unknown"
  | "unknown_assumed"
  | "duplicate_likely_success"
  | "permanent_failure"

interface AttemptRecord {
  outcome: AttemptOutcome
  startedAt?: string
  completedAt?: string
  msgSeq?: number
  errorCode?: string
}

interface QqLinkMetadataState {
  msgSeq?: number
  anchor?: {
    anchorKind: "msg_id" | "event_id"
    anchorId: string
    expiresAt: number
    reservedAt?: string
  }
  attempts?: Record<string, AttemptRecord>
  deliveryAmbiguous?: string
}

const URL_PATTERN = /\bhttps?:\/\/([^\s<>"]+)/gi

/**
 * QQ open-platform error codes that mean "the platform already accepted
 * a message with this (anchor, msg_seq) pair". When the previous attempt
 * is marked `unknown` / `unknown_assumed`, the G6 step 7 branch turns a
 * duplicate response into an ambiguous-success outcome — but only for
 * codes we can ACTUALLY trust.
 *
 * Status: **empty** as of v1. Codes previously listed here (304022 /
 * 304023 / 40034015) came from third-party readings; review against the
 * local openclaw clone found `304023` is actually "推荐子频道超限"
 * (subchannel recommendation limit exceeded), and the other two have no
 * authoritative documentation backing the duplicate interpretation. If
 * we left them in, an actual non-duplicate failure under those codes
 * would be silently re-classified as "likely sent", and the user would
 * see a message marked delivered that QQ never accepted.
 *
 * Population rule for v1.x: only add a code here AFTER a sandbox
 * reproduction (force a duplicate msg_seq + capture the actual response
 * code from QQ) OR a citation in the official QQ open-platform wiki.
 * Each addition MUST come with a unit test in outbound.test.ts that
 * asserts that exact code triggers the ambiguous-success path.
 *
 * In the meantime: a duplicate-shaped response falls through to the
 * generic 4xx branch and the link is marked failed — operator sees the
 * exact business code in `metadata.lastError` and can investigate. This
 * is the strictly safer of the two trade-offs ("don't claim success"
 * beats "claim success on a real failure").
 */
export const QQ_DUPLICATE_MSG_SEQ_CODES: ReadonlySet<number> = new Set<number>()

/**
 * Transient error codes the chunked-upload and message-send paths can
 * surface; left at the module scope so Stage 5 can reuse the same set
 * without re-discovery.
 */
const QQ_RETRYABLE_BUSINESS_CODES = new Set([
  304082, // upload media info fail — wiki: "please retry"
  304083, // convert media info fail — wiki: "please retry"
])

export async function sendQqMessage(
  input: OutboundSendInput
): Promise<OutboundSendResult> {
  const config = readQqAccountConfig(input.account)
  const meta = readQqMetadata(input.linkMetadata)

  // Step 0a: local determinism that doesn't touch any quota.
  // Pass connectionMode so interaction_prompt parts render as a real
  // keyboard for long_connection accounts and degrade to fallback text
  // for webhook accounts (Stage 8 WS-only gate).
  const plan = planQqSends(input.message, {
    connectionMode: input.account.connectionMode,
  })
  if (plan.length === 0) {
    throw new PermanentTransportError("qq: refusing to send empty message", {
      code: "qq_empty_message",
    })
  }
  enforceConfiguredUrlDomains(plan, config)

  // Step 0b: media preflight BEFORE the anchor reservation. QQ caps
  // passive-reply quota at 5 per inbound anchor; an upload failure (or
  // a retryable 5xx during upload) that fires after reserveFirstSend
  // would burn one of those five slots for nothing. Upload here so
  // RetryableTransportError bubbles up before any reservation work.
  // Cached file_info wins, no re-upload — the cache key includes
  // (account, scope, target, fileType, content hash) so two attempts
  // on the same content hit the cache.
  const planItem = plan[0]!
  const fileInfo =
    planItem.kind === "media"
      ? await resolveFileInfo({
          account: input.account,
          endpoint: input.endpoint,
          plan: planItem,
        })
      : null

  // Step 1: crash recovery — reclassify stale in_flight attempts
  await reclassifyStaleAttempts(input, meta)

  // Step 2/3: anchor + msgSeq (reserve or recover)
  const reservation = await acquireAnchor(input, meta)

  // Step 3.5a: anchor expiration check (window may have closed since reserve)
  if (Date.now() >= reservation.expiresAt) {
    throw new PermanentTransportError(
      "qq: anchor reply window expired before POST",
      { code: "qq_anchor_window_expired" }
    )
  }

  // Step 3.5b: mark this attempt in_flight in link metadata
  await input.patchLinkMetadata({
    qq: {
      attempts: {
        [String(input.attemptNumber)]: {
          outcome: "in_flight",
          startedAt: new Date().toISOString(),
          msgSeq: reservation.msgSeq,
        },
      },
    },
  })

  // Step 4: POST. v1 sends plan[0] only — mixed text+media canonical
  // messages would each cost an anchor-quota slot (capped 5/window),
  // so we keep the cost predictable and let the AI repeat the message
  // if it really wanted both. Future revisions can chain plan items
  // by reserving a fresh msg_seq per send.
  const { url } = endpointUrlFor(input)
  const body = buildOutboundBody({
    plan: planItem,
    fileInfo,
    reservation,
    replyTo: input.replyTo?.externalMessageId,
  })

  let res: Response
  try {
    res = await qqApiFetch(input.account, url, {
      method: "POST",
      body: JSON.stringify(body),
    })
  } catch (err) {
    // Network/timeout: mark unknown and let BullMQ retry. The next
    // attempt's step 7 may resolve into deliveryAmbiguous.
    await input.patchLinkMetadata({
      qq: {
        attempts: {
          [String(input.attemptNumber)]: {
            outcome: "unknown",
            completedAt: new Date().toISOString(),
          },
        },
      },
    })
    throw new RetryableTransportError(
      `qq: network error during send: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    )
  }

  if (res.ok) {
    return await onSendSuccess(input, res)
  }

  // 4xx / 5xx — inspect body to classify
  return await onSendFailure(input, res, meta)
}

interface ParsedFailure {
  status: number
  code: number | undefined
  message: string
  raw: string
}

async function onSendFailure(
  input: OutboundSendInput,
  res: Response,
  meta: QqLinkMetadataState
): Promise<OutboundSendResult> {
  const failure = await parseFailure(res)

  // Step 7: duplicate-msg_seq + prior unknown attempt → ambiguous success
  if (failure.code && QQ_DUPLICATE_MSG_SEQ_CODES.has(failure.code)) {
    if (hadPriorUnknownAttempt(meta, input.attemptNumber)) {
      // Record the per-attempt outcome under the QQ namespace
      // (truly protocol-specific) and the neutral ambiguity flag
      // under `metadata.delivery.*` so the generic worker/sweeper
      // can scan a single namespace regardless of which connector
      // produced the link.
      await input.patchLinkMetadata({
        qq: {
          attempts: {
            [String(input.attemptNumber)]: {
              outcome: "duplicate_likely_success",
              completedAt: new Date().toISOString(),
              errorCode: String(failure.code),
            },
          },
        },
        delivery: { ambiguous: true },
      })
      // Explicit `deliveryAmbiguous: true` + no id satisfies the
      // shared worker contract: it marks the link `sent` with
      // `external_message_id` NULL instead of rejecting the
      // missing id as a connector bug.
      return { deliveryAmbiguous: true }
    }
    // Genuine duplicate without prior unknown: programmer error / corrupt
    // anchor state. Don't retry forever.
    throw new PermanentTransportError(
      `qq: duplicate msg_seq with no prior unknown attempt (code ${failure.code}, ${failure.message})`,
      { code: "qq_duplicate_msg_seq" }
    )
  }

  if (
    failure.status >= 500 ||
    (failure.code && QQ_RETRYABLE_BUSINESS_CODES.has(failure.code))
  ) {
    await input.patchLinkMetadata({
      qq: {
        attempts: {
          [String(input.attemptNumber)]: {
            outcome: "unknown",
            completedAt: new Date().toISOString(),
            errorCode: failure.code ? String(failure.code) : undefined,
          },
        },
      },
    })
    throw new RetryableTransportError(
      `qq send retryable: ${failure.status} ${failure.message}${
        failure.code ? ` [${failure.code}]` : ""
      }`
    )
  }

  // 4xx business error — permanent
  await input.patchLinkMetadata({
    qq: {
      attempts: {
        [String(input.attemptNumber)]: {
          outcome: "permanent_failure",
          completedAt: new Date().toISOString(),
          errorCode: failure.code ? String(failure.code) : undefined,
        },
      },
    },
  })
  throw new PermanentTransportError(
    `qq send rejected: ${failure.status} ${failure.message}${
      failure.code ? ` [${failure.code}]` : ""
    }`,
    { code: failure.code ? `qq_${failure.code}` : `qq_http_${failure.status}` }
  )
}

interface QqSuccessResponse {
  id?: string
  message_id?: string
  msg_id?: string
}

async function onSendSuccess(
  input: OutboundSendInput,
  res: Response
): Promise<OutboundSendResult> {
  const json = (await safeJson(res)) as QqSuccessResponse | null
  const externalMessageId =
    typeof json?.id === "string" && json.id
      ? json.id
      : typeof json?.message_id === "string" && json.message_id
        ? json.message_id
        : typeof json?.msg_id === "string" && json.msg_id
          ? json.msg_id
          : undefined
  await input.patchLinkMetadata({
    qq: {
      attempts: {
        [String(input.attemptNumber)]: {
          outcome: "delivered",
          completedAt: new Date().toISOString(),
        },
      },
    },
  })
  return { externalMessageId, raw: json ?? undefined }
}

async function parseFailure(res: Response): Promise<ParsedFailure> {
  const text = await safeText(res)
  let code: number | undefined
  let message = ""
  if (text) {
    try {
      const parsed = JSON.parse(text) as {
        code?: number
        err_code?: number
        message?: string
        msg?: string
      }
      code =
        typeof parsed.code === "number"
          ? parsed.code
          : typeof parsed.err_code === "number"
            ? parsed.err_code
            : undefined
      message = parsed.message ?? parsed.msg ?? ""
    } catch {
      message = text.slice(0, 200)
    }
  }
  return { status: res.status, code, message, raw: text }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ""
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

function endpointUrlFor(input: OutboundSendInput): { url: string } {
  if (input.endpoint.endpointType === "direct") {
    const openid = decodeUserOpenid(input.endpoint.externalId)
    if (!openid) {
      throw new PermanentTransportError(
        `qq: direct endpoint missing user_openid (got ${input.endpoint.externalId})`,
        { code: "qq_invalid_endpoint" }
      )
    }
    return { url: `/v2/users/${encodeURIComponent(openid)}/messages` }
  }
  // Group endpoint external_id is the raw group_openid (no prefix).
  return {
    url: `/v2/groups/${encodeURIComponent(input.endpoint.externalId)}/messages`,
  }
}

interface QqOutboundBody {
  msg_type: number
  content?: string
  markdown?: { content: string }
  keyboard?: QqKeyboardPayload["keyboard"]
  media?: { file_info: string }
  msg_id?: string
  event_id?: string
  msg_seq: number
  message_reference?: { message_id: string }
}

/**
 * Materialize a single QqSendPlanItem into the body QQ expects. Sync
 * now that media upload moved to Step 0b — `fileInfo` is pre-resolved
 * by the caller and threaded in for the media branch.
 */
function buildOutboundBody(params: {
  plan: QqSendPlanItem
  fileInfo: string | null
  reservation: QqReservation
  replyTo?: string
}): QqOutboundBody {
  const body: QqOutboundBody = {
    msg_type: params.plan.msgType,
    msg_seq: params.reservation.msgSeq,
  }
  if (params.plan.kind === "text") {
    if (params.plan.msgType === QQ_MSG_TYPE.MARKDOWN) {
      body.markdown = { content: params.plan.content }
    } else {
      body.content = params.plan.content
    }
  } else if (params.plan.kind === "keyboard") {
    // Stage 8 keyboard payload: msg_type=2 markdown with a non-empty
    // bubble + attached keyboard. The render layer has already gated
    // this on connectionMode === "long_connection"; if we somehow see
    // it here on a webhook account, QQ would reject the buttons (since
    // INTERACTION_CREATE only flows over WS) — but that's a render bug,
    // not an outbound concern, so we still build the body faithfully.
    body.msg_type = QQ_MSG_TYPE.MARKDOWN
    body.markdown = params.plan.payload.markdown
    body.keyboard = params.plan.payload.keyboard
  } else {
    // media plan — file_info comes from the Step 0b preflight; throwing
    // here would be a programmer error since we only reach this branch
    // when planItem.kind === "media".
    if (params.fileInfo === null) {
      throw new PermanentTransportError(
        "qq: media plan but fileInfo not pre-resolved (Step 0b skipped)",
        { code: "qq_internal_media_preflight_missing" }
      )
    }
    body.media = { file_info: params.fileInfo }
    body.msg_type = QQ_MSG_TYPE.MEDIA
    // The platform requires a non-empty content even for media messages;
    // send a single space so the message renders cleanly.
    body.content = " "
  }
  if (params.reservation.anchorKind === "msg_id") {
    body.msg_id = params.reservation.anchorId
  } else {
    body.event_id = params.reservation.anchorId
  }
  if (params.replyTo) {
    body.message_reference = { message_id: params.replyTo }
  }
  return body
}

async function reclassifyStaleAttempts(
  input: OutboundSendInput,
  meta: QqLinkMetadataState
): Promise<void> {
  if (!meta.attempts) return
  const patch: Record<string, AttemptRecord> = {}
  for (const [key, attempt] of Object.entries(meta.attempts)) {
    const attemptNum = Number(key)
    if (
      Number.isFinite(attemptNum) &&
      attemptNum < input.attemptNumber &&
      attempt?.outcome === "in_flight"
    ) {
      patch[key] = {
        ...attempt,
        outcome: "unknown_assumed",
        completedAt: new Date().toISOString(),
      }
    }
  }
  if (Object.keys(patch).length > 0) {
    await input.patchLinkMetadata({ qq: { attempts: patch } })
    // Mirror into local snapshot so step 7's hadPriorUnknownAttempt
    // sees the reclassified values without an additional read.
    meta.attempts = { ...meta.attempts, ...patch }
  }
}

async function acquireAnchor(
  input: OutboundSendInput,
  meta: QqLinkMetadataState
): Promise<QqReservation> {
  // Already in link metadata?
  if (meta.anchor && typeof meta.msgSeq === "number") {
    return {
      anchorKind: meta.anchor.anchorKind,
      anchorId: meta.anchor.anchorId,
      msgSeq: meta.msgSeq,
      reservedAt: meta.anchor.reservedAt ?? new Date(0).toISOString(),
      expiresAt: meta.anchor.expiresAt,
    }
  }
  // Recover from Redis if the prior attempt's metadata-write was lost
  // to a crash between INCR and DB UPDATE.
  const persisted = await getReservation(redis, input.transportMessageLinkId)
  if (persisted) {
    await persistReservationToLinkMetadata(input, persisted)
    return persisted
  }
  // First-ever attempt for this link: pick anchor, INCR quota,
  // persist to Redis + DB.
  const latest = await getLatestInboundAnchor(redis, {
    accountId: input.account.id,
    endpointType: input.endpoint.endpointType,
    endpointExternalId: input.endpoint.externalId,
  })
  if (!latest) {
    throw new PermanentTransportError(
      "qq: no recent inbound to anchor a passive reply (proactive API discontinued 2025-04-21)",
      { code: "qq_no_passive_anchor" }
    )
  }
  const result = await reserveFirstSend(redis, {
    linkId: input.transportMessageLinkId,
    accountId: input.account.id,
    endpointType: input.endpoint.endpointType,
    endpointExternalId: input.endpoint.externalId,
    anchor: latest,
  })
  if (!result.ok) {
    throw new PermanentTransportError(`qq: passive-reply ${result.reason}`, {
      code: `qq_${result.reason}`,
    })
  }
  await persistReservationToLinkMetadata(input, result.reservation)
  return result.reservation
}

async function persistReservationToLinkMetadata(
  input: OutboundSendInput,
  reservation: QqReservation
): Promise<void> {
  await input.patchLinkMetadata({
    qq: {
      msgSeq: reservation.msgSeq,
      anchor: {
        anchorKind: reservation.anchorKind,
        anchorId: reservation.anchorId,
        expiresAt: reservation.expiresAt,
        reservedAt: reservation.reservedAt,
      },
    },
  })
}

function readQqMetadata(
  linkMetadata: Record<string, unknown>
): QqLinkMetadataState {
  const qq = linkMetadata.qq
  if (!qq || typeof qq !== "object" || Array.isArray(qq)) return {}
  const raw = qq as Record<string, unknown>
  const out: QqLinkMetadataState = {}
  if (typeof raw.msgSeq === "number") out.msgSeq = raw.msgSeq
  if (
    raw.anchor &&
    typeof raw.anchor === "object" &&
    !Array.isArray(raw.anchor)
  ) {
    const a = raw.anchor as Record<string, unknown>
    if (
      (a.anchorKind === "msg_id" || a.anchorKind === "event_id") &&
      typeof a.anchorId === "string" &&
      typeof a.expiresAt === "number"
    ) {
      out.anchor = {
        anchorKind: a.anchorKind,
        anchorId: a.anchorId,
        expiresAt: a.expiresAt,
        reservedAt: typeof a.reservedAt === "string" ? a.reservedAt : undefined,
      }
    }
  }
  if (
    raw.attempts &&
    typeof raw.attempts === "object" &&
    !Array.isArray(raw.attempts)
  ) {
    const attempts: Record<string, AttemptRecord> = {}
    for (const [k, v] of Object.entries(
      raw.attempts as Record<string, unknown>
    )) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue
      const av = v as Record<string, unknown>
      if (typeof av.outcome !== "string") continue
      attempts[k] = av as unknown as AttemptRecord
    }
    out.attempts = attempts
  }
  if (typeof raw.deliveryAmbiguous === "string") {
    out.deliveryAmbiguous = raw.deliveryAmbiguous
  }
  return out
}

function hadPriorUnknownAttempt(
  meta: QqLinkMetadataState,
  currentAttempt: number
): boolean {
  if (!meta.attempts) return false
  for (const [key, attempt] of Object.entries(meta.attempts)) {
    const n = Number(key)
    if (Number.isFinite(n) && n < currentAttempt) {
      if (
        attempt?.outcome === "unknown" ||
        attempt?.outcome === "unknown_assumed"
      ) {
        return true
      }
    }
  }
  return false
}

function enforceConfiguredUrlDomains(
  plan: QqSendPlanItem[],
  config: QqAccountConfig
): void {
  if (config.configuredUrlDomains.length === 0) {
    // No allowlist configured at all. Only reject if a URL exists in
    // any text plan item (media plans don't carry user-visible URLs).
    for (const p of plan) {
      if (p.kind !== "text") continue
      if (containsHttpUrl(p.content)) {
        throw new PermanentTransportError(
          "qq: outbound contains URL but account.config.configuredUrlDomains is empty (QQ console 消息URL配置 required)",
          { code: "qq_url_not_configured" }
        )
      }
    }
    return
  }
  const allowed = new Set(
    config.configuredUrlDomains.map((h) => h.toLowerCase())
  )
  for (const p of plan) {
    if (p.kind !== "text") continue
    for (const host of extractHosts(p.content)) {
      if (!allowed.has(host)) {
        throw new PermanentTransportError(
          `qq: outbound URL host '${host}' not in configuredUrlDomains`,
          { code: "qq_url_not_configured" }
        )
      }
    }
  }
}

function containsHttpUrl(text: string): boolean {
  URL_PATTERN.lastIndex = 0
  return URL_PATTERN.test(text)
}

function extractHosts(text: string): string[] {
  URL_PATTERN.lastIndex = 0
  const hosts: string[] = []
  for (const match of text.matchAll(URL_PATTERN)) {
    try {
      const url = new URL(match[0])
      hosts.push(url.hostname.toLowerCase())
    } catch {
      // ignore malformed
    }
  }
  return hosts
}

/**
 * Resolve a media plan item to a QQ `file_info` token. Strategy:
 *   - If fileRef.url is reachable by the QQ CDN: pass the URL through
 *     to upload, let QQ pull it (saves us the download bandwidth).
 *   - If we only have local bytes (fileRef.url is internal, or future
 *     Synapse `files:`/local paths): download via the safe helper +
 *     base64-inline upload.
 *
 * Cache hits (same content twice within the file_info TTL) skip the
 * upload altogether (see upload-cache.ts).
 *
 * Stage 5 doesn't yet wire local-file paths — `fileRef.url` is the
 * only path tested in v1. Buffers will land when Synapse `files`
 * service integration matures (see plan OQ3).
 */
async function resolveFileInfo(params: {
  account: OutboundSendInput["account"]
  endpoint: OutboundSendInput["endpoint"]
  plan: Extract<QqSendPlanItem, { kind: "media" }>
}): Promise<string> {
  const { fileRef, fileType } = params.plan
  if (!fileRef.url) {
    throw new PermanentTransportError(
      "qq: media fileRef has no url (local-buffer path not yet wired)",
      { code: "qq_media_no_url" }
    )
  }
  const scope = params.endpoint.endpointType === "direct" ? "c2c" : "group"
  const targetId =
    scope === "c2c"
      ? (decodeUserOpenid(params.endpoint.externalId) ?? "")
      : params.endpoint.externalId
  if (!targetId) {
    throw new PermanentTransportError(
      `qq: cannot derive target id from endpoint ${params.endpoint.externalId}`,
      { code: "qq_invalid_endpoint" }
    )
  }

  // Prefer URL pass-through: the QQ CDN will pull from the source
  // directly without us downloading anything.
  try {
    const result = await uploadQqMedia({
      account: params.account,
      scope,
      targetId,
      fileType,
      source: { url: fileRef.url, mime: fileRef.mime },
    })
    return result.fileInfo
  } catch (err) {
    // If the platform refused to pull from this URL (e.g. private CDN
    // we serve internally), download via the safe helper and retry
    // with inline bytes. Only do this for known retryable errors so we
    // don't spend two upload slots on a permanent failure.
    if (!(err instanceof RetryableTransportError)) throw err
    const buffer = await downloadForQqUpload({
      url: fileRef.url,
      fileType,
    })
    const result = await uploadQqMedia({
      account: params.account,
      scope,
      targetId,
      fileType,
      source: { buffer, mime: fileRef.mime },
    })
    return result.fileInfo
  }
}

// re-exported for downstream code (Stage 8 keyboard render needs the
// file_type constant set; reads it from here so we only have one source
// of truth).
export { QQ_FILE_TYPE }
export type { QqFileType }
