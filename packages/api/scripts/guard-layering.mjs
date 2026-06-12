#!/usr/bin/env node
// guard-layering: enforce the DB / DTO / wire layering rules inside
// packages/api/src/modules/** (docs/architecture-boundary-refactor-master-plan.md
// §9). Text-based, allowlist-ratcheted: the baseline file records the set of
// files that still violate each rule during the in-flight migration, and the
// guard fails if a NEW violation appears outside the baseline. As modules are
// converted to repo/service/presenter, entries are removed from the baseline —
// it can only shrink (a violation removed from a file but still listed is also
// reported, so the baseline never goes stale silently).
//
// Rules:
//   r1_generated_db_outside_repo : only repo*.ts / repo.types.ts may import
//       generated/db or db-types.
//   r2_tablerow_outside_repo     : only repo*.ts / repo.types.ts may use
//       TableRow< / TableInsert< / TableUpdate< (the kysely alias). service /
//       controller / helper files must take repo.types records instead.
//   r3_serializeinstant_in_layer : time-serialization (serializeInstant /
//       serializeOptionalInstant) is allowed ONLY in presenter*.ts (Date→ISO is
//       the presenter's job) — NOT in controllers, services, connectors, infra
//       helpers, runtime files, etc. repo*.ts is excluded here because the repo
//       still emits ISO strings; converting repo to emit Date is tracked under
//       P1-7. Broadened in round-6 P1-9 from the old service*/controller* match,
//       which missed controller/dingtalk.ts, parse-service.ts, runtime.ts, …
//   r4_maprow_outside_repo       : map*Row / normalize*Row defs only in repo*.ts.
//   r5_bare_route_in_mixed       : mixed (Tier C) modules must register routes
//       via appRoute()/wireRoute() (or split *.app.ts/*.wire.ts), never bare
//       app.get/post/put/delete/patch(...). §5.3 mechanism.
//   r7_dual_naming               : no `row.foo_bar || row.fooBar` and no
//       outward `...row` spread.
//   r8_db_client_outside_repo    : only repo*.ts may import the DB client
//       (`db` / withDbTransaction from infrastructure/database/kysely) or the
//       `sql` builder from "kysely". Non-repo module files must go through the
//       repo. Baseline-ratcheted while modules migrate (P1-6).
//
// Usage: node scripts/guard-layering.mjs          (exit 1 on new violation)
//        node scripts/guard-layering.mjs --write  (regenerate baseline)

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const MODULES = resolve(here, "../src/modules")
const REPO_ROOT = resolve(here, "../../..")
const BASELINE = resolve(here, "guard-layering-baseline.json")
const WRITE = process.argv.includes("--write")

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (
      p.endsWith(".ts") &&
      !p.endsWith(".test.ts") &&
      !p.endsWith(".d.ts")
    )
      out.push(p)
  }
  return out
}

const isRepo = (p) => /(^|\/)repo[^/]*\.ts$|(^|\/)repo\.types\.ts$/.test(p)
const isPresenter = (p) => /(^|\/)presenter[^/]*\.ts$/.test(p)
// r3 (time-serialization boundary) applies to every module file EXCEPT
// presenters (the legitimate home for Date→ISO) and repo*.ts (repo currently
// emits ISO strings; converting it to emit Date is tracked under P1-7, so repo
// is excluded here to avoid double-counting that migration). This catches the
// round-6 P1-9 leak: serializeInstant in controller/dingtalk.ts, parse-service.ts,
// service/repo.ts, runtime.ts, etc. — files the old `service*/controller*`
// filename match missed. Baseline-ratcheted: existing offenders are
// grandfathered; new ones fail.
const isTimeSerializationLayer = (p) => !isPresenter(p) && !isRepo(p)

// §7 Tier C mixed modules (app + wire in one module). Their route
// registrations must go through the §5.3 appRoute()/wireRoute() markers (or a
// split *.app.ts / *.wire.ts controller), never bare app.<verb>(...).
const MIXED_MODULES = new Set([
  "automation",
  "im",
  "mcp-plugins",
  "remote-agents",
  "runtime-authorizations",
  "files",
  "devices",
  "relationship",
])
const moduleOf = (p) => {
  const m = p.split("/modules/")[1]
  return m ? m.split("/")[0] : ""
}
const isMixedModuleFile = (p) => MIXED_MODULES.has(moduleOf(p))

// r8 allowlist: files that are the DESIGNATED db-edge-binders for their module
// (they import the runtime defaultDb purely to bind it into request-handler-
// facing wrappers — the same role infrastructure/** plays, but they live under
// modules/ for cohesion). access/guards.ts binds defaultDb into
// requireRequestAction + authorizeActionDefault/etc. so controllers don't import
// the client (round-6 P1-6). These are intentional boundaries, not leaks.
const R8_ALLOWLIST = new Set(["access/guards.ts"])
const r8Key = (p) => {
  const m = p.split("/modules/")[1]
  return m || ""
}

