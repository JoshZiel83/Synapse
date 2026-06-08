#!/usr/bin/env node
// One-shot bootstrap for soft-delete-table-classification.yml.
// Encodes the v8 design's classification rules, emits a fully-populated manifest
// that the derive-fk-policy.mjs gate accepts. Re-runnable (idempotent output).
//
// This is a DEV tool, not a CI gate. The emitted YAML is the checked-in source
// of truth thereafter; hand-edits to the YAML win (this script is only for the
// initial population / regeneration after large schema changes).

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "js-yaml"
import { parseSchema } from "./schema-introspect.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = resolve(here, "../src/infrastructure/database/schema.sql")
const OUT = resolve(
  here,
  "../src/infrastructure/database/soft-delete-table-classification.yml"
)

const { tables, foreignKeys } = parseSchema(readFileSync(SCHEMA_PATH, "utf8"))

// ---------------------------------------------------------------------------
// 1. Soft-delete ROOT entities (softDelete: deleted_at). From design §4.
// ---------------------------------------------------------------------------
const ROOTS = new Set([
  "users",
  "workspaces",
  "actors",
  "remote_agents",
  "remote_agent_machines",
  "conversations",
  "devices",
  "plugin_installations",
  "installed_skills",
  "plugin_connections",
  "catalog_items",
  "publishers",
  "memory_spaces",
  "memory_items",
  "file_spaces",
  "file_assets",
  "model_groups",
  "model_profiles",
  "automation_rules",
  "automation_event_sources",
  "automation_webhook_endpoints",
  "automation_integration_bindings",
  "transport_accounts",
  "account", // BA account: soft-delete + anonymize (§8.2)
])

// Immutable reference registries (softDelete: immutable). §5/§7.4.
const IMMUTABLE = new Set(["access_subjects", "transport_addresses"])

// Junction / membership-grant tables that use single-row status flip (§6).
// status + revoked_at/left_at semantics. live = {active}.
const JUNCTION_STATUS = new Set([
  "workspace_members", // status active|left|removed
  "platform_access_bindings",
  "workspace_access_bindings",
  "resource_access_bindings",
  "model_group_grants",
  "memory_access_grants",
  "file_access_grants",
])

// Append-only logs / immutable history (§3). Never soft-deleted; app role no
// DELETE; offline purge only.
const APPEND_ONLY = new Set([
  "audit_logs",
  "actor_versions",
  "actor_version_docs",
  "model_profile_revisions",
  "catalog_versions",
  "catalog_version_files",
  "skill_versions",
  "skill_snapshots",
  "skill_snapshot_files",
  "device_catalog_revisions",
  "device_tool_revisions",
  "conversation_items",
  "conversation_item_parts",
  "conversation_item_mentions",
  "conversation_item_targets",
  "conversation_item_context_targets",
  "turns",
  "provider_steps",
  "tool_calls",
  "tool_call_task_output_chunks",
  "tool_execution_attempts",
  "tool_results",
  "tool_result_parts",
  "device_operations",
  "device_operation_attempts",
  "device_operation_results",
  "remote_agent_message_deliveries",
  "transport_message_links",
  "runtime_events",
  "workspace_member_sync_events",
  "memory_recall_runs",
  "memory_recall_run_results",
  "context_archive_points",
  "context_archive_frames",
  "context_archive_frame_parts",
  "engine_branch_checkpoints",
  "automation_occurrences",
  "tool_call_task_response_commands",
  "chat_conversation_create_requests",
])

// Ephemeral runtime / set-replace derived tables (§3, §7.5). Controlled hard
// delete via SECURITY DEFINER fn. `derived: true` marks set-replace config.
const EPHEMERAL = new Set([
  "session",
  "verification",
  "device_code",
  "sessions", // engine sessions (runtime)
  "session_wakeups",
  "session_interrupts",
  "session_context_states",
  "session_engine_branches",
  "conversation_context_states",
  "context_compaction_runs",
  "context_compaction_run_inputs",
  "realtime_event_outbox",
  "tool_call_task_action_tokens",
  "tool_call_task_runtime_authorization",
  "tool_call_task_device_tool",
  "tool_call_task_external_mcp",
  "tool_call_task_transport_projections",
  "runtime_authorization_grants",
  "plugin_auth_sessions",
  "device_pairing_sessions",
  "device_control_plane_sessions",
  "device_runtime_sessions",
  "device_runtime_session_services",
  "device_sync_sources",
  "remote_agent_machine_sessions",
  "remote_agent_runs",
  "remote_agent_conversation_contexts",
  "file_mounts",
  "file_parse_runs",
  "file_parse_outputs",
  "memory_embedding_cache",
  "tool_call_tasks",
  "automation_executions",
  "automation_execution_targets",
  "automation_deliveries",
  "automation_delivery_targets",
  "automation_triggers",
  "chat_push_tokens",
])

