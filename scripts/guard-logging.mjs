#!/usr/bin/env node
// Logging boundary guard (logging refactor).
//
// Two rules:
//   1. raw_console — bans `console.*` in app source. EXISTING usage is
//      grandfathered by a per-file COUNT baseline (count discipline: a file may
//      keep up to its baselined count; any NEW console call fails CI). The
//      baseline only ratchets DOWN — regenerate it with --write-baseline after
//      migrating a file. This is the regression dam from
//      docs/logging-refactor/02-recommendation.md / 03-decisions.md.
//   2. unmapped_scope — every `createLogger("X")` in packages/api/src must map to
//      the closed domain taxonomy. The allowed scope set is read LIVE from
//      SCOPE_TO_DOMAIN in infrastructure/logger/index.ts (self-syncing, no
//      duplication), so the business-domain log identifiers stay reliable: a
//      typo'd or unmapped scope fails CI instead of silently falling back.
//
// Usage:
//   node scripts/guard-logging.mjs                 # check (CI / pretest)
//   node scripts/guard-logging.mjs --write-baseline  # snapshot current counts

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")
const baselinePath = resolve(repoRoot, "scripts/guard-logging-baseline.json")
const loggerModulePath = resolve(
  repoRoot,
  "packages/api/src/infrastructure/logger/index.ts"
)

const scanRoots = [
  "packages/api/src",
  "packages/shared/src",
  "packages/device-protocol/src",
  "packages/device-runtime/src",
  "packages/remote-agent-daemon/src",
  "packages/web-next",
  "packages/mobile-app/src",
]

const ignoredDirs = new Set([
  "node_modules",
  "dist",
  ".next",
  ".expo",
  "public",
  ".agents",
  ".claude",
  ".github",
  "generated",
])

const ignoredSuffixes = [".test.", ".spec."]

// Files where console is the legitimate, intended output channel forever (CLI
// result writers / the logger's own pretty fallback). These are NOT counted.
const rawConsoleAllowlist = new Set([
  // Logger implementations themselves legitimately use console (dev mirror /
  // pretty fallback) — the same exemption the api pino logger gets.
  "packages/web-next/lib/client-logger.ts",
  "packages/mobile-app/src/lib/client-logger.ts",
])

const CONSOLE_RE = /\bconsole\.(?:log|info|warn|error|debug|trace)\b/g
const CREATE_LOGGER_RE = /\bcreateLogger\(\s*"([^"]+)"\s*\)/g

function listSourceFiles(dir) {
  const files = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return files
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (ignoredDirs.has(entry)) continue
      files.push(...listSourceFiles(full))
      continue
    }
    if (!/\.(?:[cm]?[jt]sx?)$/.test(entry)) continue
    if (ignoredSuffixes.some((suffix) => entry.includes(suffix))) continue
    files.push(full)
  }
  return files
}

