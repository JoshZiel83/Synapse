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
    // statusCode lets the Fastify error handler in src/index.ts surface
    // this as a 400 — without it, generic-route callers see 500.
    throw Object.assign(new Error(message), {
      statusCode: 400 as const,
      code: "transport_credentials_invalid" as const,
    })
  }
  return result.normalized || original
}

/**
 * Validate `transport_accounts.config` via the connector when it
 * implements `validateConfig`. Connectors that don't care about config
 * (current state for feishu/weixin) are no-ops here. Active accounts
 * have their normalized config persisted; disabled accounts skip
 * validation entirely, matching the credentials helper's policy.
 *
 * This is the only enforcement point for connector-specific config
 * constraints. Without it, the generic `accountSchema.config:
 * z.record(z.unknown())` lets `/im/accounts` and `/im/accounts/:id`
 * write arbitrary blobs, bypassing per-connector route refinements
 * like wecom's `wss?/` baseWsUrl check.
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
    // Same statusCode/code pattern as credentials — generic route
    // callers should see 400, not 500.
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
 * Guard the per-transport PUT routes against accidentally updating
 * accounts of a different kind in the same workspace. Throws a
 * statusCode-bearing error that the Fastify error handler in
 * `src/index.ts` surfaces as a 404 with code
 * `transport_account_kind_mismatch`. Lives in this DB-free file so it
 * can be unit-tested without dragging in `infrastructure/database`.
 *
 * Returning normally means it's safe to proceed with the update; any
 * write-side effect must run AFTER this call so that a mismatched kind
 * cannot mutate the wrong account.
 */
export function assertExpectedTransportKind(
  existing: { id: string; transport_kind: string },
  expectedTransportKind: TransportKind | undefined
): void {
  if (!expectedTransportKind) return
  if (existing.transport_kind === expectedTransportKind) return
  throw Object.assign(
    new Error(
      `Transport account ${existing.id} is not a ${expectedTransportKind} account`
    ),
    {
      statusCode: 404 as const,
      code: "transport_account_kind_mismatch" as const,
    }
  )
}
