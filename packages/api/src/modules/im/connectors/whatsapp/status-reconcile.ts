/**
 * WhatsApp Cloud delivery-status reconciliation.
 *
 * Cloud "sent" ≠ delivered. The send call returns 200 + a `wamid`
 * ("accepted"), so the BullMQ delivery job succeeds and is removed. The REAL
 * terminal failure (131026 undeliverable, 131047 re-engagement) arrives
 * seconds-to-minutes later on the STATUS webhook (`value.statuses[]` with
 * status "failed" + `statuses[].errors[]`), by which time there is no job to
 * retry. So outbound delivery on Cloud API is a webhook-driven state machine:
 * this module flips a previously-"sent" outbound link to "failed".
 *
 * ── Service seam (investigated; this is the legitimate path) ──
 * Connectors MUST NOT touch the DB directly. The IM SERVICE BARREL
 * (`modules/im/service.ts`) re-exports two functions that compose into a
 * "flip outbound link to failed by wamid":
 *   1. `findTransportMessageLinkByExternalMessage({ transportAccountId,
 *      externalMessageId, direction:"outbound" })` → resolve wamid → link
 *      (this is a repo fn promoted to the service layer via re-export — the
 *      same lookup inbound dedup uses; importing it from `../../service.js`
 *      does NOT violate the no-repo-import rule, matching the dingtalk/weixin
 *      precedent of importing service fns).
 *   2. `updateTransportMessageLinkStatus({ linkId, status:"failed", error,
 *      metadata })` → flip + stamp `metadata.lastError` (deep-merge).
 * There is NO single `markLinkFailedByExternalId(wamid)` convenience fn and
 * NO delivery-status hook on `WebhookHandlerInput`, so we compose the two.
 *
 * The lookup keys on the wamid the worker stamped as `externalMessageId` when
 * it marked the link "sent" — the same wamid Meta returns in the status
 * webhook — so the linkage is sound. Idempotent: re-running on a duplicate
 * "failed" status just re-writes the same terminal state.
 *
 * The service module is imported LAZILY inside the call so importing this
 * file (register-all) never drags the DB graph in. The `deps` seam lets
 * tests inject fakes without touching the service layer at all.
 */

import type { ConnectorLogger } from "../types.js"
import type { WhatsappStatusEntry } from "./types.js"

export interface StatusReconcileLink {
  id: string
  deliveryStatus?: string
}

export interface StatusReconcileDeps {
  /** Resolve a wamid → the previously-sent OUTBOUND link (or null). */
  findOutboundLink: (input: {
    transportAccountId: string
    externalMessageId: string
  }) => Promise<StatusReconcileLink | null>
  /** Flip a link to a terminal delivery status with error context. */
  updateLinkStatus: (input: {
    linkId: string
    status: "failed"
    error?: string
    metadata?: Record<string, unknown>
  }) => Promise<unknown>
  logger?: ConnectorLogger
}

/** Lazily wire the real service-layer functions (no top-level DB import). */
async function defaultDeps(
  logger?: ConnectorLogger
): Promise<Omit<StatusReconcileDeps, "logger">> {
  const service = await import("../../service.js")
  return {
    findOutboundLink: async ({ transportAccountId, externalMessageId }) => {
      const link = await service.findTransportMessageLinkByExternalMessage({
        transportAccountId,
        externalMessageId,
        direction: "outbound",
      })
      if (!link) return null
      return { id: link.id, deliveryStatus: link.deliveryStatus }
    },
    updateLinkStatus: async ({ linkId, status, error, metadata }) => {
      return service.updateTransportMessageLinkStatus({
        linkId,
        status,
        ...(error ? { error } : {}),
        ...(metadata ? { metadata } : {}),
      })
    },
    ...(logger ? { logger } : {}),
  }
}

function firstError(entry: WhatsappStatusEntry): {
  code?: number
  title?: string
  detail?: string
} {
  const e = entry.errors?.[0]
  if (!e) return {}
  return {
    ...(typeof e.code === "number" ? { code: e.code } : {}),
    ...(typeof e.title === "string" ? { title: e.title } : {}),
    ...(typeof e.error_data?.details === "string"
      ? { detail: e.error_data.details }
      : {}),
  }
}

/**
 * Process one `value.statuses[]` entry. Only `status:"failed"` triggers a
 * reconcile (sent/delivered/read/played are positive receipts the link is
 * already at-or-past "sent" for, so we leave them). Returns whether a link
 * was flipped (false when no matching outbound link was found — common when
 * the wamid isn't ours, e.g. an echo). Never throws on a missing link.
 */
export async function reconcileWhatsappStatus(input: {
  accountId: string
  entry: WhatsappStatusEntry
  /** Test seam — inject fakes; defaults to the lazy service-layer wiring. */
  deps?: StatusReconcileDeps
  /** Connector logger threaded into the default (real) deps. */
  logger?: ConnectorLogger
}): Promise<boolean> {
  const { accountId, entry } = input
  if (entry.status !== "failed") return false

  const wamid =
    typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : ""
  if (!wamid) return false

  const deps =
    input.deps ?? ((await defaultDeps(input.logger)) as StatusReconcileDeps)
  const logger = deps.logger ?? input.logger

  const link = await deps.findOutboundLink({
    transportAccountId: accountId,
    externalMessageId: wamid,
  })
  if (!link) {
    logger?.warn?.(
      "whatsapp: status=failed for unknown outbound wamid; nothing to flip",
      { accountId, wamid }
    )
    return false
  }

  const err = firstError(entry)
  const errText = err.code
    ? `wa ${err.code}: ${err.title ?? "failed"}${err.detail ? ` — ${err.detail}` : ""}`
    : "whatsapp delivery failed"

  await deps.updateLinkStatus({
    linkId: link.id,
    status: "failed",
    error: errText,
    metadata: {
      // Connector-owned namespace per the contract (metadata.<kind>.*).
      whatsapp: {
        statusError: {
          ...(err.code != null ? { code: err.code } : {}),
          ...(err.title ? { title: err.title } : {}),
          ...(err.detail ? { detail: err.detail } : {}),
        },
      },
    },
  })
  logger?.info?.(
    "whatsapp: flipped outbound link to failed via status webhook",
    {
      accountId,
      wamid,
      linkId: link.id,
      code: err.code,
    }
  )
  return true
}
