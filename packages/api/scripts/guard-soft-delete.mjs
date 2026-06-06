#!/usr/bin/env node
// guard-soft-delete: static enforcement of the soft-delete read/write rules.
//
// Rule 1 (writes): no naked `deleteFrom("<managed>")` (Kysely) or raw
//   `DELETE FROM <managed>` on a MANAGED table — i.e. any table the manifest
//   marks persistent (class root/junction/child/append-only/reference and NOT
//   ephemeral/derived/baOwned). Managed-table deletion must go through a
//   markDeleted/status-flip (soft) or a SECURITY DEFINER fn (sd_*), never a
//   direct DELETE. Ephemeral/derived/baOwned tables are allowed direct DELETE.
//
// Rule 2 (reads): no naked `selectFrom("<root>")` on a soft-delete ROOT outside
//   the allowlist — business reads should use the `_live` views / live-reads
//   helpers. Files that legitimately need the base table (orchestration,
//   migration, admin, the live-reads module itself, *.test.ts) are allowlisted.
//
// Usage: node scripts/guard-soft-delete.mjs    (exit 1 on violation)

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, resolve, relative, join } from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "js-yaml"
import { parseSchema } from "./schema-introspect.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(here, "../src")
const SCHEMA = resolve(here, "../src/infrastructure/database/schema.sql")
const MANIFEST = resolve(
  here,
  "../src/infrastructure/database/soft-delete-table-classification.yml"
)

const schemaSql = readFileSync(SCHEMA, "utf8")
const schema = parseSchema(schemaSql)
const manifest = yaml.load(readFileSync(MANIFEST, "utf8"))
const mTables = manifest.tables
const tableIsEphemeral = (entry) =>
  entry.class === "ephemeral" || entry.derived === true
const tableHasDeclaredLiveSemantics = (entry) =>
  (Array.isArray(entry.liveValues) && entry.liveValues.length) ||
  Boolean(entry.livePredicate)
const VALID_LIVE_INTEGRITY = new Set(["enforce", "historical", "none"])

// Managed (delete-protected) tables: persistent classes, not ephemeral/derived/baOwned.
const MANAGED_DELETE = new Set(
  Object.entries(mTables)
    .filter(
      ([, e]) =>
        !(e.class === "ephemeral" || e.derived === true || e.baOwned === true)
    )
    .map(([n]) => n)
)

// Soft-delete roots: reads should go through _live views.
const ROOT_TABLES = new Set(
  Object.entries(mTables)
    .filter(([, e]) => e.softDelete === "deleted_at")
    .map(([n]) => n)
)

// Keep in lockstep with cutover-emit-ddl.mjs: these softDelete:none child tables
// expose canonical `_live` views even without their own liveValues because their
// liveness is inherited entirely from parent `_live` views.
const ADDITIONAL_PARENT_FOLDING_LIVE_VIEW_TABLES = new Set(["device_exposures"])
const tableHasManifestLiveView = (name, entry) =>
  !tableIsEphemeral(entry) &&
  (tableHasDeclaredLiveSemantics(entry) ||
    ADDITIONAL_PARENT_FOLDING_LIVE_VIEW_TABLES.has(name))
const tableHasLiveView = (name, entry) =>
  entry.softDelete === "deleted_at" ||
  entry.softDelete === "status" ||
  tableHasManifestLiveView(name, entry)
const hasColumn = (name, column) =>
  schema.tables.get(name)?.columns.some((c) => c.name === column)
const liveColumnForTable = (name, entry, errors) => {
  if (!Array.isArray(entry.liveValues) || !entry.liveValues.length) return null
  if (entry.liveColumn) {
    if (!hasColumn(name, entry.liveColumn)) {
      errors.push(`${name}: liveColumn '${entry.liveColumn}' is absent`)
    }
    return entry.liveColumn
  }
  if (hasColumn(name, "status")) return "status"
  if (hasColumn(name, "state")) return "state"
  errors.push(
    `${name}: liveValues declared but no liveColumn/status/state column exists`
  )
  return null
}

