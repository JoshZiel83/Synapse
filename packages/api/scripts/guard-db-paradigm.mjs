#!/usr/bin/env node
// Guard against re-introducing the legacy database paradigm after the
// Kysely-convergence refactor.
//
// What counts as "legacy" (must be zero outside the whitelisted definition
// files):
//   1. Importing a removed bare query helper or bare-pg executor type from
//      `infrastructure/database/kysely(.js)` — executeSql, executeSqlOn,
//      executeCompiledQuery, executeCompiledSql, the bare-helper `executeTakeFirst`
//      (the FUNCTION import, not the Kysely builder method), `QueryExecutor`,
//      the `AnyExecutor` union, or its narrowing helpers `isKyselyExecutor` /
//      `asExecutor`. All deleted by the convergence — use `Executor`.
//   2. Importing `transaction`/`getClient`/`query` (the hand-rolled pg helpers)
//      or the bare `pool` from `infrastructure/database/index(.js)`. `pool` is
//      @internal to the database layer; business code uses `db`/`Executor`.
//   3. Declaring a bespoke bare-executor object/type of shape
//      `{ query: (text, params) => ... }` — inline object-literal adapters
//      (e.g. `?? { query: (text, params) => runOnDb(...) }`) and interface /
//      type-literal members named `query` with a `(text, ...) => Promise` shape.
//
//   NOT flagged (legitimate): function-type runner aliases like
//   `type QueryRunner = <T>(text, params?) => Promise<{ rows }>` in
//   automation/skills/mcp-plugins/organization. Post-convergence these are
//   curried raw-SQL runners bound to a Kysely `Executor` (built by
//   `runnerFn(executor: Executor)` → `executor.executeQuery(CompiledQuery.raw(...))`);
//   they carry NO pg client and cannot reintroduce the bare-pg paradigm, so
//   banning them would be noise. The bare-pg `{ query }` SHAPE is still caught
//   by rule 3.
//
// This is import-AWARE and AST-based — it never flags `.executeTakeFirst()` /
// `.execute()` builder chains, which are legitimate native Kysely usage.
//
// Usage: node scripts/guard-db-paradigm.mjs
// Exit 0 = clean, 1 = violations found.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const here = dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = resolve(here, "../src")

// Canonical (extensionless) absolute paths of the two definition modules, used
// to resolve relative import specifiers regardless of how deep the importer is.
const KYSELY_DEF = resolve(SRC_ROOT, "infrastructure/database/kysely")
const INDEX_DEF = resolve(SRC_ROOT, "infrastructure/database/index")

// Files allowed to define/own the legacy symbols during the transition. Paths
// are relative to SRC_ROOT, posix-style.
const WHITELIST = new Set([
  "infrastructure/database/kysely.ts",
  "infrastructure/database/index.ts",
])

// Named imports that are legacy when imported from database/kysely. The bare
// query helpers were deleted in the convergence; `QueryExecutor`/`AnyExecutor`
// (the bare-pg union) and `isKyselyExecutor`/`asExecutor` (its narrowing
// helpers) were removed too — banning the names keeps them from being
// reintroduced. Use `Executor` (Kysely<Database>: db or trx) instead.
const KYSELY_LEGACY_IMPORTS = new Set([
  "executeSql",
  "executeSqlOn",
  "executeCompiledQuery",
  "executeCompiledSql",
  "executeTakeFirst", // the bare helper function (NOT the builder method)
  "QueryExecutor",
  "AnyExecutor",
  "isKyselyExecutor",
  "asExecutor",
])
// Named imports that are legacy when imported from database/index. `pool` is
// sealed: it is an @internal connection handle owned by the database layer
// (kysely.ts builds `db` on it, the schema-health probes use it) — business
// modules must use `db`/`Executor`, never the bare pool. kysely.ts/index.ts are
// whitelisted so they can still reference it.
const INDEX_LEGACY_IMPORTS = new Set([
  "transaction",
  "query",
  "getClient",
  "pool",
])

function listTsFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue
      out.push(...listTsFiles(full))
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full)
    }
  }
  return out
}

