#!/usr/bin/env node
// Distributed-trace propagation guard.
//
// Two ratchet rules that keep the W3C-traceparent chain from silently breaking
// again (see the traceparent-correlation fixes: BullMQ fan-in, remote-agent
// daemon, api→sidecar egress):
//
//   1. untraced_worker — a raw `new Worker(...)` / `new Queue(...)` bypasses the
//      trace-context choke points (tracedWorker / tracedTickWorker in
//      workers/job-tracing.ts; the .add injection proxy in workers/queues.ts).
//      Enqueue→Redis→worker trace continuation only holds if EVERY worker/queue
//      goes through those. Allowed ONLY in those two files.
//
//   2. daemon_raw_egress — the remote-agent daemon has NO OTel SDK; it carries
//      the traceparent forward by injecting a header in api-client.ts
//      (requestJson). A raw `fetch(...)` / `http(s).request(...)` / direct
//      `undici` elsewhere in the daemon skips that injection, so the daemon→api
//      callback lands as a fresh trace root. Allowed ONLY in api-client.ts.
//
// Zero-violation (no baseline): both rules are clean today, so any new
// violation fails CI outright.
//
// Usage: node scripts/guard-trace-propagation.mjs

import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")

const ignoredDirs = new Set(["node_modules", "dist", "generated", ".next"])
const isTest = (p) => /\.(test|spec)\./.test(p)

/** Recursively list .ts files under `root` (repo-relative paths). */
function listTsFiles(root) {
  const abs = resolve(repoRoot, root)
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

const rules = [
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
]

const violations = []
for (const rule of rules) {
  const allow = new Set(rule.allow.map((p) => resolve(repoRoot, p)))
  for (const file of listTsFiles(rule.root)) {
    if (allow.has(file)) continue
    const lines = readFileSync(file, "utf8").split("\n")
    lines.forEach((line, i) => {
      if (rule.pattern.test(line)) {
        violations.push({
          rule: rule.id,
          file: relative(repoRoot, file),
          line: i + 1,
          text: line.trim(),
          hint: rule.hint,
        })
      }
    })
  }
}

if (violations.length > 0) {
  console.error(
    `✗ trace-propagation guard: ${violations.length} violation(s)\n`
  )
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.file}:${v.line}`)
    console.error(`    ${v.text}`)
    console.error(`    → ${v.hint}\n`)
  }
  process.exit(1)
}

console.log(
  "✓ trace-propagation guard clean (untraced_worker, daemon_raw_egress)"
)
