import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CURRENT_SCHEMA_VERSION,
  EFFECTIVE_SCHEMA_VERSION,
  SCHEMA_CONTENT_HASH,
  decideBootstrapAction,
} from "./bootstrap.js"

const TEST_SCHEMA_VERSION = "test-schema-version"

const __dirname = dirname(fileURLToPath(import.meta.url))

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

test("EFFECTIVE_SCHEMA_VERSION structurally binds schema.sql content (P1 recurrence guard)", () => {
  // STRUCTURAL binding (not developer discipline): the version RECORDED IN and
  // COMPARED AGAINST schema_migrations is the human slug PLUS a hash of the applied
  // schema DDL. So a schema.sql edit that FORGETS to bump CURRENT_SCHEMA_VERSION
  // still changes EFFECTIVE_SCHEMA_VERSION → an already-bootstrapped DB on the old
  // schema no longer matches → decideBootstrapAction returns "fail" (db:rebuild),
  // never a silent noop on a stale schema (the exact P1 recurrence). This test proves
  // the wiring: EFFECTIVE_SCHEMA_VERSION is slug-hash and the hash tracks the
  // extension-stripped schema.sql bootstrap actually applies. Unlike a recorded-hash
  // trip-wire, there is NO green-again action that skips the version binding — the
  // effective version IS the content.
  const schemaSql = readFileSync(join(__dirname, "schema.sql"), "utf-8")
  // Mirror bootstrap.ts's schemaSqlWithoutExtensions transform exactly.
  const applied = schemaSql.replace(
    /^CREATE EXTENSION IF NOT EXISTS .+;[\r]?\n?/gm,
    ""
  )
  const expectedHash = createHash("sha256")
    .update(applied)
    .digest("hex")
    .slice(0, 12)
  assert.equal(
    SCHEMA_CONTENT_HASH,
    expectedHash,
    "SCHEMA_CONTENT_HASH must be the 12-hex sha256 of the applied (extension-stripped) schema.sql — the binding is broken if it drifts"
  )
  assert.equal(
    EFFECTIVE_SCHEMA_VERSION,
    `${CURRENT_SCHEMA_VERSION}-${SCHEMA_CONTENT_HASH}`,
    "EFFECTIVE_SCHEMA_VERSION must be the human slug + content hash"
  )
  assert.ok(
    EFFECTIVE_SCHEMA_VERSION.length <= 64,
    `EFFECTIVE_SCHEMA_VERSION (${EFFECTIVE_SCHEMA_VERSION.length} chars) must fit schema_migrations.version VARCHAR(64); shorten CURRENT_SCHEMA_VERSION.`
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
