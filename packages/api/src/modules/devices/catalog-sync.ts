// Catalog persistence helper. Called from control-plane.ts when a device
// sends `device.catalog.sync` over the WSS Control Plane (§7.1). Closes the
// loop between what the runtime advertises and what capability-projection
// reads from `device_exposures` / `device_capabilities` / `device_tools` /
// `device_tool_revisions` / `device_catalog_revisions`.
//
// Idempotency contract:
//  - For each incoming exposure: upsert by (device_id, stable_key) and bump
//    runtime_status + last_seen_at. Create the matching device_capabilities
//    row if missing (workspace_id from devices.workspace_id).
//  - Compute a stable schema_hash from the exposure's tool set. If it has
//    moved since the last device_catalog_revisions row for this exposure,
//    create a new revision (revision_seq = max+1) and mark the previous one
//    superseded.
//  - For each tool: upsert device_tools by (exposure_id, stable_key) and
//    insert a device_tool_revisions row tied to the current revision; bump
//    device_tools.latest_revision_id.
//
// The persistence itself is a single large db.transaction() spanning six
// tables plus the cross-module workspace_apps writes; atomicity is
// load-bearing, so the whole orchestration lives in the module's repo.ts (the
// only DB-client owner, guard r8). This file re-exports it unchanged so the
// `device.catalog.sync` call site (control-plane.ts) is untouched.

export {
  persistCatalogSync,
  type PersistCatalogSyncInput,
  type PersistCatalogSyncResult,
  type AssignedToolIds,
  type AssignedExposureIds,
  type AssignedCatalogIds,
} from "./repo.js"