// Principal tables = any table whose manifest declares principalColumns (a
// column carrying a deleted user's principal: user/member/subject). Every such
// table is classified into exactly one bucket (review F17) so a newly-registered
// principal table can NEVER be silently dropped from the user-deletion contract:
//
//   CLOSEABLE  — has a status lifecycle to flip (softDelete:status) OR a
//                principalColumn action of revoke|close. markUserDeleted MUST
//                close it with a status flip (rule 3 below verifies).
//   ANCHORED   — a plain child (softDelete:none) whose principalColumns are all
//                `update`: it has no status to flip and its liveness derives from
//                a soft-deletable parent (conversation/member), so it is NOT
//                independently closed. Must be on PRINCIPAL_ANCHORED_ALLOWLIST.
//
// A principal table that is neither (e.g. a new softDelete:none table with a
// revoke action, or one missing from the allowlist) FAILS the guard.
const PRINCIPAL_TABLES = Object.entries(mTables).filter(
  ([, e]) => Array.isArray(e.principalColumns) && e.principalColumns.length
)
const isCloseable = (e) =>
  e.softDelete === "status" ||
  (e.principalColumns || []).some(
    (pc) => pc.action === "revoke" || pc.action === "close"
  )
const PRINCIPAL_CLOSEABLE_TABLES = new Set(
  PRINCIPAL_TABLES.filter(([, e]) => isCloseable(e)).map(([n]) => n)
)
// Plain-child principal tables anchored by a soft-deletable parent — no
// independent closure (documented exemption). Keep this list explicit so adding
// a table here is a reviewed decision.
const PRINCIPAL_ANCHORED_ALLOWLIST = new Set([
  "direct_conversation_bindings", // anchored by the conversation (soft-deleted)
  "workspace_friend_entries", // anchored by the owner member (removed)
  "workspace_member_preferences", // 1:1 child of the member (removed)
  "workspace_relationship_profiles", // anchored by the member/subject
])

// Files allowed to issue managed DELETE / base-table reads (relative to SRC).
const WRITE_ALLOWLIST = new Set([
  // none: managed deletes must always go through soft-delete / sd_* fns.
])
// Read-rule infra exemption: files that legitimately read base tables (the
// soft-delete module itself, schema/seed/bootstrap, the platform-admin/audit
// path, content-addressed GC). These are NOT counted toward the read baseline.
const READ_INFRA_ALLOWLIST = new Set([
  "modules/soft-delete/live-reads.ts",
  "modules/soft-delete/orchestration.ts",
  "infrastructure/database/seed.ts",
  "infrastructure/database/seeds/actors/seed-official-actors.ts",
  "modules/platform/admin-service.ts",
  "modules/sandbox/gc.ts",
])
// Read rule (review F8): the existing business read-surface is large (~100 naked
// root reads interleaved with legitimate base-table uses in the same files), so a
// blanket flip-to-fail or a file-granularity allowlist would either break CI or
// silently whitelist real leaks. Instead we RATCHET: a checked-in baseline records
// the current per-file count of naked `selectFrom("<root>")` / raw `FROM/JOIN
// <root>` reads; the guard HARD-FAILS if any file's count GROWS (a brand-new naked
// read), and nudges to refresh the baseline when a count shrinks. New reads must
// go through the `_live` views / live-reads helpers. Regenerate the baseline with
// `node scripts/guard-soft-delete.mjs --update-read-baseline` (a reviewable diff).
const READ_BASELINE_PATH = resolve(
  here,
  "../src/infrastructure/database/soft-delete-read-baseline.json"
)
const UPDATE_READ_BASELINE = process.argv.includes("--update-read-baseline")
const ROOT_RE = [...ROOT_TABLES].join("|")
// Capture the table name (group 1) so the ratchet can record per-table counts.
const SELECT_FROM_RE = new RegExp(
  `selectFrom\\(\\s*["'](${ROOT_RE})(?:\\s+as\\s+[a-z_]+)?["']`,
  "g"
)
const RAW_FROM_RE = new RegExp(`\\b(?:FROM|JOIN)\\s+(${ROOT_RE})\\b`, "g")

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "generated") continue
      yield* walk(p)
    } else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      yield p
    }
  }
}

const violations = []
const warnings = []
const readCounts = {} // rel -> { <root>: count } of naked root reads (Rule 2 ratchet)

