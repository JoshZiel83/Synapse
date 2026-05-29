import { test } from "node:test"
import assert from "node:assert/strict"

import {
  isPathInside,
  joinUnderRoot,
  ManifestPathEscapeError,
} from "./path-utils.js"

test("isPathInside: POSIX accepts children", () => {
  assert.equal(isPathInside("/opt/tc", "/opt/tc/bin/git", "linux"), true)
  assert.equal(isPathInside("/opt/tc", "bin/git", "linux"), true)
  assert.equal(isPathInside("/opt/tc", "/opt/tc", "linux"), true)
  assert.equal(isPathInside("/opt/tc", ".", "linux"), true)
})

test("isPathInside: POSIX rejects parent traversal", () => {
  assert.equal(isPathInside("/opt/tc", "../etc/passwd", "linux"), false)
  assert.equal(isPathInside("/opt/tc", "/etc/passwd", "linux"), false)
  assert.equal(isPathInside("/opt/tc", "/opt/tc/../passwd", "linux"), false)
})

test("isPathInside: Windows case-insensitive", () => {
  assert.equal(
    isPathInside("C:\\Toolchains", "c:\\toolchains\\node\\bin", "win32"),
    true
  )
  assert.equal(isPathInside("C:\\Toolchains", "C:\\Other\\bin", "win32"), false)
})

test("joinUnderRoot: throws ManifestPathEscapeError on escape", () => {
  assert.throws(
    () => joinUnderRoot("/opt/tc", "../etc/passwd", "linux"),
    (err) => err instanceof ManifestPathEscapeError
  )
})

test("joinUnderRoot: returns absolute path on valid input", () => {
  const out = joinUnderRoot("/opt/tc", "bin/node", "linux")
  assert.equal(out, "/opt/tc/bin/node")
})
