// Soft-delete read helpers — the canonical "live" query surface.
//
// Design §8.1/§8.5: business reads must not leak soft-deleted rows. These
// helpers return Kysely query builders rooted at the generated `<t>_live` views
// (deleted_at IS NULL for roots; status ∈ liveValues for status tables), so a
// caller that uses them cannot forget the filter. Raw/compiled paths and the
// few legitimate "include deleted" reads (admin/audit/restore) go through the
// base tables explicitly and are named accordingly.
//
// The lint rule (scripts/guard-soft-delete-reads.mjs) flags naked
// `selectFrom("<managed-root>")` outside this module and a small allowlist.

import type { Executor } from "../../infrastructure/database/kysely.js"

/**
 * Live workspaces (not soft-deleted). Prefer over `selectFrom("workspaces")`.
 */
export const liveWorkspaces = (db: Executor) => db.selectFrom("workspaces_live")
export const liveUsers = (db: Executor) => db.selectFrom("users_live")
export const liveActors = (db: Executor) => db.selectFrom("actors_live")
export const liveRemoteAgents = (db: Executor) =>
  db.selectFrom("remote_agents_live")
export const liveConversations = (db: Executor) =>
  db.selectFrom("conversations_live")
export const liveDevices = (db: Executor) => db.selectFrom("devices_live")
export const livePluginInstallations = (db: Executor) =>
  db.selectFrom("plugin_installations_live")
export const liveInstalledSkills = (db: Executor) =>
  db.selectFrom("installed_skills_live")
export const liveMemorySpaces = (db: Executor) =>
  db.selectFrom("memory_spaces_live")
export const liveMemoryItems = (db: Executor) =>
  db.selectFrom("memory_items_live")
export const liveFileSpaces = (db: Executor) =>
  db.selectFrom("file_spaces_live")
export const liveFileAssets = (db: Executor) =>
  db.selectFrom("file_assets_live")
export const liveModelGroups = (db: Executor) =>
  db.selectFrom("model_groups_live")
export const liveModelProfiles = (db: Executor) =>
  db.selectFrom("model_profiles_live")
export const liveCatalogItems = (db: Executor) =>
  db.selectFrom("catalog_items_live")
export const livePublishers = (db: Executor) => db.selectFrom("publishers_live")
export const liveTransportAccounts = (db: Executor) =>
  db.selectFrom("transport_accounts_live")

/** Live (active) workspace members. status ∈ {active}; excludes left/removed. */
export const liveWorkspaceMembers = (db: Executor) =>
  db.selectFrom("workspace_members_live")

/** Device child live views (§8.6) — hide children of soft-closed devices. */
export const liveDeviceServices = (db: Executor) =>
  db.selectFrom("device_services_live")
export const liveDeviceExposures = (db: Executor) =>
  db.selectFrom("device_exposures_live")
export const liveDeviceCapabilities = (db: Executor) =>
  db.selectFrom("device_capabilities_live")
export const liveDeviceTools = (db: Executor) =>
  db.selectFrom("device_tools_live")

/**
 * SQL predicate fragment for "user is live" — for raw/compiled queries that
 * cannot route through a view. Use as `... AND <alias>.deleted_at IS NULL`.
 */
export const LIVE_PREDICATE = "deleted_at IS NULL"
