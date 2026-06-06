#!/usr/bin/env node
// derive-fk-policy: the soft-delete manifest CI gate + policy generator.
//
// Reads:
//   - src/infrastructure/database/schema.sql        (authoritative DDL)
//   - src/infrastructure/database/soft-delete-table-classification.yml (manifest)
//
// Produces:
//   - docs/fk-policy.generated.md  (human-reviewable: per-table classification +
//     per-FK target ON DELETE action + soft-delete-aware integrity matrix)
//
// Enforces (exit 1 on any violation):
//   1. Every table in schema.sql is registered in the manifest (and no manifest
//      entry references a non-existent table).
//   2. Every FK in schema.sql is registered in the manifest by its stable key.
//   3. Every root-entity (softDelete: deleted_at) table declares workspaceScope.
//   4. Every softDelete:status (or runtime-close) table declares liveValues or
//      livePredicate.
//   5. Every FK whose target action is SET NULL carries the {canLose,
//      needsSnapshot, snapshotColumn?} triple.
//   6. Every principalColumns entry names a real column.
//   7. The manifest's declared target ON DELETE for each FK is one of the
//      allowed actions and is consistent with the table classification policy
//      (no CASCADE on persistent business tables; SET NULL only where the
//      manifest whitelists it).
//
// Usage:
//   node scripts/derive-fk-policy.mjs            # generate + check
//   node scripts/derive-fk-policy.mjs --check    # check only (CI; fails if the
//                                                # generated doc would change)

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "js-yaml"
import { parseSchema } from "./schema-introspect.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = resolve(here, "../src/infrastructure/database/schema.sql")
const MANIFEST_PATH = resolve(
  here,
  "../src/infrastructure/database/soft-delete-table-classification.yml"
)
const OUT_PATH = resolve(here, "../../../docs/fk-policy.generated.md")

const CHECK_ONLY = process.argv.includes("--check")

const VALID_CLASSES = [
  "root",
  "junction",
  "child",
  "append-only",
  "ephemeral",
  "reference",
]
const VALID_SOFT_DELETE = ["deleted_at", "status", "none", "immutable"]
const VALID_ACTIONS = ["RESTRICT", "NO ACTION", "SET NULL", "CASCADE"]
const VALID_SUBJECT_ROLES = ["user", "member", "scope", "target"]
const VALID_PRINCIPAL_ACTIONS = ["revoke", "close", "update"]
const VALID_LIVE_INTEGRITY = ["enforce", "historical", "none"]
const ADDITIONAL_PARENT_FOLDING_LIVE_VIEW_TABLES = new Set(["device_exposures"])

function fail(errors) {
  console.error(`\n✗ derive-fk-policy: ${errors.length} violation(s):\n`)
  for (const e of errors) console.error("  - " + e)
  console.error("")
  process.exit(1)
}

