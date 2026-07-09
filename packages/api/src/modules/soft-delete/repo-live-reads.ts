// Soft-delete repo read helpers — the canonical "live" query surface.
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
export const liveWorkspaces = (db: Executor) => db.selectFrom("workspacesLive")
export const liveUsers = (db: Executor) => db.selectFrom("usersLive")
export const liveActors = (db: Executor) => db.selectFrom("actorsLive")
export const liveRemoteAgents = (db: Executor) =>
  db.selectFrom("remoteAgentsLive")
export const liveConversations = (db: Executor) =>
  db.selectFrom("conversationsLive")
export const liveConversationParticipants = (db: Executor) =>
  db.selectFrom("conversationParticipantsLive")
export const liveDevices = (db: Executor) => db.selectFrom("devicesLive")
export const liveRuntimes = (db: Executor) => db.selectFrom("runtimesLive")
export const livePluginInstallations = (db: Executor) =>
  db.selectFrom("pluginInstallationsLive")
export const liveInstalledSkills = (db: Executor) =>
  db.selectFrom("installedSkillsLive")
export const liveMemorySpaces = (db: Executor) =>
  db.selectFrom("memorySpacesLive")
export const liveMemoryItems = (db: Executor) =>
  db.selectFrom("memoryItemsLive")
export const liveFileSpaces = (db: Executor) => db.selectFrom("fileSpacesLive")
export const liveFileAssets = (db: Executor) => db.selectFrom("fileAssetsLive")
export const liveModelGroups = (db: Executor) =>
  db.selectFrom("modelGroupsLive")
export const liveModelBindings = (db: Executor) =>
  db.selectFrom("modelBindingsLive")
export const liveCatalogItems = (db: Executor) =>
  db.selectFrom("catalogItemsLive")
export const livePublishers = (db: Executor) => db.selectFrom("publishersLive")
export const liveTransportAccounts = (db: Executor) =>
  db.selectFrom("transportAccountsLive")

/** Live (active) workspace members. status ∈ {active}; excludes left/removed. */
export const liveWorkspaceMembers = (db: Executor) =>
  db.selectFrom("workspaceMembersLive")

/** Runtime child live views (§8.6) — hide children of soft-closed runtimes. */
export const liveRuntimeServices = (db: Executor) =>
  db.selectFrom("runtimeServicesLive")
export const liveRuntimeExposures = (db: Executor) =>
  db.selectFrom("runtimeExposuresLive")
export const liveRuntimeCapabilities = (db: Executor) =>
  db.selectFrom("runtimeCapabilitiesLive")
export const liveRuntimeTools = (db: Executor) =>
  db.selectFrom("runtimeToolsLive")

/**
 * SQL predicate fragment for "user is live" — for raw/compiled queries that
 * cannot route through a view. Use as `... AND <alias>.deleted_at IS NULL`.
 */
export const LIVE_PREDICATE = "deleted_at IS NULL"
