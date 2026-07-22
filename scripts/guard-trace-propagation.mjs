#!/usr/bin/env node
// Distributed-trace propagation guard.
//
// A set of zero-violation ratchet rules that keep the W3C-traceparent chain
// from silently breaking again (see the traceparent-correlation fixes: BullMQ
// fan-in, remote-agent daemon, api→sidecar egress, WS request-span orphans).
//
// RULE IDENTITY: every rule is keyed by a stable STRING id, never a sequential
// number. Rules are added by several independent workstreams (B/C/E/F/G), so a
// "rule 5 / 6 / 7" scheme would collide the moment two of them land. Ids are
// listed in the runner's clean-message, in arbitrary (append) order; this
// header does NOT promise contiguous numbering and new rules simply append a
// new id. The four ratchets that exist today:
//
//   untraced_worker — a raw `new Worker(...)` / `new Queue(...)` bypasses the
//     trace-context choke points (tracedWorker / tracedTickWorker in
//     workers/job-tracing.ts; the .add injection proxy in workers/queues.ts).
//     Enqueue→Redis→worker trace continuation only holds if EVERY worker/queue
//     goes through those. Allowed ONLY in those two files.
//
//   daemon_raw_egress — the remote-agent daemon has NO OTel SDK; it carries the
//     traceparent forward by injecting a header in api-client.ts (requestJson).
//     A raw `fetch(...)` / `http(s).request(...)` / direct `undici` elsewhere in
//     the daemon skips that injection, so the daemon→api callback lands as a
//     fresh trace root. Allowed ONLY in api-client.ts.
//
//   ws_route_missing_otel_false — a `websocket: true` fastify route whose
//     options line lacks `config: { otel: false }` lets @fastify/otel start a
//     `request` span for the upgrade that can never end (a WS upgrade never
//     completes as a normal reply) — the exact orphan §4.D of the trace plan
//     kills at the source on all four production WS routes. The rule is
//     line-based: keep `websocket: true` and its `config: { otel: false }` in
//     the same route-options literal on one line (all current sites are).
//
//   queue_enqueue_bypass — the queues.ts `.add` Proxy trap is the ONLY BullMQ
//     enqueue path that gets the `send {queue}` PRODUCER span + `__otelctx`
//     carrier (job-tracing.ts sendWithProducerSpan). BullMQ's other enqueue
//     APIs — `.addBulk()`, `FlowProducer`, `upsertJobScheduler`/
//     `.addJobScheduler()` — bypass the trap entirely (all grep-verified unused
//     today, §4.H), so adopting one must be a conscious, reviewed act that first
//     extends the trap and the producer span to cover it.
//
// Carrier-contract ratchets (workstream F — tracestate Level-2 conformance):
//
//   carrier_contract_drift (cross-file) — the tracestate gate is re-declared in
//     four files that cannot import @synapse/shared (the daemon bin, the
//     device-protocol zod fragment, the Go cua helper, the Rust fs-helper).
//     Byte-compares each duplicate's `synapse-trace-contract v2` comment block
//     AND its real code against the canonical literals in
//     packages/shared/src/utils/traceparent.ts. The behavioural half is the
//     shared golden vectors asserted from TS/Go/Rust tests (see the file
//     assertions below).
//
//   rogue_carrier_literal (line) — a traceparent/tracestate regex literal
//     anywhere OTHER than the canonical file + the two TS ledgers. Any other
//     copy is a fifth duplicate the drift guard cannot see.
//
//   bare_wire_trace_field (line) — a `traceparent:`/`tracestate:` zod field left
//     as a bare `z.string().optional()`. Every carrier position runs the gate;
//     the "trusted first-party producer" exemption was deleted.
//
// Ambient-extraction ratchet (workstream D — F8):
//
//   ambient_extract_base (cross-file) — a carrier extraction base must be
//     ROOT_CONTEXT, never `context.active()`. Extracting from the ambient
//     context inherits ambient baggage and any ambient `suppressTracing` key and
//     re-parents onto connection/loop-lifetime state (envelope-trace.ts's codified
//     "extract-or-ROOT, never context.active()" invariant). Bans `context.active()`
//     as the FIRST argument of any `extract…(` call (`propagator.extract(...)` or
//     `extractTraceCarrierContext(...)`) in packages/api/src — multi-line tolerant
//     (the formatter breaks each argument onto its own line). Scoped to `extract`
//     so the legitimate INJECT base (`injectTraceContext`'s `context.active()`) is
//     never flagged. A crossFileRule, not a line rule, precisely because the
//     regression form spans lines.
//
// Zero-violation (no baseline): all rules are clean today, so any new violation
// fails CI outright.
//
// ── ENGINE ────────────────────────────────────────────────────────────────
// Three rule families funnel into one violation shape
// `{ rule, file, line, text, hint }` and one printer / exit code:
//
//   (a) LINE RULES (`rules`) — a regex scanned line-by-line over a file set.
//         id             string   stable identity
//         root           string   repo-relative dir to walk (.ts, non-test);
//                                  ignored when `only` is present
//         only           string[] EXACT repo-relative files to scan INSTEAD of
//                                  walking `root` (path allowlist for the scan)
//         pattern        RegExp   a match on a non-`//` line is a candidate
//         unless         RegExp?  suppress when the SAME line also matches
//         unlessNextLine RegExp?  suppress when the NEXT line matches (a match
//                                  whose context lives one line down — e.g. a
//                                  formatter break after `(`)
//         allow          string[] repo-relative files exempt within `root`
//                                  (blocklist; composes with `only`)
//         hint           string
//
//   (b) CROSS-FILE RULES (`crossFileRules`) — a rule whose body inspects
//       MULTIPLE files and returns its own violations. Used for cross-file
//       invariants a single line-scan cannot express (e.g. "every literal in
//       file A also appears in file B").
//         id     string
//         hint   string
//         check(ctx) -> Array<{ file?, line?, text? }>
//       ctx = { repoRoot, readFile(rel)->string|null, fileExists(rel)->bool,
//               listTsFiles(root)->string[] }.
//
//   (c) FILE ASSERTIONS (`fileAssertions`) — assert a named file EXISTS at an
//       exact path (ANY extension — the .ts walker is not involved), optionally
//       constrained by a whole-file regex. A missing file is always a
//       violation; the regex fields refine it.
//         id             string
//         file           string   exact repo-relative path
//         mustContain    RegExp?  whole-file regex that MUST match
//         mustNotContain RegExp?  whole-file regex that must NOT match
//         hint           string
//
// Cluster rules are added to these three arrays by their own workstreams; this
// file owns only the engine + the four ratchets above.
//
// Usage: node scripts/guard-trace-propagation.mjs

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")

