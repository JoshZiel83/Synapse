#!/usr/bin/env node
// Schema introspection for schema.sql — a small, dependency-free parser that
// extracts tables, columns, enum types, and foreign keys (inline column FKs,
// table-level FOREIGN KEY clauses, and ALTER TABLE ... ADD CONSTRAINT FKs).
//
// This is the authoritative schema reader for the soft-delete tooling
// (derive-fk-policy.mjs). It is intentionally tailored to the dialect/style of
// THIS schema.sql (Postgres DDL, hand-maintained, single file) rather than a
// general SQL parser.
//
// Exports:
//   parseSchema(sqlText) -> {
//     tables: Map<name, { name, columns: [{name, type, raw}], lineno }>,
//     enums: Map<name, string[]>,
//     foreignKeys: [{
//       constraintName | null, childTable, childColumns: string[],
//       referencedTable, referencedColumns: string[], onDelete, deferrable,
//       source: 'inline'|'table'|'alter', lineno,
//       key  // stable identity key (constraint name, else digest)
//     }]
//   }

import { createHash } from "node:crypto"

const ON_DELETE_ACTIONS = [
  "CASCADE",
  "SET NULL",
  "SET DEFAULT",
  "RESTRICT",
  "NO ACTION",
]

function stableFkKey(fk) {
  if (fk.constraintName) return `constraint:${fk.constraintName}`
  const h = createHash("sha1")
  h.update(
    [
      fk.childTable,
      fk.childColumns.join(","),
      fk.referencedTable,
      fk.referencedColumns.join(","),
    ].join("|")
  )
  return `digest:${h.digest("hex").slice(0, 16)}`
}

function parseOnDelete(segment) {
  // segment is the text after REFERENCES tbl(cols), possibly spanning the
  // ON DELETE clause and DEFERRABLE markers.
  const upper = segment.toUpperCase()
  let onDelete = "NO ACTION" // SQL default when ON DELETE is omitted
  const idx = upper.indexOf("ON DELETE")
  if (idx !== -1) {
    const after = upper.slice(idx + "ON DELETE".length).trimStart()
    // Match the longest action keyword.
    const match = ON_DELETE_ACTIONS.find((a) => after.startsWith(a))
    if (match) onDelete = match
  }
  const deferrable = upper.includes("DEFERRABLE")
  return { onDelete, deferrable }
}

function splitColumns(colList) {
  return colList
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
}

// Find the line number (1-based) of a character offset in the original text.
function lineAt(text, offset) {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") line++
  }
  return line
}

