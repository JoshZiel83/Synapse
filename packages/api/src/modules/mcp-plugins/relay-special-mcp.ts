// relay-special-mcp.ts — DEPRECATED stub (PR #17 of device-runtime v3).
//
// The "special-case relay tool authorization inference" logic (~650 LOC)
// is deleted. v3 callers receive null and skip the legacy inference branch.

import type {
  RelayAuthorizationGrantOption,
  RelayAuthorizationRequestedAction,
} from "@synapse/shared/types"

export type RelaySpecialMcpKind =
  | "filesystem"
  | "commandline"
  | "browser"
  | "cua"

export interface RelaySpecialAuthorizationPlan {
  kind: RelaySpecialMcpKind
  toolStableKey: string
  requestedAction: RelayAuthorizationRequestedAction
  grantOptions: RelayAuthorizationGrantOption[]
  availablePresets: string[]
  reason: string
}

export function inferRelaySpecialAuthorizationPlan(_params: {
  toolStableKey?: string
  visibleToolName: string
  toolInput: Record<string, unknown>
  exposureMetadata: Record<string, unknown>
}): RelaySpecialAuthorizationPlan | null {
  return null
}