function main() {
  const errors = []
  const sql = readFileSync(SCHEMA_PATH, "utf8")
  const { tables, enums, foreignKeys } = parseSchema(sql)

  if (!existsSync(MANIFEST_PATH)) {
    console.error(
      `✗ manifest not found: ${MANIFEST_PATH}\n` +
        `  Schema has ${tables.size} tables and ${foreignKeys.length} FKs that need classification.`
    )
    process.exit(1)
  }
  const manifest = yaml.load(readFileSync(MANIFEST_PATH, "utf8")) || {}
  const mTables = manifest.tables || {}
  const mForeignKeys = manifest.foreignKeys || {}
  const tableIsEphemeral = (entry) =>
    entry?.class === "ephemeral" || entry?.derived === true
  const tableHasDeclaredLiveSemantics = (entry) =>
    (Array.isArray(entry?.liveValues) && entry.liveValues.length) ||
    Boolean(entry?.livePredicate)
  const tableHasManifestLiveView = (name, entry) =>
    !tableIsEphemeral(entry) &&
    (tableHasDeclaredLiveSemantics(entry) ||
      ADDITIONAL_PARENT_FOLDING_LIVE_VIEW_TABLES.has(name))
  const tableHasLiveView = (name, entry) =>
    entry?.softDelete === "deleted_at" ||
    entry?.softDelete === "status" ||
    tableHasManifestLiveView(name, entry)

  // --- 1. table coverage --------------------------------------------------
  for (const name of tables.keys()) {
    if (!mTables[name]) errors.push(`table not registered in manifest: ${name}`)
  }
  for (const name of Object.keys(mTables)) {
    if (!tables.has(name))
      errors.push(`manifest references non-existent table: ${name}`)
  }

  // --- per-table validations ---------------------------------------------
  for (const [name, entry] of Object.entries(mTables)) {
    if (!tables.has(name)) continue
    const tbl = tables.get(name)
    const cols = new Set(tbl.columns.map((c) => c.name))

    if (!VALID_CLASSES.includes(entry.class))
      errors.push(`${name}: invalid class '${entry.class}'`)
    if (!VALID_SOFT_DELETE.includes(entry.softDelete))
      errors.push(`${name}: invalid softDelete '${entry.softDelete}'`)

    // root w/ deleted_at must declare workspaceScope (rule 3)
    if (entry.softDelete === "deleted_at") {
      if (!cols.has("deleted_at"))
        errors.push(
          `${name}: softDelete=deleted_at but column deleted_at absent`
        )
      if (!entry.workspaceScope)
        errors.push(`${name}: softDelete=deleted_at requires workspaceScope`)
    }
    if (
      entry.workspaceScope &&
      !["workspace_id", "owner-derived", "nullable-global", "none"].includes(
        entry.workspaceScope
      )
    )
      errors.push(`${name}: invalid workspaceScope '${entry.workspaceScope}'`)
    if (
      entry.workspaceScope === "owner-derived" &&
      !entry.workspaceScopePredicate
    )
      errors.push(
        `${name}: workspaceScope=owner-derived requires workspaceScopePredicate`
      )

    // status tables must declare liveValues|livePredicate (rule 4)
    if (entry.softDelete === "status") {
      if (
        !(Array.isArray(entry.liveValues) && entry.liveValues.length) &&
        !entry.livePredicate
      )
        errors.push(
          `${name}: softDelete=status requires liveValues or livePredicate`
        )
      // rule 4b (review F1/F3): a status junction must declare liveParents — the
      // parent rows whose own liveness gates this junction's liveness. The
      // generated `_live` view folds these in (JOIN parent _live) and the
      // FK-liveness trigger rechecks them on a dead->live status revive.
      if (!Array.isArray(entry.liveParents) || !entry.liveParents.length)
        errors.push(
          `${name}: softDelete=status requires liveParents (parent-liveness chain)`
        )
    }

    // liveParents: each names a real FK column on this table and a parent that
    // is itself a soft-delete table (deleted_at root or status junction).
    for (const lp of entry.liveParents || []) {
      if (!cols.has(lp.column))
        errors.push(
          `${name}: liveParents.column '${lp.column}' not a real column`
        )
      const pe = mTables[lp.parent]
      if (!pe)
        errors.push(
          `${name}.${lp.column}: liveParents.parent '${lp.parent}' not in manifest`
        )
      else if (pe.softDelete !== "deleted_at" && pe.softDelete !== "status")
        errors.push(
          `${name}.${lp.column}: liveParents.parent '${lp.parent}' is not a soft-delete table (softDelete=${pe.softDelete})`
        )
    }

    // principalColumns reference real columns (rule 6)
    for (const pc of entry.principalColumns || []) {
      if (!cols.has(pc.column))
        errors.push(
          `${name}: principalColumns.column '${pc.column}' not a real column`
        )
      if (!VALID_SUBJECT_ROLES.includes(pc.resolvesSubject))
        errors.push(
          `${name}.${pc.column}: invalid resolvesSubject '${pc.resolvesSubject}'`
        )
      if (!VALID_PRINCIPAL_ACTIONS.includes(pc.action))
        errors.push(
          `${name}.${pc.column}: invalid principal action '${pc.action}'`
        )
    }
  }

  // --- 2/5/7. FK coverage + policy ---------------------------------------
  const fkByKey = new Map(foreignKeys.map((fk) => [fk.key, fk]))
  for (const fk of foreignKeys) {
    const reg = mForeignKeys[fk.key]
    if (!reg) {
      errors.push(
        `FK not registered: ${fk.key} (${fk.childTable}(${fk.childColumns.join(",")}) -> ${fk.referencedTable}; current ON DELETE ${fk.onDelete}; line ${fk.lineno})`
      )
      continue
    }
    if (!VALID_ACTIONS.includes(reg.targetAction))
      errors.push(`FK ${fk.key}: invalid targetAction '${reg.targetAction}'`)
    if (
      reg.liveIntegrity !== undefined &&
      !VALID_LIVE_INTEGRITY.includes(reg.liveIntegrity)
    ) {
      errors.push(`FK ${fk.key}: invalid liveIntegrity '${reg.liveIntegrity}'`)
    }

    // rule 7: no CASCADE on persistent parents/children.
    const childEntry = mTables[fk.childTable]
    const parentEntry = mTables[fk.referencedTable]
    const childEphemeral =
      childEntry &&
      (childEntry.class === "ephemeral" ||
        childEntry.derived === true ||
        childEntry.class === "append-only")
    if (reg.targetAction === "CASCADE" && !childEphemeral) {
      errors.push(
        `FK ${fk.key}: CASCADE only permitted when child is ephemeral/derived/append-only (child ${fk.childTable} class=${childEntry?.class}${childEntry?.derived ? " derived" : ""})`
      )
    }

    // rule 5: SET NULL requires triple.
    if (reg.targetAction === "SET NULL") {
      const t = reg.setNull
      if (
        !t ||
        typeof t.canLose !== "boolean" ||
        typeof t.needsSnapshot !== "boolean"
      )
        errors.push(
          `FK ${fk.key}: targetAction=SET NULL requires setNull:{canLose,needsSnapshot,snapshotColumn?}`
        )
      else if (t.needsSnapshot && !t.snapshotColumn)
        errors.push(
          `FK ${fk.key}: setNull.needsSnapshot=true requires snapshotColumn`
        )
    }
    if (
      childEntry &&
      parentEntry &&
      !tableIsEphemeral(childEntry) &&
      tableHasLiveView(fk.referencedTable, parentEntry)
    ) {
      if (!reg.liveIntegrity) {
        errors.push(
          `FK ${fk.key}: references live parent ${fk.referencedTable}; requires liveIntegrity=enforce|historical|none`
        )
      } else if (
        reg.liveIntegrity === "enforce" &&
        (fk.childColumns.length !== 1 || fk.referencedColumns.length !== 1)
      ) {
        errors.push(
          `FK ${fk.key}: liveIntegrity=enforce currently supports single-column FKs only`
        )
      }
    }

    // rule 8 (cutover): the schema's ACTUAL ON DELETE must match the manifest's
    // targetAction. NO ACTION and RESTRICT are both non-cascading and treated as
    // interchangeable (the 3 deferred composite FKs are NO ACTION by design).
    const schemaAction = fk.onDelete
    const target = reg.targetAction
    const bothNonCascade = (a) => a === "RESTRICT" || a === "NO ACTION"
    const matches =
      schemaAction === target ||
      (bothNonCascade(schemaAction) && bothNonCascade(target))
    if (!matches) {
      errors.push(
        `FK ${fk.key}: schema ON DELETE ${schemaAction} != manifest targetAction ${target} (${fk.childTable}(${fk.childColumns.join(",")}) line ${fk.lineno})`
      )
    }
  }
  for (const key of Object.keys(mForeignKeys)) {
    if (!fkByKey.has(key))
      errors.push(`manifest references non-existent FK key: ${key}`)
  }

  if (errors.length) fail(errors)

  // --- emit doc -----------------------------------------------------------
  const doc = renderDoc({ tables, enums, foreignKeys, mTables, mForeignKeys })
  if (CHECK_ONLY) {
    const existing = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, "utf8") : ""
    if (existing.trim() !== doc.trim()) {
      console.error(
        "✗ fk-policy.generated.md is stale — run `node scripts/derive-fk-policy.mjs` and commit."
      )
      process.exit(1)
    }
    console.log(
      "✓ derive-fk-policy: manifest covers all tables/FKs; doc up-to-date."
    )
  } else {
    writeFileSync(OUT_PATH, doc)
    console.log(
      `✓ derive-fk-policy: ${tables.size} tables, ${foreignKeys.length} FKs all classified. Wrote ${OUT_PATH}`
    )
  }
}

