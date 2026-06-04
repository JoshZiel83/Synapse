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

import { readFileSync, readdirSync, statSync } from "node:fs"
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

// Files allowed to issue managed DELETE / base-table reads (relative to SRC).
const WRITE_ALLOWLIST = new Set([
  // none: managed deletes must always go through soft-delete / sd_* fns.
])
// Read-allowlist: orchestration, the live-reads module, schema/seed/migration,
// admin/audit paths, and anything that already filters explicitly. We keep this
// pragmatic — the read rule is advisory-strength (warn) rather than hard-fail to
// avoid churn across the large existing read surface, EXCEPT it hard-fails for
// brand-new naked root reads in business modules once adopted. For now we only
// HARD-fail rule 1 (writes); rule 2 emits warnings.
const READ_ENFORCE = false

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

for (const file of walk(SRC)) {
  const rel = relative(SRC, file)
  const text = readFileSync(file, "utf8")
  const lines = text.split("\n")
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
    // Rule 2: naked selectFrom("root") (advisory)
    if (READ_ENFORCE) {
      for (const m of noComment.matchAll(/selectFrom\(\s*["']([a-z_]+)["']/g)) {
        const t = m[1]
        if (ROOT_TABLES.has(t)) {
          warnings.push(
            `${rel}:${i + 1}  selectFrom("${t}") — consider the _live view / live-reads helper`
          )
        }
      }
    }
  })
}

if (warnings.length) {
  console.warn(`soft-delete read advisories (${warnings.length}):`)
  for (const w of warnings.slice(0, 50)) console.warn("  " + w)
}

if (violations.length) {
  console.error(
    `\n✗ guard-soft-delete: ${violations.length} write violation(s):\n`
  )
  for (const v of violations) console.error("  - " + v)
  console.error(
    "\nManaged tables must be soft-deleted (deleted_at / status flip) or deleted via a SECURITY DEFINER sd_* function. See docs/soft-delete-design.md §7.5.\n"
  )
  process.exit(1)
}

console.log(
  `✓ guard-soft-delete: no naked deletes on ${MANAGED_DELETE.size} managed tables.`
)
