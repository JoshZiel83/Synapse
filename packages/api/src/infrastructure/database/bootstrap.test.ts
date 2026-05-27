import test from "node:test"
import assert from "node:assert/strict"
import { CURRENT_SCHEMA_VERSION, decideBootstrapAction } from "./bootstrap.js"

const TEST_SCHEMA_VERSION = "test-schema-version"

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
