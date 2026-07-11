import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CURRENT_SCHEMA_VERSION, decideBootstrapAction } from "./bootstrap.js"

const TEST_SCHEMA_VERSION = "test-schema-version"

const __dirname = dirname(fileURLToPath(import.meta.url))

// SHA-256 of schema.sql RECORDED at the version below. This structurally binds
// the schema CONTENT to CURRENT_SCHEMA_VERSION. `decideBootstrapAction` keys
// "noop" PURELY on the version STRING, so a schema.sql edit that FORGETS to bump
// CURRENT_SCHEMA_VERSION would silently noop on an already-bootstrapped database
// (the exact P1 recurrence this test guards). Any edit to schema.sql changes this
// hash and fails CI until the dev consciously reconciles BOTH values — see the
// failure message for the two-step fix.
//
// Hash is over the RAW schema.sql bytes (strip nothing) so a whitespace-only edit
// still trips it.
const RECORDED_SCHEMA_SHA256 =
  "a47e7ea7572690b8283440e927f159e0d01f19997e9d96fc6b6e9e8e34d0f65c"
const RECORDED_AT_VERSION = "2026-07-11-runtime-sandbox"

test("CURRENT_SCHEMA_VERSION fits the schema_migrations.version column", () => {
  // `schema_migrations.version` is `VARCHAR(64)`; long slugs cause
  // fresh DB bootstrap to error with `value too long for type
  // character varying(64)`. Putting the assertion here gives anyone
  // editing `bootstrap.ts` an immediate signal in CI before the
  // failure shows up at boot time.
  assert.ok(
    CURRENT_SCHEMA_VERSION.length <= 64,
    `CURRENT_SCHEMA_VERSION must be <=64 chars (was ${CURRENT_SCHEMA_VERSION.length}). ` +
      `Use CURRENT_SCHEMA_DESCRIPTION for narrative detail.`
  )
})

test("schema.sql content is bound to CURRENT_SCHEMA_VERSION (bump the version on any schema edit)", () => {
  const schemaSql = readFileSync(join(__dirname, "schema.sql"))
  const actual = createHash("sha256").update(schemaSql).digest("hex")
  assert.equal(
    actual,
    RECORDED_SCHEMA_SHA256,
    `schema.sql CHANGED (sha256 ${actual} != recorded ${RECORDED_SCHEMA_SHA256}).\n` +
      `decideBootstrapAction noop's PURELY on CURRENT_SCHEMA_VERSION, so an edited ` +
      `schema.sql that keeps the same version would SILENTLY skip re-applying on an ` +
      `already-bootstrapped database. To fix, in bootstrap.test.ts + bootstrap.ts:\n` +
      `  1. bump CURRENT_SCHEMA_VERSION to a new short slug (and update ` +
      `CURRENT_SCHEMA_DESCRIPTION),\n` +
      `  2. set RECORDED_SCHEMA_SHA256 = "${actual}" and RECORDED_AT_VERSION to the ` +
      `new CURRENT_SCHEMA_VERSION.\n` +
      `(If you only reformatted schema.sql with no semantic change, still do both — ` +
      `the hash is over raw bytes.)`
  )
  // Trip-wire: the recorded hash must always be re-recorded AGAINST the shipping
  // version. If these drift, the hash was updated without carrying the version
  // forward (or vice-versa) — the binding above would then be silently stale.
  assert.equal(
    RECORDED_AT_VERSION,
    CURRENT_SCHEMA_VERSION,
    `RECORDED_AT_VERSION (${RECORDED_AT_VERSION}) != CURRENT_SCHEMA_VERSION ` +
      `(${CURRENT_SCHEMA_VERSION}). When bumping the schema version + recorded hash, ` +
      `set RECORDED_AT_VERSION to the new CURRENT_SCHEMA_VERSION so the content↔version ` +
      `binding stays honest.`
  )
})

test("decideBootstrapAction noop when current version already recorded", () => {
  const result = decideBootstrapAction({
    hasCurrentVersion: true,
    tableCount: 42,
    currentVersion: TEST_SCHEMA_VERSION,
  })
  assert.equal(result.kind, "noop")
})

test("decideBootstrapAction applies schema on empty database", () => {
  const result = decideBootstrapAction({
    hasCurrentVersion: false,
    tableCount: 0,
    currentVersion: TEST_SCHEMA_VERSION,
  })
  assert.equal(result.kind, "apply")
})

test("decideBootstrapAction fails loudly when prior schema exists at a different version", () => {
  const result = decideBootstrapAction({
    hasCurrentVersion: false,
    tableCount: 42,
    currentVersion: TEST_SCHEMA_VERSION,
  })
  assert.equal(result.kind, "fail")
  if (result.kind !== "fail") return
  assert.match(result.message, new RegExp(TEST_SCHEMA_VERSION))
  assert.match(result.message, /db:rebuild/)
  assert.match(result.message, /42 public tables/)
})
