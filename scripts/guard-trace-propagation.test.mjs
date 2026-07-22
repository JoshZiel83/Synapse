// Self-test for the carrier-contract engine in guard-trace-propagation.mjs.
//
// The guard's whole job is to catch a ledger drifting from the canonical
// carrier contract (packages/shared/src/utils/traceparent.ts). This test pins
// that the ENGINE still fires — a future refactor of the extractor/regexes that
// silently stops detecting drift would otherwise pass CI while the ratchet is
// dead. Strategy: build a throwaway fixture tree that mirrors the five
// carrier-contract files, assert a CLEAN copy yields no `carrier_contract_drift`
// violation, then mutate ONE ledger literal and assert the rule fires.
//
// Run: node --test scripts/guard-trace-propagation.test.mjs
import assert from "node:assert/strict"
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import {
  crossFileRules,
  evaluateCrossFileRules,
} from "./guard-trace-propagation.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")

// The five files the `carrier_contract_drift` rule reads (canonical + the four
// sanctioned duplicates). Kept in sync with the guard's CARRIER_* constants; if
// a ledger is added there, the CLEAN-fixture assertion below fails loudly with a
// "sanctioned duplicate is missing" violation — a deliberate stale-fixture trip.
const CARRIER_FILES = [
  "packages/shared/src/utils/traceparent.ts",
  "packages/remote-agent-daemon/src/trace-context.ts",
  "packages/device-protocol/src/schemas.ts",
  "sidecars/cua/cmd/synapse-device-cua-helper/main.go",
  "sidecars/fs-helper/src/telemetry.rs",
]

const DAEMON_LEDGER = "packages/remote-agent-daemon/src/trace-context.ts"

/** Copy the five real carrier files into a fresh fixture root, byte-for-byte. */
function buildFixture() {
  const base = mkdtempSync(join(tmpdir(), "guard-trace-selftest-"))
  for (const rel of CARRIER_FILES) {
    const dest = resolve(base, rel)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(resolve(repoRoot, rel), dest)
  }
  return base
}

const driftViolations = (base) =>
  evaluateCrossFileRules(crossFileRules, base).filter(
    (v) => v.rule === "carrier_contract_drift"
  )

test("carrier_contract_drift: a clean fixture (real files) passes", () => {
  const base = buildFixture()
  try {
    assert.deepEqual(
      driftViolations(base),
      [],
      "an unmodified mirror of the ledgers must produce no drift violation"
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("carrier_contract_drift: mutating a ledger literal fires the rule", () => {
  const base = buildFixture()
  try {
    // Drift the daemon ledger's real-code MAX_TRACESTATE_MEMBERS 32 → 31 (the
    // contract-block comment stays 32, so exactly the code-literal check trips).
    const ledgerPath = resolve(base, DAEMON_LEDGER)
    const original = readFileSync(ledgerPath, "utf8")
    const mutated = original.replace(
      "export const MAX_TRACESTATE_MEMBERS = 32",
      "export const MAX_TRACESTATE_MEMBERS = 31"
    )
    assert.notEqual(
      mutated,
      original,
      "mutation anchor must exist in the ledger"
    )
    writeFileSync(ledgerPath, mutated)

    const violations = driftViolations(base)
    assert.ok(
      violations.length >= 1,
      "a drifted ledger literal must raise a carrier_contract_drift violation"
    )
    assert.ok(
      violations.some(
        (v) => v.file === DAEMON_LEDGER && /MAX_TRACESTATE_MEMBERS/.test(v.text)
      ),
      `expected a MAX_TRACESTATE_MEMBERS drift on ${DAEMON_LEDGER}, got ${JSON.stringify(violations)}`
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