// set-replace join/config tables that are derived (hard-delete via fn). §7.5.
const DERIVED = new Set([
  "actor_model_group_assignments",
  "plugin_version_runtime_permissions",
  "catalog_item_categories",
  "remote_agent_group_interaction_grants",
  "model_group_profiles",
  "memory_item_chunks", // index rebuild churn
])

// Reference / catalog data (§3). Not user-deletable; no soft-delete column.
const REFERENCE = new Set([
  "content_blobs",
  "payload_blobs",
  "actor_template_version_specs",
  "skill_package_version_specs",
  "plugin_package_version_specs",
  "remote_agent_runtime_catalog",
  "skill_mirror_sources",
  "catalog_categories",
  "transport_endpoints",
  "workspace_capability_conversation_type_policies",
  "file_snapshots", // content-addressed snapshots; immutable-ish history
])

// Live-status value sets for status/state tables (§7.6 — heterogeneous!).
const LIVE_VALUES = {
  workspace_members: ["active"],
  platform_access_bindings: ["active"],
  workspace_access_bindings: ["active"],
  resource_access_bindings: ["active"],
  model_group_grants: ["active"],
  memory_access_grants: ["active"],
  file_access_grants: ["active"],
  // status-bearing roots/ephemeral whose liveness matters for views/triggers:
  sessions: ["idle", "queued", "running", "blocked"],
  device_runtime_sessions: ["open", "closing"],
  device_runtime_session_services: ["open"],
  file_mounts: ["provisioning", "active", "committing"],
  device_services: ["starting", "online", "degraded"],
  device_capabilities: ["active", "deprecated"],
  device_control_plane_sessions: ["connecting", "active", "closing"],
  remote_agent_machine_sessions: ["connecting", "active", "closing"],
  transport_accounts: ["active", "disabled", "error"],
  conversation_participants: ["active"],
  plugin_connections: ["active"],
  plugin_installations: ["active", "disabled", "error"],
  automation_rules: ["active", "paused", "error"],
  automation_event_sources: ["active", "deprecated", "disabled"],
  automation_webhook_endpoints: ["active", "disabled"],
}

// workspaceScope per table.
const NULLABLE_GLOBAL = new Set([
  "catalog_items",
  "publishers",
  "file_assets",
  "model_profiles",
])
const OWNER_DERIVED = {
  model_groups: {
    predicate:
      "(owner_type = 'workspace' AND owner_workspace_id = $1) OR (owner_type = 'workspace_member' AND owner_workspace_member_id IN (SELECT id FROM workspace_members WHERE workspace_id = $1))",
  },
}

// principalColumns: tables whose rows are keyed to a user/member subject and
// must be revoked/closed on markUserDeleted (§5.4).
const PRINCIPAL_COLUMNS = {
  workspace_members: [
    { column: "user_id", resolvesSubject: "user", action: "update" },
  ],
  platform_access_bindings: [
    { column: "user_id", resolvesSubject: "user", action: "revoke" },
  ],
  workspace_access_bindings: [
    {
      column: "workspace_member_id",
      resolvesSubject: "member",
      action: "revoke",
    },
  ],
  chat_client_instances: [
    {
      column: "workspace_member_id",
      resolvesSubject: "member",
      action: "close",
    },
  ],
  workspace_member_preferences: [
    {
      column: "workspace_member_id",
      resolvesSubject: "member",
      action: "update",
    },
  ],
  workspace_relationship_profiles: [
    { column: "subject_id", resolvesSubject: "target", action: "update" },
  ],
  workspace_friend_entries: [
    {
      column: "owner_workspace_member_id",
      resolvesSubject: "member",
      action: "update",
    },
    { column: "peer_subject_id", resolvesSubject: "target", action: "update" },
  ],
  direct_conversation_bindings: [
    {
      column: "participant_one_subject_id",
      resolvesSubject: "target",
      action: "update",
    },
    {
      column: "participant_two_subject_id",
      resolvesSubject: "target",
      action: "update",
    },
  ],
}

// SET NULL whitelist (§7.3). canLose/needsSnapshot per the design's rules:
// attribution (*_by_*) = audit subject → needsSnapshot; runtime pointers
// (conversation_id, session_id, *_item_id, turn_id, payload blobs) = canLose.
function classifySetNull(fk) {
  const col = fk.childColumns.join(",")
  // Attribution / authorship — needs snapshot (audit value).
  const attribution =
    /(created_by|assigned_by|granted_by|resolved_by|installed_by|uploader|requested_by|initiated_by|owner_user_id|created_by_user_id|created_by_actor_id|inbound_actor_id|source_actor_id)/.test(
      col
    )
  // audit_logs identity columns are audit subjects → snapshot before purge (§7.3).
  const auditSubject =
    fk.childTable === "audit_logs" && (col === "user_id" || col === "actor_id")
  if (attribution || auditSubject) {
    return {
      canLose: false,
      needsSnapshot: true,
      snapshotColumn: `${col}_snapshot`,
    }
  }
  // Everything else SET NULL = runtime/derived pointer, losable.
  return { canLose: true, needsSnapshot: false }
}

