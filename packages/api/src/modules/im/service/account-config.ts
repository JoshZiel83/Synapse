/**
 * Pure config helpers for the accounts domain. Mirrors
 * `account-credentials.ts` — kept DB-free so the test suite can exercise
 * the per-transport normalize/validate logic without booting the pg.Pool.
 *
 * Why a service-layer normalizer exists at all (when each transport's
 * controller could just call its own validator): the generic
 * `/im/accounts` create/update route accepts `config: z.record(z.unknown())`
 * and passes it straight to the service. Without enforcement here a
 * client could still POST `{transportKind: "qq", config: {configuredUrlDomains:
 * ["*.evil"]}}` via the generic endpoint and bypass the QQ-specific
 * controller's validator entirely. Putting the normalizer in the
 * service makes the database the single source of truth: nothing
 * persists without passing through here.
 */

import type { TransportKind } from "@synapse/shared/types"
import { normalizeQqAccountConfig } from "../connectors/qq/qq-account-config.js"

/**
 * Normalize + validate an `account.config` payload according to the
 * connector's contract. Throws (typically a `ZodError` for QQ) on
 * invalid input — controllers map the throw to a 400.
 *
 * Pass-through for transports without a dedicated config schema; we
 * intentionally do NOT enforce "no unknown keys" globally so new
 * connector-specific config fields can land without a coordinated
 * cross-cutting change.
 */
export function validateAndNormalizeAccountConfig(params: {
  transportKind: TransportKind
  config: Record<string, unknown> | undefined
}): Record<string, unknown> {
  const raw = params.config ?? {}
  switch (params.transportKind) {
    case "qq": {
      const normalized = normalizeQqAccountConfig(raw)
      // The Zod-parsed type has typed fields; cast back to the loose
      // record shape the persistence layer takes (jsonb column).
      return { ...(normalized as unknown as Record<string, unknown>) }
    }
    default:
      return raw
  }
}
