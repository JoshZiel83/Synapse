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

// TS/JS scopes + cross-language sidecars + the daemon/device-sdk surfaces that
// also speak the wire-instant contract.
const scanRoots = [
  "packages/api/src",
  "packages/shared/src",
  "packages/device-protocol/src",
  "packages/device-runtime/src",
  "packages/device-sdk/src",
  "packages/remote-agent-daemon/src",
  "packages/web-next",
  "packages/mobile-app/src",
  "sidecars/fs-helper/src",
  "sidecars/mijia-mcp",
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
  "target", // rust build
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  "build",
  "generated", // codegen output (kysely db.ts, codex SDK types) — enforced by codegen config, not this guard
])

const ignoredSuffixes = [".test.", ".spec."]

// Per-call-site escape hatch: a line carrying `datetime-ok` (or the line above
// it) is exempt. Use it ONLY for a deliberate, documented "now" default that is
// NOT a fallback masking a bad value (e.g. a genuine server-receive/eval time).
const ALLOW_MARKER = "datetime-ok"

const LANG_BY_EXT = {
  ts: "ts",
  tsx: "ts",
  cts: "ts",
  mts: "ts",
  js: "ts",
  jsx: "ts",
  cjs: "ts",
  mjs: "ts",
  rs: "rust",
  py: "python",
}

