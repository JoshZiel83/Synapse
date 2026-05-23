/**
 * Pure credential helpers for the accounts domain. Kept DB-free so the
 * test suite can exercise them without pulling in `infrastructure/database`
 * (which creates a long-lived pg.Pool at module-load and prevents the
 * test process from exiting).
 *
 * Implementation lives here; accounts.ts re-exports for back-compat.
 */

import type {
  TransportConnectionMode,
  TransportKind,
} from "@synapse/shared/types"
import { tryGetConnector } from "../connectors/registry.js"

/**
 * Validate credentials via the connector and return the connector's
 * normalized form when available. The normalized form is what should be
 * persisted to the DB (it has alias keys merged, whitespace trimmed, etc.).
 *
 * Disabled accounts skip validation entirely — they may legitimately have
 * blank or expired credentials waiting to be filled in.
 */
export function validateAndNormalizeAccountCredentials(params: {
  transportKind: TransportKind
  connectionMode: TransportConnectionMode
  status: "active" | "disabled" | "error"
  credentials?: Record<string, unknown>
}): Record<string, unknown> {
  const original = params.credentials || {}
  if (params.status === "disabled") {
    return original
  }
  const connector = tryGetConnector(params.transportKind)
  if (!connector) {
    throw new Error(
      `No connector registered for transport_kind=${params.transportKind}`
    )
  }
  const result = connector.validateCredentials({
    connectionMode: params.connectionMode,
    credentials: original,
  })
  if (!result.ok) {
    const message = result.errors?.length
      ? result.errors.join("; ")
      : `${params.transportKind} credentials are invalid`
    throw new Error(message)
  }
  return result.normalized || original
}

/**
 * Field-by-field merge for partial credential updates. Callers who want a
 * clean replacement send the full object; partial updates (e.g. Feishu
 * PUT with just `{encryptKey}`) keep the other fields intact.
 */
export function mergeAccountCredentials(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown> | undefined
): Record<string, unknown> {
  return incoming ? { ...existing, ...incoming } : existing
}
