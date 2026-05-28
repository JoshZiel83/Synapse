/**
 * Pure credential / config helpers for the accounts domain. Kept DB-free
 * so the test suite can exercise them without pulling in
 * `infrastructure/database` (which creates a long-lived pg.Pool at
 * module-load and prevents the test process from exiting).
 *
 * Implementation lives here; accounts.ts re-exports for back-compat.
 */

import type {
  TransportAccountSummary,
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
 *
 * Throws an Error annotated with `statusCode: 400` and stable `code`
 * fields so the Fastify error handler maps it to a clean 400 instead
 * of swallowing into a 500.
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
    throw Object.assign(
      new Error(
        `No connector registered for transport_kind=${params.transportKind}`
      ),
      { statusCode: 400 as const, code: "transport_kind_unsupported" as const }
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
    throw Object.assign(new Error(message), {
      statusCode: 400 as const,
      code: "transport_credentials_invalid" as const,
    })
  }
  return result.normalized || original
}

/**
 * Validate the `transport_accounts.config` JSONB via the connector's
 * optional `validateConfig?()` hook. Connectors without a config
 * schema pass through (we deliberately do not enforce "no unknown
 * keys" so new per-connector fields can land without coordinated
 * cross-cutting changes).
 *
 * Disabled accounts also skip — they're allowed to hold partially
 * invalid configs until re-enabled.
 *
 * Throws an Error annotated with `statusCode: 400` and stable `code`
 * fields when invalid; mirrors `validateAndNormalizeAccountCredentials`.
 */
export function validateAndNormalizeAccountConfig(params: {
  transportKind: TransportKind
  connectionMode: TransportConnectionMode
  status: "active" | "disabled" | "error"
  config?: Record<string, unknown>
}): Record<string, unknown> {
  const original = params.config || {}
  if (params.status === "disabled") {
    return original
  }
  const connector = tryGetConnector(params.transportKind)
  if (!connector || !connector.validateConfig) {
    return original
  }
  const result = connector.validateConfig({
    connectionMode: params.connectionMode,
    config: original,
  })
  if (!result.ok) {
    const message = result.errors?.length
      ? result.errors.join("; ")
      : `${params.transportKind} config is invalid`
    throw Object.assign(new Error(message), {
      statusCode: 400 as const,
      code: "transport_config_invalid" as const,
    })
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

/**
 * Per-transport route guard. Per-kind PUT endpoints
 * (`PUT /im/accounts/<kind>/:id`) pass their literal kind so that hitting
 * the wrong kind by accountId returns a clean 404 with a stable code
 * instead of silently rewriting the wrong account's metadata. Generic
 * routes that legitimately span kinds omit the expected kind.
 *
 * Accepts either the camelCase `TransportAccountSummary` shape
 * (`transportKind`) or the snake_case raw DB row shape
 * (`transport_kind`). Production controllers call this from raw
 * `loadTransportAccountRow(...)` results (snake_case); normalized
 * callers pass camelCase. Both must yield the same error.
 *
 * The code is `transport_account_kind_mismatch` (not `_not_found`) so
 * UI can distinguish "you supplied a wrong id under this kind" from
 * "the row does not exist at all". The message embeds both the
 * account id (when present) and the expected kind so logs / tests
 * can pin the specific row that was almost-modified.
 */
export function assertExpectedTransportKind(
  existing:
    | { id?: string; transportKind: TransportKind }
    | { id?: string; transport_kind: string },
  expectedKind?: TransportKind
): void {
  if (!expectedKind) return
  const actualKind =
    "transportKind" in existing
      ? existing.transportKind
      : (existing.transport_kind as TransportKind)
  if (actualKind === expectedKind) return
  const id = existing.id ? `${existing.id} ` : ""
  throw Object.assign(
    new Error(
      `Transport account ${id}is not a ${expectedKind} account (was ${actualKind})`
    ),
    {
      statusCode: 404 as const,
      code: "transport_account_kind_mismatch" as const,
    }
  )
}