const ignoredDirs = new Set(["node_modules", "dist", "generated", ".next"])
const isTest = (p) => /\.(test|spec)\./.test(p)

/** Recursively list .ts files under `root` (absolute paths), skipping tests. */
export function listTsFiles(root, base = repoRoot) {
  const abs = resolve(base, root)
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (ignoredDirs.has(name)) continue
      const full = resolve(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (name.endsWith(".ts") && !isTest(name)) out.push(full)
    }
  }
  walk(abs)
  return out
}

// ── (a) line rules ──────────────────────────────────────────────────────────
export const rules = [
  {
    id: "untraced_worker",
    root: "packages/api/src",
    pattern: /\bnew\s+(Worker|Queue)\s*\(/,
    allow: [
      "packages/api/src/workers/job-tracing.ts",
      "packages/api/src/workers/queues.ts",
    ],
    hint: "route it through tracedWorker() / tracedTickWorker() (workers/job-tracing.ts) or the queues.ts lazyQueueProxy so the BullMQ trace continues",
  },
  {
    id: "daemon_raw_egress",
    root: "packages/remote-agent-daemon/src",
    pattern: /\bfetch\s*\(|\bhttps?\.request\s*\(|from\s+["']undici["']/,
    allow: ["packages/remote-agent-daemon/src/api-client.ts"],
    hint: "make the api call through api-client.ts requestJson() so getTraceparent() is injected as a header",
  },
  {
    id: "ws_route_missing_otel_false",
    root: "packages/api/src",
    pattern: /websocket:\s*true/,
    unless: /config:\s*\{\s*otel:\s*false\s*\}/,
    allow: [],
    hint: "a WS upgrade never completes as a normal reply, so @fastify/otel's request span would start and never end — add config: { otel: false } to the route options, on the same line as websocket: true (§4.D)",
  },
  {
    id: "queue_enqueue_bypass",
    root: "packages/api/src",
    pattern:
      /\.addBulk\s*\(|\bFlowProducer\b|\bupsertJobScheduler\b|\.addJobScheduler\s*\(/,
    allow: [],
    hint: "only the queues.ts .add Proxy trap carries the `send {queue}` PRODUCER span + __otelctx carrier — addBulk/FlowProducer/JobScheduler enqueues would silently break producer→consumer trace continuity; extend the trap + sendWithProducerSpan (workers/job-tracing.ts) before adopting a new enqueue API (§4.H)",
  },
  {
    // F (tracestate conformance): the traceparent lookahead `00-(?!0{32})` and
    // the Level-2 key char-class `[a-z0-9][a-z0-9_\-*/@]` are the carrier
    // contract's regex literals. They live in EXACTLY one canonical file and
    // its sanctioned duplicates; a copy anywhere else is a rogue re-declaration
    // that `carrier_contract_drift` cannot see (it only checks the known
    // ledgers). Comment lines are skipped by the engine, so the contract-block
    // documentation of the same regex does not trip this.
    id: "rogue_carrier_literal",
    root: "packages",
    pattern: /00-\(\?!0\{32\}\)|\[a-z0-9\]\[a-z0-9_\\-\*\/@\]/,
    allow: [
      "packages/shared/src/utils/traceparent.ts",
      "packages/remote-agent-daemon/src/trace-context.ts",
      "packages/device-protocol/src/schemas.ts",
    ],
    hint: "import the gate from @synapse/shared (or, for the no-dependency ledgers, extend the `synapse-trace-contract v2` block) — do NOT declare a second traceparent/tracestate regex; carrier_contract_drift only keeps the KNOWN copies in sync",
  },
  {
    // F: a `traceparent:`/`tracestate:` zod field must run the gate/regex, never
    // a bare `z.string().optional()` — the deleted "trusted first-party
    // producer" exemption. Every receiver, same gate.
    id: "bare_wire_trace_field",
    root: "packages",
    pattern: /(?:traceparent|tracestate):\s*z\.string\(\)\.optional\(\)/,
    allow: [],
    hint: "use `...wireTraceContextFields` (device-protocol/shared) or the gated traceparentField/tracestateField (daemon codec) — a bare z.string().optional() trace field is the ungated hop the carrier contract forbids",
  },
]

// ── (b) cross-file rules ──────────────────────────────────────────────────────
// Populated by workstreams that need a multi-file invariant. F owns
// `carrier_contract_drift` (below); other clusters append their own.

// The canonical carrier-contract file and the literals every duplicate mirrors.
const CARRIER_CANONICAL_FILE = "packages/shared/src/utils/traceparent.ts"
const CARRIER_CANONICAL_NAMES = [
  "TRACEPARENT_RE",
  "MAX_TRACESTATE_LENGTH",
  "MAX_TRACESTATE_MEMBERS",
  "TRACESTATE_KEY_RE",
  "TRACESTATE_VALUE_RE",
]
// TS duplicates carry the FULL gate (all five literals as real code + a
// contract-block comment); Go/Rust carry only traceparent + the numeric cap in
// the comment (their OTel library owns the tracestate ABNF), plus the numeric
// const in real code under the language-specific name.
const CARRIER_TS_LEDGERS = [
  "packages/remote-agent-daemon/src/trace-context.ts",
  "packages/device-protocol/src/schemas.ts",
]
const CARRIER_NATIVE_LEDGERS = [
  {
    file: "sidecars/cua/cmd/synapse-device-cua-helper/main.go",
    capConst: "maxTracestateLength",
  },
  {
    file: "sidecars/fs-helper/src/telemetry.rs",
    capConst: "MAX_TRACESTATE_LENGTH",
  },
]

const escapeReg = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** RHS literal of a real-code `const NAME = <value>` (comment lines removed so a
 * contract-block doc line can't shadow it; tolerates a prettier line-break after
 * `=`). Returns null when absent — callers MUST treat null as a loud failure. */
function realLiteral(content, name) {
  const code = content
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n")
  const m = code.match(
    new RegExp(`(?:export\\s+)?const\\s+${escapeReg(name)}\\s*=\\s*([^\\n]+)`)
  )
  return m ? m[1].trim() : null
}

/** RHS of a `// NAME = <value>` contract-block comment line (whitespace after
 * `//` is tolerant: TS/Rust use spaces, gofmt rewrites the run to a tab). */
function commentLiteral(content, name) {
  const m = content.match(new RegExp(`//\\s*${escapeReg(name)}\\s*=\\s*(.+)`))
  return m ? m[1].trim() : null
}

/** The integer of a numeric `const NAME[: type] = <int>` (Go or Rust). */
function numericConst(content, name) {
  const code = content
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n")
  const m = code.match(
    new RegExp(`const\\s+${escapeReg(name)}\\b[^=\\n]*=\\s*(\\d+)`)
  )
  return m ? m[1] : null
}

export const crossFileRules = [
  {
    // F: the carrier gate is re-declared in four files that cannot import
    // @synapse/shared. Byte-compare each duplicate's `synapse-trace-contract v2`
    // comment block AND its real code against the canonical literals, so no copy
    // can silently drift (RE2 has no lookahead, Rust has no regex crate — a
    // text guard is the only cross-language check possible; the golden-vector
    // tests cover behaviour). The extractor fails LOUD if it cannot find a
    // canonical literal (e.g. a formatting change it no longer tolerates).
    id: "carrier_contract_drift",
    hint: "mirror packages/shared/src/utils/traceparent.ts byte-for-byte in the `synapse-trace-contract v2` block AND the real code of this ledger (the guard extracts and compares both)",
    check(ctx) {
      const out = []
      const canon = ctx.readFile(CARRIER_CANONICAL_FILE)
      if (canon == null) {
        return [
          {
            file: CARRIER_CANONICAL_FILE,
            text: "canonical carrier-contract file is missing",
          },
        ]
      }
      const canonVals = {}
      for (const name of CARRIER_CANONICAL_NAMES) {
        const v = realLiteral(canon, name)
        if (v == null) {
          out.push({
            file: CARRIER_CANONICAL_FILE,
            text: `cannot extract canonical literal ${name} — the extractor no longer matches its formatting`,
          })
        } else {
          canonVals[name] = v
        }
      }
      if (out.length > 0) return out // fail loud rather than compare against holes

      for (const file of CARRIER_TS_LEDGERS) {
        const content = ctx.readFile(file)
        if (content == null) {
          out.push({ file, text: "sanctioned duplicate is missing" })
          continue
        }
        if (!content.includes("synapse-trace-contract v2")) {
          out.push({ file, text: "missing `synapse-trace-contract v2` block" })
        }
        for (const name of CARRIER_CANONICAL_NAMES) {
          const cmt = commentLiteral(content, name)
          if (cmt !== canonVals[name]) {
            out.push({
              file,
              text: `contract-block ${name} = ${cmt ?? "(absent)"} != canonical ${canonVals[name]}`,
            })
          }
          const real = realLiteral(content, name)
          if (real !== canonVals[name]) {
            out.push({
              file,
              text: `code literal ${name} = ${real ?? "(absent)"} != canonical ${canonVals[name]}`,
            })
          }
        }
      }

      for (const { file, capConst } of CARRIER_NATIVE_LEDGERS) {
        const content = ctx.readFile(file)
        if (content == null) {
          out.push({ file, text: "sanctioned duplicate is missing" })
          continue
        }
        if (!content.includes("synapse-trace-contract v2")) {
          out.push({ file, text: "missing `synapse-trace-contract v2` block" })
        }
        for (const name of ["TRACEPARENT_RE", "MAX_TRACESTATE_LENGTH"]) {
          const cmt = commentLiteral(content, name)
          if (cmt !== canonVals[name]) {
            out.push({
              file,
              text: `contract-block ${name} = ${cmt ?? "(absent)"} != canonical ${canonVals[name]}`,
            })
          }
        }
        const num = numericConst(content, capConst)
        if (num !== canonVals["MAX_TRACESTATE_LENGTH"]) {
          out.push({
            file,
            text: `numeric cap ${capConst} = ${num ?? "(absent)"} != canonical ${canonVals["MAX_TRACESTATE_LENGTH"]}`,
          })
        }
      }
      return out
    },
  },
  {
    // D (F8): a carrier extraction base must be ROOT_CONTEXT, never
    // context.active(). Bans context.active() as the first argument of any
    // `extract…(` call in packages/api/src — `propagator.extract(...)` and the
    // `extractTraceCarrierContext(...)` helper alike. Multi-line tolerant (the
    // \s* spans the newlines a formatter inserts between arguments), and scoped
    // to `extract` so injectTraceContext's legitimate INJECT base is not flagged.
    id: "ambient_extract_base",
    hint: "extraction bases must be ROOT_CONTEXT, never context.active() — extracting a carrier from the ambient context inherits ambient baggage/suppressTracing and re-parents onto connection/loop state (envelope-trace.ts's extract-or-ROOT invariant, F8). Pass ROOT_CONTEXT and, for a carrier, re-validate before extracting.",
    check(ctx) {
      const out = []
      const AMBIENT_EXTRACT_RE = /\bextract\w*\(\s*context\.active\(\)/
      for (const abs of ctx.listTsFiles("packages/api/src")) {
        let content
        try {
          content = readFileSync(abs, "utf8")
        } catch {
          continue
        }
        // Strip `//` comment lines so prose describing the pattern (this rule's
        // own docs, or a code comment) is never a false positive.
        const code = content
          .split("\n")
          .filter((l) => !l.trimStart().startsWith("//"))
          .join("\n")
        if (AMBIENT_EXTRACT_RE.test(code)) {
          out.push({
            file: relative(ctx.repoRoot, abs),
            text: "context.active() passed as an extraction base — use ROOT_CONTEXT",
          })
        }
      }
      return out
    },
  },
]

// ── (c) file assertions ───────────────────────────────────────────────────────
// Populated by workstreams that need to pin a non-.ts file's existence/shape.
// F pins that every language that carries a carrier-contract copy actually
// asserts the SHARED golden vectors (traceparent-vectors.json) — the behavioural
// half of the anti-drift, without which the byte guard could pass over code that
// no longer behaves identically.
const VECTORS_HINT =
  "assert the shared golden vectors (packages/shared/src/utils/traceparent-vectors.json) in this test so behaviour — not just the regex text — stays identical across languages"
export const fileAssertions = [
  {
    id: "vectors_asserted_shared",
    file: "packages/shared/src/utils/traceparent.test.ts",
    mustContain: /traceparent-vectors\.json/,
    hint: VECTORS_HINT,
  },
  {
    id: "vectors_asserted_daemon",
    file: "packages/remote-agent-daemon/src/trace-context.test.ts",
    mustContain: /traceparent-vectors\.json/,
    hint: VECTORS_HINT,
  },
  {
    id: "vectors_asserted_device_protocol",
    file: "packages/device-protocol/src/trace-context.schema.test.ts",
    mustContain: /traceparent-vectors\.json/,
    hint: VECTORS_HINT,
  },
  {
    id: "vectors_asserted_cua_go",
    file: "sidecars/cua/cmd/synapse-device-cua-helper/trace_test.go",
    mustContain: /traceparent-vectors\.json/,
    hint: VECTORS_HINT,
  },
  {
    id: "vectors_asserted_fs_helper_rust",
    file: "sidecars/fs-helper/src/telemetry.rs",
    mustContain: /traceparent-vectors\.json/,
    hint: VECTORS_HINT,
  },
]

/**
 * Evaluate line rules against the tree rooted at `base`.
 * @returns {Array<{rule,file,line,text,hint}>}
 */
export function evaluateRules(ruleList, base = repoRoot) {
  const violations = []
  for (const rule of ruleList) {
    const allow = new Set((rule.allow ?? []).map((p) => resolve(base, p)))
    // `only` scans an explicit path list instead of walking `root`.
    const files = rule.only
      ? rule.only.map((p) => resolve(base, p))
      : listTsFiles(rule.root, base)
    for (const file of files) {
      if (allow.has(file)) continue
      let content
      try {
        content = readFileSync(file, "utf8")
      } catch {
        // `only` may name a file a later cluster has not created yet; existence
        // is `fileAssertions`' job, not the line scanner's.
        continue
      }
      const lines = content.split("\n")
      lines.forEach((line, i) => {
        // Line-based ratchet: `//` comment lines can't register a route or
        // construct a worker — mentioning a pattern in prose is not a violation.
        if (line.trimStart().startsWith("//")) return
        if (!rule.pattern.test(line)) return
        if (rule.unless?.test(line)) return
        // unlessNextLine: suppress when the match's disqualifier lives one line
        // down (a formatter may break the guarded call onto the next line).
        if (rule.unlessNextLine?.test(lines[i + 1] ?? "")) return
        violations.push({
          rule: rule.id,
          file: relative(base, file),
          line: i + 1,
          text: line.trim(),
          hint: rule.hint,
        })
      })
    }
  }
  return violations
}

/**
 * Evaluate cross-file rules. Each rule's `check(ctx)` reads whatever files it
 * needs and returns partial violations `{ file?, line?, text? }`.
 * @returns {Array<{rule,file,line,text,hint}>}
 */
export function evaluateCrossFileRules(ruleList, base = repoRoot) {
  const violations = []
  const ctx = {
    repoRoot: base,
    readFile: (rel) => {
      try {
        return readFileSync(resolve(base, rel), "utf8")
      } catch {
        return null
      }
    },
    fileExists: (rel) => existsSync(resolve(base, rel)),
    listTsFiles: (root) => listTsFiles(root, base),
  }
  for (const rule of ruleList) {
    let partials
    try {
      partials = rule.check(ctx) ?? []
    } catch (err) {
      // A check that throws is itself a guard failure (e.g. a file it assumed
      // present has moved) — surface it, don't crash the whole run.
      partials = [{ text: `check threw: ${err?.message ?? err}` }]
    }
    for (const p of partials) {
      violations.push({
        rule: rule.id,
        file: p.file ?? "(multiple files)",
        line: p.line ?? 0,
        text: p.text ?? "",
        hint: rule.hint,
      })
    }
  }
  return violations
}

/**
 * Evaluate file assertions: each named file must exist (any extension), and may
 * be constrained by whole-file `mustContain` / `mustNotContain` regexes.
 * @returns {Array<{rule,file,line,text,hint}>}
 */
export function evaluateFileAssertions(assertions, base = repoRoot) {
  const violations = []
  for (const fa of assertions) {
    const abs = resolve(base, fa.file)
    let content
    try {
      content = readFileSync(abs, "utf8")
    } catch {
      violations.push({
        rule: fa.id,
        file: fa.file,
        line: 0,
        text: "expected file is missing",
        hint: fa.hint,
      })
      continue
    }
    if (fa.mustContain && !fa.mustContain.test(content)) {
      violations.push({
        rule: fa.id,
        file: fa.file,
        line: 0,
        text: `missing required content: ${fa.mustContain}`,
        hint: fa.hint,
      })
    }
    if (fa.mustNotContain && fa.mustNotContain.test(content)) {
      violations.push({
        rule: fa.id,
        file: fa.file,
        line: 0,
        text: `contains forbidden content: ${fa.mustNotContain}`,
        hint: fa.hint,
      })
    }
  }
  return violations
}

/** Collect violations from all three rule families. */
export function collectViolations(
  {
    rules: r = rules,
    crossFileRules: c = crossFileRules,
    fileAssertions: f = fileAssertions,
  } = {},
  base = repoRoot
) {
  return [
    ...evaluateRules(r, base),
    ...evaluateCrossFileRules(c, base),
    ...evaluateFileAssertions(f, base),
  ]
}

function main() {
  const violations = collectViolations()
  if (violations.length > 0) {
    console.error(
      `✗ trace-propagation guard: ${violations.length} violation(s)\n`
    )
    for (const v of violations) {
      console.error(`  [${v.rule}] ${v.file}${v.line ? `:${v.line}` : ""}`)
      if (v.text) console.error(`    ${v.text}`)
      console.error(`    → ${v.hint}\n`)
    }
    process.exit(1)
  }
  const ids = [
    ...rules.map((r) => r.id),
    ...crossFileRules.map((r) => r.id),
    ...fileAssertions.map((r) => r.id),
  ]
  console.log(`✓ trace-propagation guard clean (${ids.join(", ")})`)
}

/** True only when this file is the process entrypoint (not imported by a test). */
function isInvokedDirectly() {
  const entry = process.argv[1]
  if (entry == null) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isInvokedDirectly()) main()
