/**
 * Inbound wiring: turn a `messages.upsert` batch into emitted InboundEnvelopes.
 *
 * Pulled out of connection-controller so it is unit-testable with a mocked
 * download + emit and no socket. The controller calls `processUpsertBatch` from
 * its `messages.upsert` handler; presence updates are accepted but not emitted
 * (we have no inbound typing model — kept as an explicit no-op for clarity).
 *
 * Filters: `type==='notify'` and `!key.fromMe` (enforced in normalize), plus a
 * caller-supplied dedup on `message.key.id`.
 */

import type { WAMessage } from "baileys"
import type { ConnectorLogger, InboundEnvelope } from "../types.js"
import {
  enrichInboundWhatsappMedia,
  type DownloadMediaFn,
  type StoreInboundMediaFn,
} from "./media.js"
import { normalizeWhatsappMessage, type WaMessageLike } from "./normalize.js"

export interface ProcessUpsertDeps {
  workspaceId: string
  emitInbound: (envelope: InboundEnvelope) => Promise<void>
  download: DownloadMediaFn
  store?: StoreInboundMediaFn
  logger: ConnectorLogger
  /** Returns true if this id was already processed (dedup). */
  seen: (id: string) => boolean
}

/**
 * Process one `messages.upsert` batch. Only `type==='notify'` batches should be
 * passed (the controller checks this). Each message is normalized, media is
 * enriched, and the envelope is emitted. Errors per-message are logged and
 * swallowed so one bad message doesn't drop the rest.
 */
export async function processUpsertBatch(
  messages: WAMessage[],
  deps: ProcessUpsertDeps
): Promise<void> {
  for (const raw of messages) {
    const id = typeof raw?.key?.id === "string" ? raw.key.id : ""
    if (id && deps.seen(id)) continue

    const normalized = normalizeWhatsappMessage(raw as unknown as WaMessageLike)
    if (!normalized) continue

    try {
      const message =
        normalized.mediaParts.length > 0
          ? await enrichInboundWhatsappMedia(
              normalized.envelope.message,
              normalized.mediaParts,
              {
                raw,
                workspaceId: deps.workspaceId,
                messageId: normalized.envelope.externalMessageId,
                download: deps.download,
                store: deps.store,
                logger: deps.logger,
              }
            )
          : normalized.envelope.message

      await deps.emitInbound({ ...normalized.envelope, message })
    } catch (err) {
      deps.logger.error("whatsapp_unofficial: inbound message failed", err, {
        messageId: id,
      })
    }
  }
}
