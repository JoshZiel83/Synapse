#!/usr/bin/env node
// One-shot cutover transform: rewrite schema.sql FK ON DELETE actions to match
// the manifest's target policy (zero CASCADE — design §0.2/§7.2).
//
// Strategy: line-based replacement of the literal "ON DELETE CASCADE" with
// "ON DELETE RESTRICT" on every non-comment line. Each literal occurrence in
// FK context is exactly one FK's action; comment lines (-- ...) are skipped.
// After rewriting, re-parse and assert 0 CASCADE FKs remain (fail otherwise).
//
// Idempotent: re-running after the rewrite is a no-op (no CASCADE left).

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseSchema } from "./schema-introspect.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = resolve(here, "../src/infrastructure/database/schema.sql")

const original = readFileSync(SCHEMA_PATH, "utf8")
const lines = original.split("\n")
let rewritten = 0
const out = lines.map((line) => {
  const commentIdx = line.indexOf("--")
  const cascadeIdx = line.indexOf("ON DELETE CASCADE")
  if (cascadeIdx === -1) return line
  // Skip if the CASCADE is inside a comment (-- before it, or line is a comment).
  if (commentIdx !== -1 && commentIdx < cascadeIdx) return line
  rewritten++
  return line.replace(/ON DELETE CASCADE/g, "ON DELETE RESTRICT")
})

const newText = out.join("\n")
writeFileSync(SCHEMA_PATH, newText)

// Verify: re-parse, assert zero CASCADE.
const { foreignKeys } = parseSchema(newText)
const remaining = foreignKeys.filter((fk) => fk.onDelete === "CASCADE")
if (remaining.length > 0) {
  console.error(
    `✗ rewrite incomplete: ${remaining.length} CASCADE FK(s) remain:\n` +
      remaining
        .map(
          (fk) =>
            `  ${fk.childTable}(${fk.childColumns.join(",")}) line ${fk.lineno}`
        )
        .join("\n")
  )
  process.exit(1)
}
const dist = {}
for (const fk of foreignKeys) dist[fk.onDelete] = (dist[fk.onDelete] || 0) + 1
console.log(
  `✓ rewrote ${rewritten} CASCADE→RESTRICT line(s). FK ON DELETE now: ${JSON.stringify(dist)}`
)
