import test from "node:test"
import assert from "node:assert/strict"
import {
  canonicalVfsPath,
  CanonicalPathError,
  pathUnderPrefix,
  collapsePrefixes,
  INTERNAL_NAMESPACE,
} from "./vfs.js"

test("canonicalVfsPath basic normalization", () => {
  assert.equal(canonicalVfsPath(""), "/")
  assert.equal(canonicalVfsPath("/"), "/")
  assert.equal(canonicalVfsPath("foo"), "/foo")
  assert.equal(canonicalVfsPath("/foo"), "/foo")
  assert.equal(canonicalVfsPath("./foo"), "/foo")
  assert.equal(canonicalVfsPath("/foo/./bar"), "/foo/bar")
  assert.equal(canonicalVfsPath("/foo/../bar"), "/bar")
  assert.equal(canonicalVfsPath("/foo/bar/.."), "/foo")
  assert.equal(canonicalVfsPath("/.."), "/") // bounded at root
  assert.equal(canonicalVfsPath("/../../etc"), "/etc") // bounded
  assert.equal(canonicalVfsPath("/foo//bar"), "/foo/bar") // collapse //
})

test("canonicalVfsPath rejects raw trailing whitespace (load-bearing)", () => {
  // The trailing-space rule must run on the RAW input, BEFORE trim. Otherwise
  // `"secret.txt "` would be normalized to `"secret.txt"` and grant for
  // `/secret.txt` would silently authorize access to a file other than what
  // the caller named.
  assert.throws(
    () => canonicalVfsPath("/secret.txt "),
    (e: unknown) => e instanceof CanonicalPathError && e.code === "invalid_path"
  )
  assert.throws(
    () => canonicalVfsPath(" /secret.txt"),
    (e: unknown) => e instanceof CanonicalPathError
  )
  assert.throws(
    () => canonicalVfsPath("/secret.txt\t"),
    (e: unknown) => e instanceof CanonicalPathError
  )
})

test("canonicalVfsPath rejects Windows path constructs", () => {
  assert.throws(() => canonicalVfsPath("C:\\Users"), CanonicalPathError)
  assert.throws(() => canonicalVfsPath("c:/Users"), CanonicalPathError)
  assert.throws(() => canonicalVfsPath("D:foo"), CanonicalPathError)
  assert.throws(() => canonicalVfsPath("/foo\\bar"), CanonicalPathError)
  assert.throws(() => canonicalVfsPath("\\\\server\\share"), CanonicalPathError)
  assert.throws(() => canonicalVfsPath("\\\\?\\C:\\foo"), CanonicalPathError)
  assert.throws(() => canonicalVfsPath("/file.txt:ads"), CanonicalPathError)
  assert.throws(() => canonicalVfsPath("/foo:bar"), CanonicalPathError)
})

test("canonicalVfsPath rejects trailing dot/space per segment", () => {
  assert.throws(() => canonicalVfsPath("/secret."), CanonicalPathError)
  assert.throws(() => canonicalVfsPath("/secret /file"), CanonicalPathError)
  assert.throws(() => canonicalVfsPath("/a/b./c"), CanonicalPathError)
  // literal `.` and `..` are exempt (normalization markers).
  assert.equal(canonicalVfsPath("/a/./b"), "/a/b")
  assert.equal(canonicalVfsPath("/a/../b"), "/b")
})

test("canonicalVfsPath rejects DOS reserved names", () => {
  for (const name of [
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "LPT9",
    "con",
    "Com5",
  ]) {
    assert.throws(
      () => canonicalVfsPath(`/${name}`),
      CanonicalPathError,
      `${name} should be rejected`
    )
    assert.throws(
      () => canonicalVfsPath(`/${name}.txt`),
      CanonicalPathError,
      `${name}.txt should be rejected`
    )
  }
  // Names that contain reserved as substring but aren't reserved are OK.
  assert.equal(canonicalVfsPath("/console.log"), "/console.log")
  assert.equal(canonicalVfsPath("/aux-data"), "/aux-data")
})

test("canonicalVfsPath blocks reserved internal namespace (raw + canonical)", () => {
  assert.throws(() => canonicalVfsPath(INTERNAL_NAMESPACE), CanonicalPathError)
  assert.throws(
    () => canonicalVfsPath(`${INTERNAL_NAMESPACE}/`),
    CanonicalPathError
  )
  assert.throws(
    () => canonicalVfsPath(`${INTERNAL_NAMESPACE}/tmp/x`),
    CanonicalPathError
  )
  // Normalize-then-equal exact: `/.synapse-internal/.` → `/.synapse-internal`.
  assert.throws(
    () => canonicalVfsPath(`${INTERNAL_NAMESPACE}/.`),
    CanonicalPathError
  )
  // Normalize-then-equal exact: `/.synapse-internal/foo/..` → `/.synapse-internal`.
  assert.throws(
    () => canonicalVfsPath(`${INTERNAL_NAMESPACE}/foo/..`),
    CanonicalPathError
  )
})

test("pathUnderPrefix boundary-aware matching", () => {
  // Root special case
  assert.equal(pathUnderPrefix("/anything", "/"), true)
  assert.equal(pathUnderPrefix("/", "/"), true)
  // Exact equal
  assert.equal(pathUnderPrefix("/foo", "/foo"), true)
  // Child under
  assert.equal(pathUnderPrefix("/foo/bar", "/foo"), true)
  assert.equal(pathUnderPrefix("/foo/bar/baz", "/foo"), true)
  // Sibling — must NOT match (the load-bearing case)
  assert.equal(pathUnderPrefix("/foobar", "/foo"), false)
  assert.equal(pathUnderPrefix("/foo2", "/foo"), false)
  assert.equal(pathUnderPrefix("/foo-bar", "/foo"), false)
  // Unrelated
  assert.equal(pathUnderPrefix("/other", "/foo"), false)
})

test("collapsePrefixes drops redundant overlapping prefixes", () => {
  assert.deepEqual(collapsePrefixes(["/foo", "/foo/bar"]), ["/foo"])
  assert.deepEqual(collapsePrefixes(["/", "/foo", "/bar"]), ["/"])
  assert.deepEqual(collapsePrefixes(["/foo/bar", "/foo", "/baz"]), [
    "/baz",
    "/foo",
  ])
  assert.deepEqual(collapsePrefixes(["/foo", "/foobar"]), ["/foo", "/foobar"])
  assert.deepEqual(collapsePrefixes([]), [])
})
