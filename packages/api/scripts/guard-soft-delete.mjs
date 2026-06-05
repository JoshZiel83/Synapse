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

const here = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(here, "../src")
const MANIFEST = resolve(
  here,
  "../src/infrastructure/database/soft-delete-table-classification.yml"
)

const manifest = yaml.load(readFileSync(MANIFEST, "utf8"))
const mTables = manifest.tables

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

// Tables that carry a principal (manifest principalColumns) with a revoke/close
// action — markUserDeleted MUST close each of these so a deleted user leaves no
// active authorization row. Rule 3 (below) checks orchestration.ts handles them.
const PRINCIPAL_REVOKE_TABLES = new Set(
  Object.entries(mTables)
    .filter(([, e]) =>
      (e.principalColumns || []).some(
        (pc) => pc.action === "revoke" || pc.action === "close"
      )
    )
    .map(([n]) => n)
)

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
const SELECT_FROM_RE = new RegExp(
  `selectFrom\\(\\s*["'](?:${ROOT_RE})(?:\\s+as\\s+[a-z_]+)?["']`,
  "g"
)
const RAW_FROM_RE = new RegExp(`\\b(?:FROM|JOIN)\\s+(?:${ROOT_RE})\\b`, "g")

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
const readCounts = {} // rel -> count of naked root reads (Rule 2 ratchet)

for (const file of walk(SRC)) {
  const rel = relative(SRC, file)
  const text = readFileSync(file, "utf8")
  const lines = text.split("\n")
  // Rule 2 (ratchet): count naked root reads per file, ignoring comment lines.
  if (!READ_INFRA_ALLOWLIST.has(rel)) {
    let n = 0
    for (const line of lines) {
      const noComment = line.replace(/\/\/.*$/, "")
      n += (noComment.match(SELECT_FROM_RE) || []).length
      n += (noComment.match(RAW_FROM_RE) || []).length
    }
    if (n > 0) readCounts[rel] = n
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

// Rule 2 ratchet: compare per-file naked-read counts against the checked-in
// baseline. A count that GROWS is a new naked read -> hard fail. A count that
// SHRANK (or a file that dropped to zero) means progress -> nudge to refresh.
if (UPDATE_READ_BASELINE) {
  const ordered = Object.fromEntries(
    Object.entries(readCounts).sort(([a], [b]) => a.localeCompare(b))
  )
  writeFileSync(READ_BASELINE_PATH, JSON.stringify(ordered, null, 2) + "\n")
  const total = Object.values(ordered).reduce((s, n) => s + n, 0)
  console.log(
    `✓ wrote read baseline: ${Object.keys(ordered).length} files, ${total} naked root reads.`
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
for (const [rel, n] of Object.entries(readCounts)) {
  const base = readBaseline[rel] ?? 0
  if (n > base) {
    violations.push(
      `${rel}: ${n} naked root read(s), baseline ${base} — new naked selectFrom/FROM <root>; route through a _live view / live-reads helper (or refresh the baseline if intentional)`
    )
  } else if (n < base) {
    shrunk.push(`${rel}: ${base} -> ${n}`)
  }
}
for (const rel of Object.keys(readBaseline)) {
  if (!(rel in readCounts)) shrunk.push(`${rel}: ${readBaseline[rel]} -> 0`)
}
if (shrunk.length) {
  warnings.push(
    `read baseline shrank in ${shrunk.length} file(s) — refresh with --update-read-baseline:`
  )
  for (const s of shrunk.slice(0, 20)) warnings.push("  " + s)
}

if (warnings.length) {
  console.warn(`soft-delete read advisories (${warnings.length}):`)
  for (const w of warnings.slice(0, 50)) console.warn("  " + w)
}

// Rule 3 (review F2): every principal-bearing revoke/close table must be closed
// by the user-deletion orchestration. We assert markUserDeleted's source mentions
// each table in an UPDATE so a newly-registered principal table can't be silently
// dropped from the closure. (Coarse textual check — the regression suite verifies
// the actual behavior.)
const ORCH = resolve(SRC, "modules/soft-delete/orchestration.ts")
const orchText = readFileSync(ORCH, "utf8")
for (const t of PRINCIPAL_REVOKE_TABLES) {
  const re = new RegExp(`UPDATE\\s+${t}\\b`)
  if (!re.test(orchText)) {
    violations.push(
      `orchestration.ts: principal table "${t}" (manifest principalColumns revoke/close) is not closed by markUserDeleted (no UPDATE ${t})`
    )
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

console.log(
  `✓ guard-soft-delete: no naked deletes on ${MANAGED_DELETE.size} managed tables; ` +
    `${PRINCIPAL_REVOKE_TABLES.size} principal tables closed by markUserDeleted; ` +
    `read ratchet held across ${Object.keys(readCounts).length} files ` +
    `(${Object.values(readCounts).reduce((s, n) => s + n, 0)} naked root reads, non-increasing).`
)