function renderDoc({ tables, foreignKeys, mTables, mForeignKeys }) {
  const lines = []
  lines.push(
    "# FK Policy — generated from soft-delete-table-classification.yml"
  )
  lines.push("")
  lines.push(
    "> **GENERATED FILE — do not edit by hand.** Run `node scripts/derive-fk-policy.mjs`."
  )
  lines.push(
    "> Source of truth: `packages/api/src/infrastructure/database/soft-delete-table-classification.yml`."
  )
  lines.push("")

  // class histogram
  const byClass = {}
  for (const e of Object.values(mTables))
    byClass[e.class] = (byClass[e.class] || 0) + 1
  lines.push("## Table classification (counts)")
  lines.push("")
  lines.push("| class | count |")
  lines.push("|---|---|")
  for (const c of VALID_CLASSES) lines.push(`| ${c} | ${byClass[c] || 0} |`)
  lines.push(`| **total** | **${tables.size}** |`)
  lines.push("")

  // soft-delete roots
  const roots = Object.entries(mTables)
    .filter(([, e]) => e.softDelete === "deleted_at")
    .map(([n]) => n)
    .sort()
  lines.push(`## Soft-delete roots (deleted_at) — ${roots.length}`)
  lines.push("")
  lines.push(roots.map((r) => "`" + r + "`").join(", "))
  lines.push("")

  // status tables
  const statusTables = Object.entries(mTables)
    .filter(([, e]) => e.softDelete === "status")
    .map(
      ([n, e]) =>
        `\`${n}\` live=${JSON.stringify(e.liveValues || e.livePredicate)}`
    )
    .sort()
  lines.push(`## Status-flip tables — ${statusTables.length}`)
  lines.push("")
  for (const s of statusTables) lines.push("- " + s)
  lines.push("")

  // FK action histogram (target)
  const byAction = {}
  for (const fk of foreignKeys) {
    const a = mForeignKeys[fk.key]?.targetAction || "?"
    byAction[a] = (byAction[a] || 0) + 1
  }
  lines.push("## FK target ON DELETE distribution")
  lines.push("")
  lines.push("| target action | count |")
  lines.push("|---|---|")
  for (const a of VALID_ACTIONS) lines.push(`| ${a} | ${byAction[a] || 0} |`)
  lines.push(`| **total** | **${foreignKeys.length}** |`)
  lines.push("")

  const byLiveIntegrity = {}
  for (const fk of foreignKeys) {
    const v = mForeignKeys[fk.key]?.liveIntegrity || "—"
    byLiveIntegrity[v] = (byLiveIntegrity[v] || 0) + 1
  }
  lines.push("## FK live integrity distribution")
  lines.push("")
  lines.push("| live integrity | count |")
  lines.push("|---|---|")
  for (const v of [...VALID_LIVE_INTEGRITY, "—"]) {
    lines.push(`| ${v} | ${byLiveIntegrity[v] || 0} |`)
  }
  lines.push(`| **total** | **${foreignKeys.length}** |`)
  lines.push("")

  // SET NULL whitelist
  const setNulls = foreignKeys
    .filter((fk) => mForeignKeys[fk.key]?.targetAction === "SET NULL")
    .sort((a, b) => a.childTable.localeCompare(b.childTable))
  lines.push(`## SET NULL whitelist — ${setNulls.length}`)
  lines.push("")
  lines.push(
    "| child | column(s) | -> parent | canLose | needsSnapshot | snapshotColumn |"
  )
  lines.push("|---|---|---|---|---|---|")
  for (const fk of setNulls) {
    const t = mForeignKeys[fk.key].setNull || {}
    lines.push(
      `| ${fk.childTable} | ${fk.childColumns.join(",")} | ${fk.referencedTable} | ${t.canLose} | ${t.needsSnapshot} | ${t.snapshotColumn || "—"} |`
    )
  }
  lines.push("")

  // full FK table (sorted)
  lines.push("## All foreign keys (target policy)")
  lines.push("")
  lines.push(
    "| child(cols) | -> parent(cols) | schema ON DELETE | target ON DELETE | live integrity | source | key |"
  )
  lines.push("|---|---|---|---|---|---|---|")
  const sorted = [...foreignKeys].sort(
    (a, b) =>
      a.childTable.localeCompare(b.childTable) ||
      a.childColumns.join().localeCompare(b.childColumns.join())
  )
  for (const fk of sorted) {
    const reg = mForeignKeys[fk.key] || {}
    lines.push(
      `| ${fk.childTable}(${fk.childColumns.join(",")}) | ${fk.referencedTable}(${fk.referencedColumns.join(",")}) | ${fk.onDelete} | ${reg.targetAction || "?"} | ${reg.liveIntegrity || "—"} | ${fk.source} | ${fk.key} |`
    )
  }
  lines.push("")

  return lines.join("\n")
}

main()
