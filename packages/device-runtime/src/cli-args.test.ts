import { test } from "node:test"
import assert from "node:assert/strict"

import { parseArgs } from "./cli-args.js"

test("parseArgs: --flag with explicit =value", () => {
  const out = parseArgs(["install-bundles", "--platform=linux-x64"])
  assert.equal(out.cmd, "install-bundles")
  assert.equal(out.flags.get("platform"), "linux-x64")
})

test("parseArgs: --flag with separate value token", () => {
  const out = parseArgs(["install-bundles", "--platform", "linux-x64"])
  assert.equal(out.flags.get("platform"), "linux-x64")
})

test("parseArgs: bare boolean flag at end of argv => 'true'", () => {
  const out = parseArgs(["install-bundles", "--strict"])
  assert.equal(out.flags.get("strict"), "true")
})

test("parseArgs: bare boolean flag followed by another --flag does NOT swallow it", () => {
  // Regression for the user-reported parseArgs bug: the old shape
  // consumed argv[++i] unconditionally, so
  //   `--require-prestaged --bundled-toolchain-dir /tmp/x`
  // set require-prestaged="--bundled-toolchain-dir" and dropped
  // the bundled-toolchain-dir flag entirely. Operators running the
  // documented `synapse-device install-bundles --require-prestaged`
  // form silently got non-strict-prestaged mode AND a misplaced
  // toolchain dir.
  const out = parseArgs([
    "install-bundles",
    "--require-prestaged",
    "--bundled-toolchain-dir",
    "/tmp/x",
  ])
  assert.equal(
    out.flags.get("require-prestaged"),
    "true",
    "bare boolean flag must default to 'true'"
  )
  assert.equal(
    out.flags.get("bundled-toolchain-dir"),
    "/tmp/x",
    "next --flag must be preserved as a separate flag, not swallowed as the bool's value"
  )
})

test("parseArgs: bare boolean flag followed by another --flag (=value form) does not swallow", () => {
  const out = parseArgs([
    "install-bundles",
    "--require-prestaged",
    "--platform=linux-x64",
  ])
  assert.equal(out.flags.get("require-prestaged"), "true")
  assert.equal(out.flags.get("platform"), "linux-x64")
})

test("parseArgs: multiple bare boolean flags in sequence", () => {
  const out = parseArgs([
    "install-bundles",
    "--strict",
    "--force",
    "--require-prestaged",
  ])
  assert.equal(out.flags.get("strict"), "true")
  assert.equal(out.flags.get("force"), "true")
  assert.equal(out.flags.get("require-prestaged"), "true")
})

test("parseArgs: mixed bool flags + valued flags", () => {
  const out = parseArgs([
    "install-bundles",
    "--platform=linux-x64",
    "--strict",
    "--bundled-toolchain-dir",
    "/tmp/x",
    "--force",
  ])
  assert.equal(out.flags.get("platform"), "linux-x64")
  assert.equal(out.flags.get("strict"), "true")
  assert.equal(out.flags.get("bundled-toolchain-dir"), "/tmp/x")
  assert.equal(out.flags.get("force"), "true")
})

test("parseArgs: cmd defaults to 'run' when omitted", () => {
  const out = parseArgs([])
  assert.equal(out.cmd, "run")
  assert.equal(out.flags.size, 0)
})