const ruleDefs = [
  // --- TS/JS rules ---
  {
    id: "mixed_date_string",
    langs: ["ts"],
    message: "forbidden mixed time type `string | Date` / `Date | string`",
    pattern: /\b(?:string \| Date|Date \| string)\b/g,
  },
  {
    id: "unknown_as_time_type",
    langs: ["ts"],
    message:
      "forbidden `as unknown as Date` / `as unknown as string` cast of a time value",
    pattern: /as unknown as (?:Date|string)\b/g,
  },
  {
    id: "instanceof_date",
    langs: ["ts"],
    message: "forbidden `instanceof Date` outside canonical helpers",
    pattern: /instanceof Date/g,
  },
  {
    id: "legacy_helper",
    langs: ["ts"],
    message:
      "forbidden legacy helper name (`nowISO` / `toIsoString` / `normalizeTimestamp`)",
    pattern: /\b(?:nowISO|toIsoString|normalizeTimestamp)\b/g,
  },
  {
    id: "pseudo_row_string",
    langs: ["ts"],
    message: "forbidden pseudo row type `*_at: string`",
    pattern: /\b[a-z_]+_at\??:\s*string(?: \| null)?\b/g,
  },
  {
    id: "camel_time_string",
    langs: ["ts"],
    message: "forbidden camelCase time field typed as bare string",
    pattern:
      /\b(?:createdAt|updatedAt|expiresAt|startedAt|finishedAt|occurredAt|completedAt|lastBootstrappedAt|lastSyncedAt|lastSeenAt|lastConnectedAt|revokedAt|deliveredAt|lastInboundAt|lastOutboundAt|activeFrom|activeUntil|nextFireAt|firstFailedAt|lastAttemptAt|receivedAt)\??:\s*string(?: \| null)?\b/g,
  },
  {
    id: "direct_to_iso_string",
    langs: ["ts"],
    message: "forbidden direct `.toISOString()` outside the canonical helper",
    pattern: /\.toISOString\(/g,
  },
  {
    id: "fallback_now",
    langs: ["ts"],
    message:
      "forbidden current-time fallback for a timestamp field (`|| new Date()` / `?? nowIsoInstant()` / `?? serverReceiveInstant()` / `|| Date.now()` / `?? dateToIsoInstant(new Date())`). A real value must fail loud; only a deliberate, `datetime-ok`-annotated server-receive/eval time may default to now. Matches an empty-arg now-call directly after `||`/`??` (incl. across a newline; an intervening comment/token breaks the match — which is also how the `datetime-ok` exemption works). KNOWN GAP: a ternary `cond ? x : now()` (collides with object-literal `key: now()`) and a constructor-parse `new Date(untrustedString)` (indistinguishable by regex from `new Date(canonicalInstant)`) are NOT machine-caught — those are enforced by converging every external INGESTION point on the canonical adapters + the branded `Timestamp` type, not by this guard.",
    pattern:
      /(?:\|\||\?\?)\s*(?:new Date\(\s*\)|nowIsoInstant\(\s*\)|serverReceiveInstant\(\s*\)|Date\.now\(\s*\)|dateToIsoInstant\(\s*new Date\(\s*\)\s*\))/g,
  },
  {
    id: "epoch_zero_fallback",
    langs: ["ts"],
    message: "forbidden `new Date(0)` — silently fabricates a 1970 instant",
    pattern: /new Date\(\s*0\s*\)/g,
  },
  {
    id: "magnitude_unit_guess",
    langs: ["ts"],
    message:
      "forbidden seconds/millis magnitude guess (`>= 1e12`). Use the explicit-unit adapters fromUnixSeconds/fromUnixMillis.",
    pattern: /[<>]=?\s*1e12\b|1_?000_?000_?000_?000/g,
  },
  // --- C1 structural rules: machine-lock the "single implementation" ---
  // These flag a SECOND copy of the canonical primitive anywhere outside the
  // two allowlisted canonical files, so the convergence can't silently regress.
  {
    id: "second_iso_regex",
    langs: ["ts"],
    message:
      "forbidden second ISO-instant regex literal. The ONE canonical pattern lives in device-protocol/src/instant.ts; reuse isIsoInstantString.",
    // Matches the date-shape `\d{4}-\d{2}` / `[0-9]{4}-[0-9]{2}` and the ISO
    // time-portion `T\d{2}:\d{2}` (date-specific, so an OTP `[0-9]{4}` regex
    // won't trip it). The `\\d{4}-\\d{2}` branch catches the `new RegExp("…")`
    // double-backslash string form that evades the regex-literal branch.
    pattern:
      /\\d\{4\}-\\d\{2\}|\\\\d\{4\}-\\\\d\{2\}|\[0-9\]\{4\}-\[0-9\]\{2\}|T\\d\{2\}:\\d\{2\}/g,
  },
  {
    id: "second_branded_type",
    langs: ["ts"],
    message:
      "forbidden second IsoInstantString brand/type definition. The canonical one lives in device-protocol/src/instant.ts; re-export it.",
    pattern: /__synapseIsoInstant|type IsoInstantString\s*=/g,
  },
  {
    id: "second_instant_schema",
    langs: ["ts"],
    message:
      "forbidden second IsoInstantString zod schema. The canonical one lives in device-protocol/src/instant.schema.ts; re-export it.",
    pattern: /z\.string\(\)\.refine\(\s*isIsoInstantString/g,
  },
  {
    id: "date_parse_controlflow",
    langs: ["ts"],
    message:
      "forbidden raw `Date.parse(`. Route external datetime strings through the single parser fromExternalRfc3339 (which fails loud), not a bare Date.parse + NaN check.",
    pattern: /\bDate\.parse\(/g,
  },
  {
    id: "blind_iso_cast",
    langs: ["ts"],
    message:
      "forbidden blind `as IsoInstantString` / `as Timestamp` cast. Produce branded instants via the canonical helpers (dateToIsoInstant / assertIsoInstantString / from*), never a cast.",
    pattern: /\bas (?:IsoInstantString|Timestamp)\b/g,
  },
  // --- Rust rules (fs-helper) ---
  {
    id: "rust_self_invented_instant",
    langs: ["rust"],
    message:
      "forbidden self-invented Rust instant format. Use the canonical iso_instant_now() (chrono to_rfc3339_opts Millis, Z).",
    pattern:
      /\bnow_stamp\b|\bnow_rfc3339_like\b|format!\("ts:|format!\("epoch:|\.to_rfc3339\(/g,
  },
  // --- Python rules (mijia) ---
  {
    id: "python_naive_isoformat",
    langs: ["python"],
    message:
      "forbidden naive/second datetime serialization. Use the shared utc_iso_millis() (UTC, millis, Z).",
    pattern:
      /datetime\.now\(\)\.isoformat|datetime\.utcnow|\.utcnow\(|datetime\.fromtimestamp|\btime\.time\(/g,
  },
]

// Per-file allowlist for rules with a small set of legitimate, non-time
// exceptions that cannot carry an inline comment.
const ruleAllowlist = {
  // device-protocol owns the ONE canonical conversion; it is the only place
  // `.toISOString()` may appear.
  direct_to_iso_string: new Set(["packages/device-protocol/src/instant.ts"]),
  // SSRF address coercion is a non-time `as unknown as string`.
  unknown_as_time_type: new Set([
    "packages/api/src/infrastructure/storage/ssrf.ts",
  ]),
  // The automation create-payload contract intentionally types raw, pre-parse
  // wire fields (activeFrom/activeUntil) as string at the HTTP boundary.
  camel_time_string: new Set([
    "packages/shared/src/automation/rule-contract.ts",
  ]),
  // The ONE canonical instant primitive + its zod schema. These are the only
  // files allowed to define the regex / brand / schema / use raw Date.parse.
  second_iso_regex: new Set(["packages/device-protocol/src/instant.ts"]),
  second_branded_type: new Set(["packages/device-protocol/src/instant.ts"]),
  second_instant_schema: new Set([
    "packages/device-protocol/src/instant.schema.ts",
  ]),
  date_parse_controlflow: new Set(["packages/device-protocol/src/instant.ts"]),
}

function listSourceFiles(dir) {
  const files = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return files // a scope dir may not exist in every checkout
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (ignoredDirs.has(entry)) continue
      files.push(...listSourceFiles(full))
      continue
    }
    if (ignoredSuffixes.some((suffix) => entry.includes(suffix))) continue
    const ext = entry.includes(".")
      ? entry.slice(entry.lastIndexOf(".") + 1)
      : ""
    const lang = LANG_BY_EXT[ext]
    if (!lang) continue
    files.push({ full, lang })
  }
  return files
}

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#)/
// The marker is only honoured inside a real comment (after `//` / `#`, or in a
// `*`/`/* */` block), so a string literal containing the text can't silence a
// rule.
const MARKER_IN_COMMENT = new RegExp(`(?://|#|\\*).*${ALLOW_MARKER}`)

// A match is inside a comment if a `//` precedes it on the line, or the line is
// a `*` / `/*` / `#` comment line. Prevents false positives from prose that
// merely *mentions* a forbidden pattern (e.g. an explanatory comment).
function matchInComment(line, matchCol) {
  // Mask string/template literals in the prefix so a `//` INSIDE a string can't
  // be mistaken for a comment start (which would hide a real same-line match).
  const prefix = line
    .slice(0, matchCol)
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "")
  // A `//` (not the `://` of a URL) before the match starts a line comment.
  if (/(?:^|[^:])\/\//.test(prefix)) return true
  const trimmed = line.trimStart()
  return (
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("#")
  )
}

function isAllowedAtSite(lines, lineIndex) {
  // Inline trailing (or full-line) comment on the flagged line itself.
  if (MARKER_IN_COMMENT.test(lines[lineIndex] ?? "")) return true
  // Or in the contiguous comment block directly above. We check the marker
  // BEFORE the comment-line break so a marker that the formatter has parked on
  // a non-pure-comment line (e.g. a ternary `? // datetime-ok`) is still
  // honoured. Stop only at the first line that is neither a comment nor carries
  // the marker.
  for (let i = lineIndex - 1; i >= 0; i--) {
    const line = lines[i] ?? ""
    if (MARKER_IN_COMMENT.test(line)) return true
    if (!COMMENT_LINE.test(line)) break
  }
  return false
}

function buildViolations() {
  const violations = []
  for (const relRoot of scanRoots) {
    const absRoot = resolve(repoRoot, relRoot)
    for (const { full, lang } of listSourceFiles(absRoot)) {
      const relPath = relative(repoRoot, full).split("\\").join("/")
      const text = readFileSync(full, "utf8")
      const lines = text.split(/\r?\n/)

      for (const rule of ruleDefs) {
        if (!rule.langs.includes(lang)) continue
        const allowlist = ruleAllowlist[rule.id]
        if (allowlist?.has(relPath)) continue

        for (const match of text.matchAll(rule.pattern)) {
          const before = text.slice(0, match.index)
          const lineNo = before.split(/\r?\n/).length
          const lineStart = text.lastIndexOf("\n", match.index - 1) + 1
          const matchCol = match.index - lineStart
          if (matchInComment(lines[lineNo - 1] ?? "", matchCol)) continue
          if (isAllowedAtSite(lines, lineNo - 1)) continue
          violations.push({
            rule: rule.id,
            file: relPath,
            line: lineNo,
            snippet: lines[lineNo - 1]?.trim() || "",
            message: rule.message,
          })
        }
      }
    }
  }
  return violations
}

// Defense-in-depth (B10): assert the kysely-codegen config still maps
// timestamp/timestamptz -> Date. A silent drift here would reintroduce the
// `Date | string` boundary the whole refactor removed. Not a source-regex rule
// — a config invariant.
function codegenConfigViolations() {
  const cfgPath = resolve(repoRoot, "packages/api/.kysely-codegenrc.json")
  let cfg
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8"))
  } catch {
    return [] // config absent in this checkout — nothing to assert
  }
  const tm = cfg.typeMapping ?? {}
  if (tm.timestamp === "Date" && tm.timestamptz === "Date") return []
  return [
    {
      rule: "codegen_timestamp_mapping",
      file: "packages/api/.kysely-codegenrc.json",
      line: 1,
      snippet: `typeMapping=${JSON.stringify(tm)}`,
      message:
        "kysely-codegen typeMapping must map timestamp & timestamptz to Date (drift reintroduces the Date|string boundary).",
    },
  ]
}

function buildReport(violations) {
  const countsByRule = Object.fromEntries(ruleDefs.map((rule) => [rule.id, 0]))
  for (const violation of violations) {
    countsByRule[violation.rule] = (countsByRule[violation.rule] ?? 0) + 1
  }

  return {
    scriptVersion: 2,
    scanRoots,
    allowlist: Object.fromEntries(
      Object.entries(ruleAllowlist).map(([rule, files]) => [rule, [...files]])
    ),
    countsByRule,
    totalViolations: violations.length,
    violations,
  }
}

// In-process self-test: asserts each rule fires on its bad form (and skips the
// known false-positive forms), and that the comment/evasion logic holds. Run in
// CI before the real scan so a broken rule fails loudly instead of silently
// passing everything. `node scripts/guard-datetime-boundaries.mjs --self-test`.
function selfTest() {
  const ruleById = (id) => ruleDefs.find((r) => r.id === id)
  const hits = (id, text) => [...text.matchAll(ruleById(id).pattern)].length > 0
  const checks = []
  const ok = (name, cond) => checks.push({ name, ok: !!cond })

  ok("fallback_now || new Date()", hits("fallback_now", "a || new Date()"))
  ok(
    "fallback_now ?? nowIsoInstant()",
    hits("fallback_now", "a ?? nowIsoInstant()")
  )
  ok(
    "fallback_now multi-line",
    hits("fallback_now", "a ||\n  serverReceiveInstant()")
  )
  ok(
    "fallback_now skips new Date(value)",
    !hits("fallback_now", "a || new Date(x)")
  )
  ok("second_iso_regex literal", hits("second_iso_regex", "/\\d{4}-\\d{2}/"))
  ok(
    "second_iso_regex new RegExp",
    hits("second_iso_regex", 'new RegExp("\\\\d{4}-\\\\d{2}")')
  )
  ok("second_iso_regex skips OTP", !hits("second_iso_regex", "/[0-9]{4}/"))
  ok(
    "second_branded_type",
    hits("second_branded_type", "type IsoInstantString = string")
  )
  ok(
    "second_instant_schema",
    hits("second_instant_schema", "z.string().refine(isIsoInstantString)")
  )
  ok("date_parse_controlflow", hits("date_parse_controlflow", "Date.parse(x)"))
  ok("blind_iso_cast", hits("blind_iso_cast", "x as Timestamp"))
  ok("epoch_zero_fallback", hits("epoch_zero_fallback", "new Date(0)"))
  ok("magnitude_unit_guess", hits("magnitude_unit_guess", "n >= 1e12"))
  ok(
    "unknown_as_time_type",
    hits("unknown_as_time_type", "x as unknown as string")
  )
  ok(
    "rust_self_invented",
    hits("rust_self_invented_instant", 'format!("ts:{s}")')
  )
  ok(
    "rust_bare_to_rfc3339",
    hits("rust_self_invented_instant", "t.to_rfc3339()")
  )
  ok(
    "python_naive",
    hits("python_naive_isoformat", "datetime.now().isoformat()")
  )
  ok(
    "python_fromtimestamp",
    hits("python_naive_isoformat", "datetime.fromtimestamp(0)")
  )

  // matchInComment must mask a `//` that lives inside a string literal.
  const masked = 'const s = "a // b"; const t = x || new Date()'
  ok(
    "matchInComment masks string //",
    !matchInComment(masked, masked.indexOf("|| new Date()"))
  )
  ok("matchInComment honors real //", matchInComment("  // x || new Date()", 7))
  // isAllowedAtSite must honor a datetime-ok marker the formatter parked on a `? //` line.
  ok(
    "isAllowedAtSite ternary marker",
    isAllowedAtSite(["x", "  ? // datetime-ok: y", "    a || new Date()"], 2)
  )

  const failed = checks.filter((c) => !c.ok)
  if (failed.length) {
    console.error("guard-datetime-boundaries: SELF-TEST FAILED:")
    for (const f of failed) console.error(`  ✗ ${f.name}`)
    process.exit(1)
  }
  console.log(
    `guard-datetime-boundaries: self-test OK (${checks.length} assertions).`
  )
  process.exit(0)
}

if (process.argv.includes("--self-test")) selfTest()

const writeBaseline = process.argv.includes("--write-baseline")
const violations = [...buildViolations(), ...codegenConfigViolations()]
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
  `\nIf a flagged line is a deliberate, documented "now" default (not a value-masking fallback), add a \`${ALLOW_MARKER}: <reason>\` comment on (or directly above) that line. For a new canonical-helper change, update the rule allowlist in scripts/guard-datetime-boundaries.mjs.`
)
process.exit(1)
