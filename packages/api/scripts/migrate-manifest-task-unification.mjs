// One-shot surgical migration of soft-delete-table-classification.yml for the
// task unification: interaction_* tables → tool_call_task_* tables, preserving
// ALL other manual liveIntegrity/liveParents tuning (which bootstrap drops).
import { readFileSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "js-yaml"
import { parseSchema } from "./schema-introspect.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const MANIFEST = resolve(
  here,
  "../src/infrastructure/database/soft-delete-table-classification.yml"
)
const SCHEMA = resolve(here, "../src/infrastructure/database/schema.sql")

const m = yaml.load(readFileSync(MANIFEST, "utf8"))
const schema = parseSchema(readFileSync(SCHEMA, "utf8"))
const liveKeys = new Set(schema.foreignKeys.map((fk) => fk.key))
const liveTables = new Set([...schema.tables.keys()])

// 1. tables: drop dead interaction_* entries; add task tables mirroring the old
//    classifications. human_input/plan_approval folded → no detail tables.
const DROP_TABLES = [
  "interaction_requests",
  "interaction_user_input_requests",
  "interaction_plan_approval_requests",
  "interaction_runtime_authorization_requests",
  "interaction_action_tokens",
  "interaction_transport_projections",
  "interaction_response_commands",
]
for (const t of DROP_TABLES) delete m.tables[t]

// Mirror the old ephemeral/securityDefinerFn classification (all task detail +
// satellite tables are workspace-scoped ephemeral data the purge fn deletes;
// response_commands is append-only). tool_call_tasks itself already exists.
const ADD_TABLES = {
  tool_call_task_runtime_authorization: {
    class: "ephemeral",
    softDelete: "none",
    workspaceScope: "none",
    deleteWhitelist: ["securityDefinerFn"],
  },
  tool_call_task_device_tool: {
    class: "ephemeral",
    softDelete: "none",
    workspaceScope: "none",
    deleteWhitelist: ["securityDefinerFn"],
  },
  tool_call_task_external_mcp: {
    class: "ephemeral",
    softDelete: "none",
    workspaceScope: "none",
    deleteWhitelist: ["securityDefinerFn"],
  },
  tool_call_task_action_tokens: {
    class: "ephemeral",
    softDelete: "none",
    workspaceScope: "none",
    deleteWhitelist: ["securityDefinerFn"],
  },
  tool_call_task_transport_projections: {
    class: "ephemeral",
    softDelete: "none",
    workspaceScope: "workspace_id",
    deleteWhitelist: ["securityDefinerFn"],
  },
  tool_call_task_response_commands: {
    class: "append-only",
    softDelete: "none",
    workspaceScope: "none",
  },
}
for (const [t, cfg] of Object.entries(ADD_TABLES)) {
  if (!liveTables.has(t)) throw new Error(`add table ${t} not in schema`)
  m.tables[t] = cfg
}

// Sanity: every manifest table must exist in schema, and vice-versa.
for (const t of Object.keys(m.tables))
  if (!liveTables.has(t)) throw new Error(`manifest table ${t} not in schema`)
for (const t of liveTables)
  if (!m.tables[t]) throw new Error(`schema table ${t} missing from manifest`)

// 2. foreignKeys: drop entries whose key no longer exists; add new keys.
//    For each new FK derive targetAction from schema ON DELETE + setNull triple.
//    liveIntegrity is only required when the CHILD is non-ephemeral (rule above)
//    — all our new child tables are ephemeral, so no liveIntegrity needed; the
//    repointed grant FKs (memory/file/runtime grants → tool_call_tasks) keep
//    their existing manifest entry because tool_call_tasks has no live view
//    (ephemeral parent), so they also need no liveIntegrity.
const fkByKey = new Map(schema.foreignKeys.map((fk) => [fk.key, fk]))

// drop dead
for (const key of Object.keys(m.foreignKeys)) {
  if (!liveKeys.has(key)) delete m.foreignKeys[key]
}

// helper: does a parent table have a live view (soft-delete root/junction)?
function parentHasLiveView(parent) {
  const e = m.tables[parent]
  if (!e) return false
  return e.softDelete === "deleted_at" || e.softDelete === "status"
}
function childIsEphemeral(child) {
  // Match the deriver's tableIsEphemeral exactly: ephemeral class or derived
  // ONLY (append-only is NOT treated as ephemeral for the live-parent rule).
  const e = m.tables[child]
  return e && (e.class === "ephemeral" || e.derived === true)
}

let added = 0
for (const fk of schema.foreignKeys) {
  if (m.foreignKeys[fk.key]) continue // already present (unchanged FK)
  const entry = { targetAction: fk.onDelete }
  if (fk.onDelete === "SET NULL") {
    // created_by_workspace_member_id keeps its actor via a snapshot column
    // (the prevailing audit pattern); other task back-pointers lose softly.
    const col = fk.childColumns[0]
    if (col === "created_by_workspace_member_id") {
      entry.setNull = {
        canLose: false,
        needsSnapshot: true,
        snapshotColumn: "created_by_workspace_member_id_snapshot",
      }
    } else {
      entry.setNull = { canLose: true, needsSnapshot: false }
    }
  }
  // liveIntegrity required only for non-ephemeral child → live parent.
  if (
    !childIsEphemeral(fk.childTable) &&
    parentHasLiveView(fk.referencedTable)
  ) {
    // Snapshot-backed SET NULL → historical (matches the prevailing pattern);
    // otherwise single-column → enforce, multi-column → historical.
    if (entry.setNull?.needsSnapshot) {
      entry.liveIntegrity = "historical"
    } else {
      entry.liveIntegrity =
        fk.childColumns.length === 1 ? "enforce" : "historical"
    }
  }
  // _child/_parent annotations for human readability (match existing style).
  entry._child = `${fk.childTable}(${fk.childColumns.join(",")})`
  entry._parent = `${fk.referencedTable}(${fk.referencedColumns.join(",")})`
  m.foreignKeys[fk.key] = entry
  added++
}

writeFileSync(MANIFEST, yaml.dump(m, { lineWidth: 120, sortKeys: false }))
console.log(
  `migrated manifest: -${DROP_TABLES.length} tables, +${Object.keys(ADD_TABLES).length} tables, +${added} FK entries, ${Object.keys(m.foreignKeys).length} FKs total`
)
