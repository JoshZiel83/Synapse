import test from "node:test"
import assert from "node:assert/strict"
import { decideBootstrapAction } from "./bootstrap.js"

test("decideBootstrapAction noop when current version already recorded", () => {
  const result = decideBootstrapAction({
    hasCurrentVersion: true,
    tableCount: 42,
    currentVersion: "2026-05-24-auth-refactor",
  })
  assert.equal(result.kind, "noop")
})

test("decideBootstrapAction applies schema on empty database", () => {
  const result = decideBootstrapAction({
    hasCurrentVersion: false,
    tableCount: 0,
    currentVersion: "2026-05-24-auth-refactor",
  })
  assert.equal(result.kind, "apply")
})

test("decideBootstrapAction fails loudly when prior schema exists at a different version", () => {
  const result = decideBootstrapAction({
    hasCurrentVersion: false,
    tableCount: 42,
    currentVersion: "2026-05-24-auth-refactor",
  })
  assert.equal(result.kind, "fail")
  if (result.kind !== "fail") return
  assert.match(result.message, /auth-refactor/)
  assert.match(result.message, /db:rebuild/)
  assert.match(result.message, /42 public tables/)
})