// ---------------------------------------------------------------------------
// Build manifest
// ---------------------------------------------------------------------------
function classOf(name) {
  if (ROOTS.has(name)) return "root"
  if (IMMUTABLE.has(name)) return "reference"
  if (JUNCTION_STATUS.has(name)) return "junction"
  if (APPEND_ONLY.has(name)) return "append-only"
  if (DERIVED.has(name)) return "ephemeral" // derived flag set separately
  if (EPHEMERAL.has(name)) return "ephemeral"
  if (REFERENCE.has(name)) return "reference"
  // Default: child-owned (aggregate-internal detail).
  return "child"
}

function softDeleteOf(name, cls) {
  if (cls === "root") return "deleted_at"
  if (IMMUTABLE.has(name)) return "immutable"
  if (JUNCTION_STATUS.has(name)) return "status"
  return "none"
}

function workspaceScopeOf(name, tbl) {
  if (!ROOTS.has(name)) {
    // non-roots: declare for completeness based on column presence
    if (OWNER_DERIVED[name]) return "owner-derived"
    const ws = tbl.columns.find((c) => c.name === "workspace_id")
    if (!ws) return "none"
    return /NOT\s+NULL/i.test(ws.raw) ? "workspace_id" : "nullable-global"
  }
  if (OWNER_DERIVED[name]) return "owner-derived"
  if (NULLABLE_GLOBAL.has(name)) return "nullable-global"
  const ws = tbl.columns.find((c) => c.name === "workspace_id")
  if (!ws) return "none"
  return /NOT\s+NULL/i.test(ws.raw) ? "workspace_id" : "nullable-global"
}

const outTables = {}
for (const [name, tbl] of [...tables].sort()) {
  const cls = classOf(name)
  const entry = { class: cls, softDelete: softDeleteOf(name, cls) }
  if (DERIVED.has(name)) entry.derived = true
  // BA-owned ephemeral tables
  if (["session", "verification", "device_code"].includes(name))
    entry.baOwned = true

  const ws = workspaceScopeOf(name, tbl)
  entry.workspaceScope = ws
  if (ws === "owner-derived" && OWNER_DERIVED[name])
    entry.workspaceScopePredicate = OWNER_DERIVED[name].predicate

  if (entry.softDelete === "status") {
    entry.liveValues = LIVE_VALUES[name] || ["active"]
  }
  // status tables that aren't junction but carry live semantics for views
  if (entry.softDelete !== "status" && LIVE_VALUES[name]) {
    entry.liveValues = LIVE_VALUES[name]
  }

  if (PRINCIPAL_COLUMNS[name]) entry.principalColumns = PRINCIPAL_COLUMNS[name]

  // deleteWhitelist: ephemeral/derived tables get a named cleanup op
  if (cls === "ephemeral" || entry.derived) {
    entry.deleteWhitelist = entry.baOwned
      ? ["ba-kernel", "revokeAuthRuntimeForUser"]
      : ["securityDefinerFn"]
  }

  outTables[name] = entry
}

// FK policy
const outFks = {}
for (const fk of foreignKeys) {
  const childEntry = outTables[fk.childTable]
  const childEphemeral =
    childEntry &&
    (childEntry.class === "ephemeral" ||
      childEntry.derived === true ||
      childEntry.class === "append-only")

  let targetAction
  if (fk.onDelete === "SET NULL") {
    targetAction = "SET NULL"
  } else if (childEphemeral) {
    // ephemeral/derived/append-only child: parent delete only happens at purge;
    // keep RESTRICT (zero cascade per §0.2) — purge deletes leaf-first explicitly.
    targetAction = "RESTRICT"
  } else {
    targetAction = "RESTRICT"
  }

  const reg = { targetAction }
  if (targetAction === "SET NULL") reg.setNull = classifySetNull(fk)
  // annotate for human review
  reg._child = `${fk.childTable}(${fk.childColumns.join(",")})`
  reg._parent = `${fk.referencedTable}(${fk.referencedColumns.join(",")})`
  reg._was = fk.onDelete
  outFks[fk.key] = reg
}

const manifest = {
  // Header doc
  _doc:
    "Soft-delete classification manifest — single source of truth (design §7.6). " +
    "Edit by hand; derive-fk-policy.mjs is the CI gate. Generated initially by bootstrap-soft-delete-manifest.mjs.",
  tables: outTables,
  foreignKeys: outFks,
}

writeFileSync(OUT, yaml.dump(manifest, { lineWidth: 120, sortKeys: false }))
console.log(
  `Wrote ${OUT}: ${Object.keys(outTables).length} tables, ${Object.keys(outFks).length} FKs.`
)