const RULES = [
  {
    id: "r1_generated_db_outside_repo",
    appliesTo: (p) => !isRepo(p),
    test: (src) =>
      /from\s+["'][^"']*\/(generated\/db|db-types)(\.js)?["']/.test(src),
  },
  {
    id: "r2_tablerow_outside_repo",
    appliesTo: (p) => !isRepo(p),
    test: (src) => /\bTable(Row|Insert|Update)\s*</.test(src),
  },
  {
    id: "r3_serializeinstant_in_layer",
    appliesTo: isTimeSerializationLayer,
    test: (src) => /\bserialize(Optional)?Instant\s*\(/.test(src),
  },
  {
    // r4: row→domain mappers belong in repo*.ts. Matches map*/normalize* names
    // where "Row" appears anywhere (not only as a suffix), so it also catches
    // mapAccessRowToGrant / mapSkillAccessRowToGrant (round-6 P2-2 broadened it
    // from the old "ends in Row" form).
    id: "r4_maprow_outside_repo",
    appliesTo: (p) => !isRepo(p),
    test: (src) =>
      /\b(?:function|const)\s+(?:map|normalize)[A-Za-z0-9]*Row[A-Za-z0-9]*\b/.test(
        src
      ),
  },
  {
    id: "r5_bare_route_in_mixed",
    appliesTo: isMixedModuleFile,
    // matches app.get(...) AND app.get<{...}>(...) — the optional generic-arg
    // form used by typed Fastify handlers.
    test: (src) => /\bapp\.(get|post|put|delete|patch)\s*[<(]/.test(src),
  },
  {
    id: "r7_dual_naming",
    appliesTo: () => true,
    test: (src) =>
      /\brow\.[a-z]+_[a-z_]+\s*\|\|\s*row\.[a-z]+[A-Z]/.test(src) ||
      /\breturn\s*\{\s*\.\.\.row\b/.test(src) ||
      /\bsend\(\s*\{\s*\.\.\.row\b/.test(src),
  },
  {
    // r8: only repo*.ts may reach the DB client / Kysely query builder. A
    // non-repo module file that imports `db` (or withDbTransaction) from
    // infrastructure/database/kysely, or the `sql` tag from "kysely", is doing
    // data access outside the repo boundary (§9). Baseline-ratcheted: the ~96
    // pre-existing offenders are grandfathered while modules migrate their
    // queries into repo.ts; a NEW non-repo DB reach fails. Genuine
    // infrastructure adapters live under infrastructure/** (not walked here),
    // so they're unaffected; designated module-level db-edge-binders are in
    // R8_ALLOWLIST (e.g. access/guards.ts).
    id: "r8_db_client_outside_repo",
    appliesTo: (p) => !isRepo(p) && !R8_ALLOWLIST.has(r8Key(p)),
    test: (src) =>
      /\bimport\s*\{[^}]*\b(?:db|withDbTransaction)\b[^}]*\}\s*from\s*["'][^"']*\/infrastructure\/database\/kysely(\.js)?["']/.test(
        src
      ) || /\bimport\s*\{[^}]*\bsql\b[^}]*\}\s*from\s*["']kysely["']/.test(src),
  },
]

const files = walk(MODULES)

// Strip line + block comments so a rule's keyword inside a doc-comment (e.g.
// "never uses TableRow<...>") is not a false positive. String literals are left
// intact — the rules target code constructs, not arbitrary strings.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

const current = {}
for (const r of RULES) current[r.id] = []
for (const p of files) {
  const src = stripComments(readFileSync(p, "utf8"))
  const rel = relative(REPO_ROOT, p)
  for (const r of RULES) {
    if (r.appliesTo(p) && r.test(src)) current[r.id].push(rel)
  }
}
for (const r of RULES) current[r.id].sort()

if (WRITE) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + "\n")
  const total = Object.values(current).reduce((a, b) => a + b.length, 0)
  console.log(`guard-layering: wrote baseline (${total} grandfathered entries)`)
  process.exit(0)
}

let baseline = {}
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"))
} catch {
  console.error(
    "guard-layering: missing baseline; run `node scripts/guard-layering.mjs --write`"
  )
  process.exit(1)
}

let failed = false
for (const r of RULES) {
  const allow = new Set(baseline[r.id] ?? [])
  const cur = new Set(current[r.id] ?? [])
  const added = [...cur].filter((f) => !allow.has(f))
  const removed = [...allow].filter((f) => !cur.has(f))
  if (added.length) {
    failed = true
    console.error(`\n✗ [${r.id}] NEW violations (not in baseline):`)
    for (const f of added) console.error(`    ${f}`)
  }
  if (removed.length) {
    failed = true
    console.error(
      `\n✗ [${r.id}] baseline is STALE — these files no longer violate; remove them from the baseline:`
    )
    for (const f of removed) console.error(`    ${f}`)
  }
}

if (failed) {
  console.error(
    "\nguard-layering FAILED. Fix the new violation, or (if a file was cleaned) run --write to shrink the baseline."
  )
  process.exit(1)
}
console.log("guard-layering: clean (no new layering violations)")
