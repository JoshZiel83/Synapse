/**
 * WhatsApp Cloud inbound — webhook entry.
 *
 * handleWebhook flow:
 *   1. Verify X-Hub-Signature-256 over the RAW body bytes. On mismatch → 401.
 *      (Meta retries non-200 for up to 7 days, concurrently → the handler is
 *      idempotent: inbound dedup is by wamid (DB unique index), status
 *      reconcile is idempotent, window writes are last-writer-wins.)
 *   2. Return 200 to Meta as fast as possible (we do the work inline but
 *      always answer 200 unless the signature/shape is wrong, so Meta stops
 *      retrying a payload we've accepted).
 *   3. For each value.messages[]: update the 24h window, normalize → enrich
 *      media → emitInbound.
 *   4. For each value.statuses[]: reconcile delivery status (flip a sent link
 *      to failed on status:"failed").
 *
 * startAccount is the webhook no-op (Cloud API is webhook-only; the runtime
 * reconcile loop never invokes startAccount for webhook accounts — kept for
 * contract completeness).
 */

import { createLogger } from "../../../../infrastructure/logger/index.js"
import type {
  AccountStartContext,
  RunningAccount,
  WebhookHandlerInput,
  WebhookHandlerResult,
} from "../types.js"
import { getWhatsappCredentialsOrThrow } from "./credentials.js"
import { enrichInboundWhatsappMedia } from "./media.js"
import { normalizeWhatsappMessage } from "./normalize.js"
import { reconcileWhatsappStatus } from "./status-reconcile.js"
import type {
  WhatsappInboundMessage,
  WhatsappStatusEntry,
  WhatsappWebhookEnvelope,
  WhatsappWebhookValue,
} from "./types.js"
import {
  extractWhatsappSignatureHeader,
  verifyWhatsappSignature,
} from "./webhook-signature.js"
import {
  whatsappWindowStore,
  type WhatsappWindowStore,
} from "./window-store.js"

const log = createLogger("im.whatsapp")

export async function startWhatsappAccount(
  ctx: AccountStartContext
): Promise<RunningAccount> {
  // Cloud API is webhook-only — startAccount is unreachable for webhook
  // accounts but required by the contract.
  ctx.logger.info("whatsapp: webhook mode — no long connection started")
  return { stop: async () => {} }
}

export interface HandleWhatsappWebhookDeps {
  windowStore?: WhatsappWindowStore
}

export async function handleWhatsappWebhook(
  input: WebhookHandlerInput,
  deps: HandleWhatsappWebhookDeps = {}
): Promise<WebhookHandlerResult> {
  const logger = input.logger
  const creds = (() => {
    try {
      return getWhatsappCredentialsOrThrow(input.account)
    } catch (err) {
      logger?.error?.("whatsapp: webhook missing credentials", err)
      return null
    }
  })()
  if (!creds) {
    return { statusCode: 500, body: { error: "whatsapp credentials invalid" } }
  }

  // Signature MUST be verified over the raw bytes — re-serializing body
  // would change escaping/whitespace and break the HMAC.
  if (!input.rawBody) {
    logger?.error?.(
      "whatsapp: webhook rawBody missing — cannot verify signature"
    )
    return { statusCode: 400, body: { error: "raw body required" } }
  }
  const signatureHeader = extractWhatsappSignatureHeader(input.headers)
  const verified = verifyWhatsappSignature({
    appSecret: creds.appSecret,
    rawBody: input.rawBody,
    signatureHeader,
  })
  if (!verified) {
    return { statusCode: 401, body: { error: "signature verification failed" } }
  }

  const envelope = parseEnvelope(input.body)
  if (!envelope) {
    // Malformed but signed — ack 200 so Meta doesn't hammer-retry a payload
    // we can't action.
    return { statusCode: 200, body: { ok: true } }
  }

  const windowStore = deps.windowStore ?? whatsappWindowStore

  // Process every value across entry[].changes[]. We always answer 200; a
  // per-item failure is logged but never blocks the rest (Meta would
  // otherwise redeliver the WHOLE batch).
  for (const entry of envelope.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value
      if (!value) continue
      await processValue({
        value,
        input,
        creds,
        windowStore,
      }).catch((err) => {
        log.warn({ err }, "[im:whatsapp] webhook value processing failed")
      })
    }
  }

  return { statusCode: 200, body: { ok: true } }
}

function parseEnvelope(body: unknown): WhatsappWebhookEnvelope | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  return body as WhatsappWebhookEnvelope
}

interface ProcessValueInput {
  value: WhatsappWebhookValue
  input: WebhookHandlerInput
  creds: ReturnType<typeof getWhatsappCredentialsOrThrow>
  windowStore: WhatsappWindowStore
}

async function processValue(ctx: ProcessValueInput): Promise<void> {
  const { value, input } = ctx

  // Build a wa_id → display-name index from value.contacts[].
  const nameByWaId = new Map<string, string>()
  for (const c of value.contacts ?? []) {
    const waId = typeof c.wa_id === "string" ? c.wa_id.trim() : ""
    const name =
      typeof c.profile?.name === "string" ? c.profile.name.trim() : ""
    if (waId && name) nameByWaId.set(waId, name)
  }

  // ── Messages ──
  for (const message of value.messages ?? []) {
    await handleInboundMessage({
      message,
      nameByWaId,
      ctx,
    }).catch((err) => {
      log.warn(
        { err, wamid: message.id },
        "[im:whatsapp] inbound message handling failed"
      )
    })
  }

  // ── Statuses (delivery receipts) ──
  for (const status of value.statuses ?? []) {
    await handleStatus(status, ctx).catch((err) => {
      log.warn(
        { err, wamid: status.id },
        "[im:whatsapp] status reconcile failed"
      )
    })
  }
}

async function handleInboundMessage(args: {
  message: WhatsappInboundMessage
  nameByWaId: Map<string, string>
  ctx: ProcessValueInput
}): Promise<void> {
  const { message, nameByWaId, ctx } = args
  const { input, creds, windowStore } = ctx

  const from = typeof message.from === "string" ? message.from.trim() : ""
  const contactName = from ? nameByWaId.get(from) : undefined
  const envelope = normalizeWhatsappMessage(message, {
    ...(contactName ? { contactName } : {}),
  })
  if (!envelope) {
    input.logger?.warn?.("whatsapp: inbound message missing id/from; skipped", {
      type: message.type,
    })
    return
  }

  // Update the 24h customer-service window on EVERY inbound message
  // (opens/refreshes it). We store the receivedAt epoch-ms; the window store
  // converts via requireEpochMillis internally for the comparison.
  if (from) {
    await windowStore
      .recordInbound({
        accountId: input.account.id,
        waId: from,
        // Pass the canonical instant; the store converts via the single parser.
        at: envelope.receivedAt,
      })
      .catch((err) => {
        log.warn({ err }, "[im:whatsapp] window recordInbound failed")
      })
  }

  const enriched = await enrichInboundWhatsappMedia(envelope, {
    account: input.account,
    creds,
    ...(input.logger ? { logger: input.logger } : {}),
  })
  await input.emitInbound(enriched)
}

async function handleStatus(
  status: WhatsappStatusEntry,
  ctx: ProcessValueInput
): Promise<void> {
  await reconcileWhatsappStatus({
    accountId: ctx.input.account.id,
    entry: status,
    ...(ctx.input.logger ? { logger: ctx.input.logger } : {}),
  })
}