/** Allowed createLogger scopes, read live from SCOPE_TO_DOMAIN in the logger. */
function loadAllowedScopes() {
  const text = readFileSync(loggerModulePath, "utf8")
  const start = text.indexOf("SCOPE_TO_DOMAIN")
  const slice = start >= 0 ? text.slice(start) : text
  const scopes = new Set()
  // Match table entries: `"ai.sdk": { domain:` and `ai: { domain:`.
  const entryRe = /(?:"([\w.-]+)"|([A-Za-z][\w]*))\s*:\s*\{\s*domain:/g
  for (const m of slice.matchAll(entryRe)) {
    scopes.add(m[1] ?? m[2])
  }
  return scopes
}

function countConsole(text) {
  const m = text.match(CONSOLE_RE)
  return m ? m.length : 0
}

function consoleLines(text) {
  const lines = text.split(/\r?\n/)
  const out = []
  for (const match of text.matchAll(CONSOLE_RE)) {
    const line = text.slice(0, match.index).split(/\r?\n/).length
    out.push({ line, snippet: lines[line - 1]?.trim() || "" })
  }
  return out
}

// --- collect current state ---
const consoleCounts = {} // relPath -> count
const consoleDetails = {} // relPath -> [{line, snippet}]
const unmappedScopes = [] // {file, line, scope}
const allowedScopes = loadAllowedScopes()

for (const relRoot of scanRoots) {
  const absRoot = resolve(repoRoot, relRoot)
  for (const file of listSourceFiles(absRoot)) {
    const relPath = relative(repoRoot, file).split("\\").join("/")
    const text = readFileSync(file, "utf8")

    if (!rawConsoleAllowlist.has(relPath)) {
      const n = countConsole(text)
      if (n > 0) {
        consoleCounts[relPath] = n
        consoleDetails[relPath] = consoleLines(text)
      }
    }

    // unmapped_scope: only the api package owns the createLogger taxonomy.
    if (relPath.startsWith("packages/api/src/")) {
      const lines = text.split(/\r?\n/)
      for (const m of text.matchAll(CREATE_LOGGER_RE)) {
        const scope = m[1]
        if (!allowedScopes.has(scope)) {
          const line = text.slice(0, m.index).split(/\r?\n/).length
          unmappedScopes.push({
            file: relPath,
            line,
            scope,
            snippet: lines[line - 1]?.trim() || "",
          })
        }
      }
    }
  }
}

const writeBaseline = process.argv.includes("--write-baseline")

if (writeBaseline) {
  const report = {
    generatedAt: new Date().toISOString(),
    scriptVersion: 1,
    scanRoots,
    note: "Per-file console counts grandfathered. Ratchets DOWN only — new console calls fail CI. Regenerate after migrating a file.",
    rawConsoleCounts: Object.fromEntries(
      Object.entries(consoleCounts).sort(([a], [b]) => a.localeCompare(b))
    ),
    totalRawConsole: Object.values(consoleCounts).reduce((a, b) => a + b, 0),
  }
  writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(
    `guard-logging: wrote baseline (${report.totalRawConsole} console calls across ${Object.keys(consoleCounts).length} files) to ${relative(repoRoot, baselinePath)}`
  )
  process.exit(0)
}

let baseline = { rawConsoleCounts: {} }
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8"))
} catch {
  console.error(
    `guard-logging: baseline not found at ${relative(repoRoot, baselinePath)} — run \`node scripts/guard-logging.mjs --write-baseline\` first.`
  )
  process.exit(1)
}

const failures = []

// raw_console: fail when a file's current count exceeds its baseline.
for (const [file, count] of Object.entries(consoleCounts)) {
  const allowed = baseline.rawConsoleCounts?.[file] ?? 0
  if (count > allowed) {
    failures.push({
      rule: "raw_console",
      file,
      message: `${count} console.* call(s) — baseline allows ${allowed}. New raw console is forbidden; use createLogger(...) (or the surface's logger) instead.`,
      lines: consoleDetails[file],
    })
  }
}

// unmapped_scope: always enforced.
for (const u of unmappedScopes) {
  failures.push({
    rule: "unmapped_scope",
    file: u.file,
    message: `createLogger("${u.scope}") at line ${u.line} is not in SCOPE_TO_DOMAIN — add a {domain, component} row in infrastructure/logger/index.ts so the log identifier is reliable.`,
    lines: [{ line: u.line, snippet: u.snippet }],
  })
}

if (failures.length === 0) {
  console.log(
    `guard-logging: OK — no new console debt; all createLogger scopes map to the domain taxonomy (${allowedScopes.size} scopes).`
  )
  process.exit(0)
}

console.error(`guard-logging: ${failures.length} failure(s):\n`)
for (const f of failures) {
  console.error(`  [${f.rule}] ${f.file}`)
  console.error(`    ${f.message}`)
  for (const l of f.lines ?? []) {
    if (l.snippet) console.error(`      ${f.file}:${l.line}  ${l.snippet}`)
  }
}
console.error(
  `\nIf you intentionally migrated a file (removed console), regenerate the baseline:\n  node scripts/guard-logging.mjs --write-baseline`
)
process.exit(1)