export function parseSchema(sqlText) {
  const tables = new Map()
  const enums = new Map()
  const foreignKeys = []

  // --- Enum types ---------------------------------------------------------
  // CREATE TYPE <name> AS ENUM ('a','b',...);
  const enumRe =
    /CREATE\s+TYPE\s+([a-z_][a-z0-9_]*)\s+AS\s+ENUM\s*\(([^)]*)\)/gis
  for (const m of sqlText.matchAll(enumRe)) {
    const name = m[1]
    const values = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1])
    enums.set(name, values)
  }

  // --- CREATE TABLE blocks ------------------------------------------------
  // Capture: CREATE TABLE [IF NOT EXISTS] <name> ( <body> );
  // Body may contain nested parens (CHECK (...), numeric(p,s)); balance parens.
  const createRe =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/gis
  let cm
  while ((cm = createRe.exec(sqlText)) !== null) {
    const tableName = cm[1]
    const bodyStart = cm.index + cm[0].length
    // Balance parentheses from bodyStart-1 (the opening paren).
    let depth = 1
    let i = bodyStart
    for (; i < sqlText.length && depth > 0; i++) {
      const ch = sqlText[i]
      if (ch === "(") depth++
      else if (ch === ")") depth--
    }
    const body = sqlText.slice(bodyStart, i - 1)
    const lineno = lineAt(sqlText, cm.index)
    const columns = []

    // Split body into top-level comma-separated items (respect nested parens).
    const items = []
    {
      let d = 0
      let cur = ""
      for (const ch of body) {
        if (ch === "(") d++
        if (ch === ")") d--
        if (ch === "," && d === 0) {
          items.push(cur)
          cur = ""
        } else {
          cur += ch
        }
      }
      if (cur.trim()) items.push(cur)
    }

    for (const rawItem of items) {
      const item = rawItem.replace(/--.*$/gm, "").trim()
      if (!item) continue
      const upper = item.toUpperCase()

      // Table-level constraints we skip as columns:
      const isTableConstraint =
        /^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE)\b/i.test(
          item
        )

      // table-level FOREIGN KEY (cols) REFERENCES tbl(cols) [ON DELETE ...]
      const tableFk = item.match(
        /(?:CONSTRAINT\s+([a-z_][a-z0-9_]*)\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)([\s\S]*)/i
      )
      if (tableFk) {
        const { onDelete, deferrable } = parseOnDelete(tableFk[5] || "")
        const fk = {
          constraintName: tableFk[1] || null,
          childTable: tableName,
          childColumns: splitColumns(tableFk[2]),
          referencedTable: tableFk[3],
          referencedColumns: splitColumns(tableFk[4]),
          onDelete,
          deferrable,
          source: "table",
          lineno,
        }
        fk.key = stableFkKey(fk)
        foreignKeys.push(fk)
        continue
      }

      if (isTableConstraint) continue

      // Otherwise: a column definition. First token is the column name.
      const colMatch = item.match(/^("?)([a-z_][a-z0-9_]*)\1\s+(.+)$/is)
      if (!colMatch) continue
      const colName = colMatch[2]
      const colDef = colMatch[3]
      columns.push({ name: colName, type: colDef.split(/\s+/)[0], raw: item })

      // inline column FK: ... REFERENCES tbl(col) [ON DELETE ...]
      const inlineFk = colDef.match(
        /REFERENCES\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)([\s\S]*)/i
      )
      if (inlineFk) {
        const { onDelete, deferrable } = parseOnDelete(inlineFk[3] || "")
        const fk = {
          constraintName: null,
          childTable: tableName,
          childColumns: [colName],
          referencedTable: inlineFk[1],
          referencedColumns: splitColumns(inlineFk[2]),
          onDelete,
          deferrable,
          source: "inline",
          lineno: lineAt(sqlText, bodyStart),
        }
        fk.key = stableFkKey(fk)
        foreignKeys.push(fk)
      }
    }

    tables.set(tableName, { name: tableName, columns, lineno })
  }

  // --- ALTER TABLE ... ADD COLUMN <col> ... REFERENCES tbl(col) ---------
  // A single ALTER TABLE may carry several comma-separated ADD COLUMN clauses,
  // each of which can declare an inline column FK. Capture the statement, then
  // scan each ADD COLUMN clause for a REFERENCES.
  const alterAddColRe =
    /ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+((?:ADD\s+COLUMN[\s\S]*?));/gis
  for (const m of sqlText.matchAll(alterAddColRe)) {
    const childTable = m[1]
    const stmtBody = m[2]
    const stmtLine = lineAt(sqlText, m.index)
    // Split on top-level commas into ADD COLUMN clauses.
    const clauses = []
    {
      let d = 0
      let cur = ""
      for (const ch of stmtBody) {
        if (ch === "(") d++
        if (ch === ")") d--
        if (ch === "," && d === 0) {
          clauses.push(cur)
          cur = ""
        } else {
          cur += ch
        }
      }
      if (cur.trim()) clauses.push(cur)
    }
    for (const clause of clauses) {
      const colm = clause.match(
        /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+([\s\S]*?)(?:REFERENCES\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)([\s\S]*))?$/i
      )
      if (!colm) continue
      // Fold the added column into the table's column set so downstream consumers
      // (e.g. the soft-delete gate checking for a deleted_at column) see it.
      const addedTable = tables.get(childTable)
      if (addedTable && !addedTable.columns.some((c) => c.name === colm[1])) {
        const typeTok = (colm[2] || "").trim().split(/\s+/)[0] || ""
        addedTable.columns.push({
          name: colm[1],
          type: typeTok,
          raw: `${colm[1]} ${(colm[2] || "").trim()}`,
        })
      }
      if (!colm[3]) continue // no REFERENCES on this ADD COLUMN
      const { onDelete, deferrable } = parseOnDelete(colm[5] || "")
      const fk = {
        constraintName: null,
        childTable,
        childColumns: [colm[1]],
        referencedTable: colm[3],
        referencedColumns: splitColumns(colm[4]),
        onDelete,
        deferrable,
        source: "alter-add-column",
        lineno: stmtLine,
      }
      fk.key = stableFkKey(fk)
      foreignKeys.push(fk)
    }
  }

  // --- ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY --------------------
  // These span multiple lines and end at ';'. Statement-split on ';' but only
  // for ALTER TABLE statements.
  const alterRe =
    /ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+ADD\s+CONSTRAINT\s+([a-z_][a-z0-9_]*)\s+FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)([\s\S]*?);/gis
  for (const m of sqlText.matchAll(alterRe)) {
    const { onDelete, deferrable } = parseOnDelete(m[6] || "")
    const fk = {
      constraintName: m[2],
      childTable: m[1],
      childColumns: splitColumns(m[3]),
      referencedTable: m[4],
      referencedColumns: splitColumns(m[5]),
      onDelete,
      deferrable,
      source: "alter",
      lineno: lineAt(sqlText, m.index),
    }
    fk.key = stableFkKey(fk)
    foreignKeys.push(fk)
  }

  return { tables, enums, foreignKeys }
}

export { stableFkKey, ON_DELETE_ACTIONS }