function checkFile(file) {
  const relPath = relative(SRC_ROOT, file).split("\\").join("/")
  if (WHITELIST.has(relPath)) return []
  if (relPath.endsWith(".test.ts")) return [] // tests may keep helpers until removed

  const text = readFileSync(file, "utf8")
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const violations = []

  const reportAt = (node, msg) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    violations.push({ file: relPath, line: line + 1, msg })
  }

  const visit = (node) => {
    // (1)(2) legacy imports — resolve the specifier relative to this file so
    // sibling imports (`./kysely.js` from inside infrastructure/database) and
    // deep relative imports (`../../infrastructure/database/kysely.js`) both
    // resolve to the same canonical target.
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
      const spec = node.moduleSpecifier
      if (ts.isStringLiteral(spec) && spec.text.startsWith(".")) {
        const resolved = resolve(dirname(file), spec.text.replace(/\.js$/, ""))
        const isKysely = resolved === KYSELY_DEF
        const isIndex = resolved === INDEX_DEF
        const nb = node.importClause.namedBindings
        if ((isKysely || isIndex) && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            const name = el.propertyName?.text ?? el.name.text
            if (isKysely && KYSELY_LEGACY_IMPORTS.has(name)) {
              reportAt(el, `legacy import \`${name}\` from database/kysely`)
            }
            if (isIndex && INDEX_LEGACY_IMPORTS.has(name)) {
              reportAt(el, `legacy import \`${name}\` from database/index`)
            }
          }
        }
      }
    }

    // (3) bespoke bare-executor: a type/interface member OR an object-literal
    // property named `query` whose value is `(text..., params?...) => Promise`.
    // - PropertySignature/MethodSignature: type-literal/interface shape.
    // - PropertyAssignment with an arrow/function value: inline object adapter
    //   like `?? { query: (text, params) => runOnDb(...) }`.
    if (
      (ts.isPropertySignature(node) || ts.isMethodSignature(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === "query"
    ) {
      // type alias / interface shape { query: (text, params?) => ... }
      const typeNode = ts.isPropertySignature(node) ? node.type : node
      if (typeNode && isBareQuerySig(typeNode)) {
        reportAt(
          node,
          "bespoke bare-executor type `{ query(text, params?) }` — use Executor"
        )
      }
    }

    if (
      ts.isPropertyAssignment(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === "query" &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer)) &&
      isBareQueryFn(node.initializer)
    ) {
      reportAt(
        node,
        "inline bare-executor adapter `{ query: (text, params) => ... }` — pass `db`/`Executor` instead"
      )
    }

    ts.forEachChild(node, visit)
  }

  function firstParamIsQueryText(params) {
    if (!params?.length) return false
    const p0 = params[0]
    const pname = p0.name && ts.isIdentifier(p0.name) ? p0.name.text : ""
    return /^(text|sql|queryText)$/i.test(pname)
  }

  function isBareQuerySig(typeNode) {
    // function type with first param identifier text/sql, or method signature
    const fn =
      ts.isFunctionTypeNode(typeNode) || ts.isMethodSignature(typeNode)
        ? typeNode
        : null
    if (!fn) return false
    return firstParamIsQueryText(fn.parameters)
  }

  function isBareQueryFn(fnNode) {
    // arrow/function expression whose first param is named text/sql/queryText
    return firstParamIsQueryText(fnNode.parameters)
  }

  visit(sf)
  return violations
}

const files = listTsFiles(SRC_ROOT)
const all = files.flatMap(checkFile)

if (all.length === 0) {
  console.log(
    `guard-db-paradigm: OK — no legacy DB-paradigm imports/types in ${files.length} files.`
  )
  process.exit(0)
}

console.error(`guard-db-paradigm: ${all.length} violation(s):\n`)
for (const v of all.sort((a, b) =>
  a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)
)) {
  console.error(`  ${v.file}:${v.line}  ${v.msg}`)
}
console.error(
  `\nUse \`Executor\` (Kysely<Database>: db or trx) + \`sql<Row>\`...\`.execute(executor)\`/native builder instead.`
)
process.exit(1)
