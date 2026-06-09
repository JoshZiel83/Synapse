#!/usr/bin/env node

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")
const baselinePath = resolve(
  repoRoot,
  "scripts/guard-datetime-boundaries-baseline.json"
)

const scanRoots = [
  "packages/api/src",
  "packages/shared/src",
  "packages/device-protocol/src",
  "packages/device-runtime/src",
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
])

const ignoredSuffixes = [".test.", ".spec."]

const ruleDefs = [
  {
    id: "mixed_date_string",
    message: "forbidden mixed time type `string | Date` / `Date | string`",
    pattern: /\b(?:string \| Date|Date \| string)\b/g,
  },
  {
    id: "unknown_as_date",
    message: "forbidden `as unknown as Date` cast",
    pattern: /as unknown as Date/g,
  },
  {
    id: "instanceof_date",
    message: "forbidden `instanceof Date` outside canonical helpers",
    pattern: /instanceof Date/g,
  },
  {
    id: "legacy_helper",
    message:
      "forbidden legacy helper name (`nowISO` / `toIsoString` / `normalizeTimestamp`)",
    pattern: /\b(?:nowISO|toIsoString|normalizeTimestamp)\b/g,
  },
  {
    id: "pseudo_row_string",
    message: "forbidden pseudo row type `*_at: string`",
    pattern: /\b[a-z_]+_at\??:\s*string(?: \| null)?\b/g,
  },
  {
    id: "camel_time_string",
    message: "forbidden camelCase time field typed as bare string",
    pattern:
      /\b(?:createdAt|updatedAt|expiresAt|startedAt|finishedAt|occurredAt|completedAt|lastBootstrappedAt|lastSyncedAt|lastSeenAt|lastConnectedAt|revokedAt|deliveredAt|lastInboundAt|lastOutboundAt|activeFrom|activeUntil|nextFireAt|firstFailedAt|lastAttemptAt|receivedAt|timestamp)\??:\s*string(?: \| null)?\b/g,
  },
  {
    id: "direct_to_iso_string",
    message: "forbidden direct `.toISOString()` outside canonical helpers",
    pattern: /\.toISOString\(/g,
  },
  {
    id: "fallback_now_iso",
    message: "forbidden current-time fallback for timestamp fields",
    pattern: /\|\|\s*(?:new Date\(\)\.toISOString\(\)|nowISO\()/g,
  },
]

const ruleAllowlist = {
  camel_time_string: new Set([
    "packages/shared/src/automation/rule-contract.ts",
  ]),
  direct_to_iso_string: new Set([
    "packages/device-protocol/src/instant.ts",
    "packages/shared/src/datetime/instant.ts",
  ]),
}

function listSourceFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
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

function buildViolations() {
  const violations = []
  for (const relRoot of scanRoots) {
    const absRoot = resolve(repoRoot, relRoot)
    for (const file of listSourceFiles(absRoot)) {
      const relPath = relative(repoRoot, file).split("\\").join("/")
      const text = readFileSync(file, "utf8")
      const lines = text.split(/\r?\n/)

      for (const rule of ruleDefs) {
        const allowlist = ruleAllowlist[rule.id]
        if (allowlist?.has(relPath)) continue

        for (const match of text.matchAll(rule.pattern)) {
          const before = text.slice(0, match.index)
          const line = before.split(/\r?\n/).length
          violations.push({
            rule: rule.id,
            file: relPath,
            line,
            snippet: lines[line - 1]?.trim() || "",
            message: rule.message,
          })
        }
      }
    }
  }
  return violations
}

function buildReport(violations) {
  const countsByRule = Object.fromEntries(ruleDefs.map((rule) => [rule.id, 0]))
  for (const violation of violations) {
    countsByRule[violation.rule] += 1
  }

  return {
    generatedAt: new Date().toISOString(),
    scriptVersion: 1,
    scanRoots,
    allowlist: Object.fromEntries(
      Object.entries(ruleAllowlist).map(([rule, files]) => [rule, [...files]])
    ),
    countsByRule,
    totalViolations: violations.length,
    violations,
  }
}

const writeBaseline = process.argv.includes("--write-baseline")
const violations = buildViolations()
const report = buildReport(violations)

if (writeBaseline) {
  writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(
    `guard-datetime-boundaries: wrote baseline to ${relative(repoRoot, baselinePath)}`
  )
  process.exit(0)
}

if (violations.length === 0) {
  console.log(
    `guard-datetime-boundaries: OK — no datetime boundary violations across ${scanRoots.length} scopes.`
  )
  process.exit(0)
}

console.error(
  `guard-datetime-boundaries: ${violations.length} violation(s) detected:\n`
)
for (const violation of violations) {
  console.error(
    `  ${violation.file}:${violation.line}  [${violation.rule}] ${violation.message}`
  )
  if (violation.snippet) {
    console.error(`    ${violation.snippet}`)
  }
}
console.error(
  `\nIf this is an intentional canonical helper change, update ${relative(repoRoot, baselinePath)} and the rule allowlist in scripts/guard-datetime-boundaries.mjs.`
)
process.exit(1)
