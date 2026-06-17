// Live-status constants for the dual-axis plugin roots (review F16). These mirror
// the manifest `liveValues` for plugin_installations / plugin_connections — a
// dual-axis root is "live" only when deleted_at IS NULL AND status ∈ liveValues.
// Kept here (not read from the _live views) because the codegen types every view
// column nullable, which loses the base-table NOT NULL guarantees the callers
// rely on. The guard-soft-delete read ratchet still allows these base-table reads
// at their baselined counts; the explicit predicate below is the same liveness
// definition the views encode.
//
// Source of truth = soft-delete-table-classification.yml liveValues. If those
// change, update here too (a soft-delete regression test asserts the pairing).

import type {
  PluginAuthConnectionStatus,
  WorkspaceAppStatus,
} from "@synapse/shared"

/** plugin_installations live statuses (manifest liveValues: active/disabled/error). */
export const PLUGIN_INSTALLATION_LIVE_STATUSES: readonly WorkspaceAppStatus[] =
  ["active", "disabled", "error"]

/** plugin_connections live statuses (manifest liveValues: active). */
export const PLUGIN_CONNECTION_LIVE_STATUSES: readonly PluginAuthConnectionStatus[] =
  ["active"]