for (const file of walk(SRC)) {
  const rel = relative(SRC, file)
  const text = readFileSync(file, "utf8")
  const lines = text.split("\n")
  // Rule 2 (ratchet): count naked root reads per file BY TABLE, ignoring comment
  // lines. Tracking per-table (not just a total) catches a refactor that swaps
  // one root read for another without changing the count.
  if (!READ_INFRA_ALLOWLIST.has(rel)) {
    const byTable = {}
    for (const line of lines) {
      const noComment = line.replace(/\/\/.*$/, "")
      for (const m of noComment.matchAll(SELECT_FROM_RE))
        byTable[m[1]] = (byTable[m[1]] || 0) + 1
      for (const m of noComment.matchAll(RAW_FROM_RE))
        byTable[m[1]] = (byTable[m[1]] || 0) + 1
    }
    if (Object.keys(byTable).length) {
      readCounts[rel] = Object.fromEntries(
        Object.entries(byTable).sort(([a], [b]) => a.localeCompare(b))
      )
    }
  }
  lines.forEach((line, i) => {
    const noComment = line.replace(/\/\/.*$/, "")
    // Rule 1a: Kysely deleteFrom("managed")
    for (const m of noComment.matchAll(/deleteFrom\(\s*["']([a-z_]+)["']/g)) {
      const t = m[1]
      if (MANAGED_DELETE.has(t) && !WRITE_ALLOWLIST.has(rel)) {
        violations.push(
          `${rel}:${i + 1}  naked deleteFrom("${t}") on a managed table (use soft-delete / sd_* fn)`
        )
      }
    }
    // Rule 1b: raw DELETE FROM managed
    for (const m of noComment.matchAll(/DELETE\s+FROM\s+([a-z_]+)/gi)) {
      const t = m[1].toLowerCase()
      if (MANAGED_DELETE.has(t) && !WRITE_ALLOWLIST.has(rel)) {
        // skip if it's inside a SECURITY DEFINER fn body string (sd_* generator)
        if (rel.startsWith("../")) continue
        violations.push(
          `${rel}:${i + 1}  raw DELETE FROM ${t} on a managed table (use soft-delete / sd_* fn)`
        )
      }
    }
  })
}

// Rule 2 ratchet: compare per-file/per-table naked-read counts against the
// checked-in baseline. Any table whose count GROWS — or a brand-new table read in
// a file — is a new naked read -> hard fail. A count that SHRANK (or a table that
// dropped to zero) means progress -> nudge to refresh. Per-table granularity also
// catches a refactor that swaps one root for another at the same total.
const fileTotal = (m) => Object.values(m).reduce((s, n) => s + n, 0)
if (UPDATE_READ_BASELINE) {
  const ordered = Object.fromEntries(
    Object.entries(readCounts).sort(([a], [b]) => a.localeCompare(b))
  )
  writeFileSync(READ_BASELINE_PATH, JSON.stringify(ordered, null, 2) + "\n")
  const total = Object.values(ordered).reduce((s, m) => s + fileTotal(m), 0)
  console.log(
    `✓ wrote read baseline: ${Object.keys(ordered).length} files, ${total} naked root reads (by table).`
  )
  process.exit(0)
}
let readBaseline = {}
try {
  readBaseline = JSON.parse(readFileSync(READ_BASELINE_PATH, "utf8"))
} catch {
  warnings.push(
    "read baseline missing — run `node scripts/guard-soft-delete.mjs --update-read-baseline`"
  )
}
const shrunk = []
for (const [rel, tables] of Object.entries(readCounts)) {
  const base = readBaseline[rel] || {}
  for (const [t, n] of Object.entries(tables)) {
    const b = base[t] ?? 0
    if (n > b) {
      violations.push(
        `${rel}: naked read of "${t}" x${n} (baseline ${b}) — route through ${t}_live / a live-reads helper, or refresh the baseline if intentional`
      )
    } else if (n < b) {
      shrunk.push(`${rel}:${t} ${b} -> ${n}`)
    }
  }
  for (const t of Object.keys(base)) {
    if (!(t in tables)) shrunk.push(`${rel}:${t} ${base[t]} -> 0`)
  }
}
for (const rel of Object.keys(readBaseline)) {
  if (!(rel in readCounts))
    shrunk.push(`${rel}: ${fileTotal(readBaseline[rel])} -> 0`)
}
if (shrunk.length) {
  warnings.push(
    `read baseline shrank in ${shrunk.length} place(s) — refresh with --update-read-baseline:`
  )
  for (const s of shrunk.slice(0, 20)) warnings.push("  " + s)
}

if (warnings.length) {
  console.warn(`soft-delete read advisories (${warnings.length}):`)
  for (const w of warnings.slice(0, 50)) console.warn("  " + w)
}

// Rule 3 (review F2/F17): every principal table is classified and accounted for.
//   - CLOSEABLE  -> markUserDeleted MUST status-flip close it (verified below).
//   - ANCHORED   -> must be on the explicit allowlist (documented exemption).
//   - NEITHER    -> hard fail (a new principal table can't slip through).
const ORCH = resolve(SRC, "modules/soft-delete/orchestration.ts")
const orchText = readFileSync(ORCH, "utf8")
for (const [t] of PRINCIPAL_TABLES) {
  if (PRINCIPAL_CLOSEABLE_TABLES.has(t)) {
    // Require an actual status-FLIP close, not just any mention: the table must
    // appear in an `UPDATE <t> ... SET ... status = ...` statement. Stricter than
    // a bare `UPDATE <t>` match — a read or unrelated update won't satisfy it.
    const re = new RegExp(
      `UPDATE\\s+${t}\\b[\\s\\S]{0,200}?\\bstatus\\s*=`,
      "i"
    )
    if (!re.test(orchText)) {
      violations.push(
        `orchestration.ts: closeable principal table "${t}" is not closed by markUserDeleted (no \`UPDATE ${t} ... SET status = ...\` status-flip found)`
      )
    }
  } else if (!PRINCIPAL_ANCHORED_ALLOWLIST.has(t)) {
    violations.push(
      `principal table "${t}" is neither CLOSEABLE (status-flip in markUserDeleted) nor on PRINCIPAL_ANCHORED_ALLOWLIST — classify it in guard-soft-delete.mjs (review F17)`
    )
  }
}
// Allowlist hygiene: every anchored entry must actually be a (non-closeable)
// principal table, so the list can't rot.
const principalNames = new Set(PRINCIPAL_TABLES.map(([n]) => n))
for (const t of PRINCIPAL_ANCHORED_ALLOWLIST) {
  if (!principalNames.has(t))
    violations.push(
      `PRINCIPAL_ANCHORED_ALLOWLIST entry "${t}" is not a principal table (stale) — remove it`
    )
  else if (PRINCIPAL_CLOSEABLE_TABLES.has(t))
    violations.push(
      `PRINCIPAL_ANCHORED_ALLOWLIST entry "${t}" is closeable — it must be closed by markUserDeleted, not anchored`
    )
}

// Rule 4 (canonical live surfaces): every persistent table with manifest live
// semantics must have a generated `_live` view, and every `_live` table with a
// business/runtime status column must declare its own live semantics unless it
// is explicitly parent-folding only. This keeps active/left/removed-style
// semantics manifest-driven instead of relying on ad hoc business filters.
for (const [t, entry] of Object.entries(mTables)) {
  const tbl = schema.tables.get(t)
  if (!tbl) continue
  if (!tableHasLiveView(t, entry)) continue

  const hasGeneratedView = new RegExp(`CREATE VIEW ${t}_live\\b`).test(
    schemaSql
  )
  if (!hasGeneratedView) {
    violations.push(`${t}: expected generated canonical ${t}_live view`)
  }

  liveColumnForTable(t, entry, violations)
  const hasBusinessStateColumn =
    tbl.columns.some((c) => c.name === "status") ||
    tbl.columns.some((c) => c.name === "state")
  if (
    tableHasManifestLiveView(t, entry) &&
    hasBusinessStateColumn &&
    !tableHasDeclaredLiveSemantics(entry) &&
    !ADDITIONAL_PARENT_FOLDING_LIVE_VIEW_TABLES.has(t)
  ) {
    violations.push(
      `${t}: generated _live table has status/state column but no liveValues/livePredicate in soft-delete manifest`
    )
  }
}
for (const t of ADDITIONAL_PARENT_FOLDING_LIVE_VIEW_TABLES) {
  if (!schema.tables.has(t) || !mTables[t]) {
    violations.push(
      `ADDITIONAL_PARENT_FOLDING_LIVE_VIEW_TABLES entry "${t}" is missing from schema or manifest`
    )
    continue
  }
  const tbl = schema.tables.get(t)
  const entry = mTables[t]
  const hasBusinessStateColumn =
    tbl.columns.some((c) => c.name === "status") ||
    tbl.columns.some((c) => c.name === "state")
  if (hasBusinessStateColumn && !tableHasDeclaredLiveSemantics(entry)) {
    violations.push(
      `${t}: parent-folding _live table has status/state column but no liveValues/livePredicate in soft-delete manifest`
    )
  }
}

// Rule 5 (FK live-integrity classification): every persistent FK pointing at a
// canonical live parent must say whether it is a lifecycle edge (`enforce`), a
// historical/provenance reference (`historical`), or intentionally ignored by
// live integrity (`none`). This prevents newly generated `_live` parents from
// accidentally turning author/creator/history columns into lifecycle parents.
for (const fk of schema.foreignKeys) {
  const parentEntry = mTables[fk.referencedTable]
  const childEntry = mTables[fk.childTable]
  if (!parentEntry || !childEntry) continue
  if (tableIsEphemeral(childEntry)) continue
  if (!tableHasLiveView(fk.referencedTable, parentEntry)) continue

  const reg = manifest.foreignKeys?.[fk.key]
  const liveIntegrity = reg?.liveIntegrity
  if (!liveIntegrity) {
    violations.push(
      `FK ${fk.key} (${fk.childTable}.${fk.childColumns.join(",")} -> ${fk.referencedTable}) references a live parent but has no liveIntegrity classification`
    )
    continue
  }
  if (!VALID_LIVE_INTEGRITY.has(liveIntegrity)) {
    violations.push(`FK ${fk.key}: invalid liveIntegrity '${liveIntegrity}'`)
  }
  if (
    liveIntegrity === "enforce" &&
    (fk.childColumns.length !== 1 || fk.referencedColumns.length !== 1)
  ) {
    violations.push(
      `FK ${fk.key}: liveIntegrity=enforce currently supports single-column FKs only`
    )
  }
  if (fk.childColumns.length === 1 && fk.referencedColumns.length === 1) {
    const triggerName = `sd_fk_live_${fk.childTable}_${fk.childColumns[0]}`
    const dropSql = `DROP TRIGGER IF EXISTS ${triggerName} ON ${fk.childTable};`
    const createSql = `CREATE TRIGGER ${triggerName} `
    if (!schemaSql.includes(dropSql)) {
      violations.push(
        `FK ${fk.key}: generated schema must drop stale ${triggerName} before recreating enforce-only FK liveness triggers`
      )
    }
    const createsTrigger = schemaSql.includes(createSql)
    if (liveIntegrity === "enforce" && !createsTrigger) {
      violations.push(
        `FK ${fk.key}: liveIntegrity=enforce but generated schema does not create ${triggerName}`
      )
    }
    if (liveIntegrity !== "enforce" && createsTrigger) {
      violations.push(
        `FK ${fk.key}: liveIntegrity=${liveIntegrity} but generated schema still creates ${triggerName}`
      )
    }
  }
}

if (violations.length) {
  console.error(`\n✗ guard-soft-delete: ${violations.length} violation(s):\n`)
  for (const v of violations) console.error("  - " + v)
  console.error(
    "\nManaged tables must be soft-deleted (deleted_at / status flip) or deleted via a SECURITY DEFINER sd_* function. See docs/soft-delete-design.md §7.5.\n"
  )
  process.exit(1)
}

const readTotal = Object.values(readCounts).reduce(
  (s, m) => s + fileTotal(m),
  0
)
console.log(
  `✓ guard-soft-delete: no naked deletes on ${MANAGED_DELETE.size} managed tables; ` +
    `${PRINCIPAL_TABLES.length} principal tables accounted for ` +
    `(${PRINCIPAL_CLOSEABLE_TABLES.size} closeable status-flip-closed by markUserDeleted, ` +
    `${PRINCIPAL_ANCHORED_ALLOWLIST.size} anchored); ` +
    `read ratchet held across ${Object.keys(readCounts).length} files ` +
    `(${readTotal} naked root reads by table, non-increasing).`
)
