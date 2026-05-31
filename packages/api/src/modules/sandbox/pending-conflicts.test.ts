import test from "node:test"
import assert from "node:assert/strict"
import { normalizePendingConflicts } from "./service.js"

/**
 * normalizePendingConflicts coerces the session's stashed pending-commit-conflict
 * blob into the current {paths, sidecars} shape. The critical case is BACKWARD
 * COMPATIBILITY: a notice stashed by a pre-round-7 build (subpath → string[])
 * must still surface after upgrade (round-7 #C changed the storage shape).
 */

test("normalizePendingConflicts: current shape passes through", () => {
  const cur = {
    conversation: {
      paths: ["/a.txt", "/b.txt"],
      sidecars: [
        {
          original: "/conversation/a.txt",
          sidecar: "/conversation/.synapse-conflicts/a.txt",
        },
      ],
    },
  }
  const out = normalizePendingConflicts(cur)
  assert.deepEqual(out, cur)
})

test("normalizePendingConflicts: legacy string[] format is upgraded (no sidecars)", () => {
  // Pre-round-7: subpath → bare path array.
  const legacy = { conversation: ["/a.txt", "/b.txt"], actor: ["/c.txt"] }
  const out = normalizePendingConflicts(legacy)
  assert.deepEqual(out, {
    conversation: { paths: ["/a.txt", "/b.txt"], sidecars: [] },
    actor: { paths: ["/c.txt"], sidecars: [] },
  })
})

test("normalizePendingConflicts: null/garbage → empty object", () => {
  assert.deepEqual(normalizePendingConflicts(undefined), {})
  assert.deepEqual(normalizePendingConflicts(null), {})
  assert.deepEqual(normalizePendingConflicts("nope"), {})
  assert.deepEqual(normalizePendingConflicts(42), {})
})

test("normalizePendingConflicts: partial/malformed entries are defaulted", () => {
  const mixed = {
    a: { paths: ["/x"] }, // missing sidecars
    b: { sidecars: [{ original: "/b/y", sidecar: "/b/.synapse-conflicts/y" }] }, // missing paths
    c: {}, // both missing
    d: { paths: "not-an-array", sidecars: "nope" }, // wrong types
  }
  const out = normalizePendingConflicts(mixed)
  assert.deepEqual(out, {
    a: { paths: ["/x"], sidecars: [] },
    b: {
      paths: [],
      sidecars: [{ original: "/b/y", sidecar: "/b/.synapse-conflicts/y" }],
    },
    c: { paths: [], sidecars: [] },
    d: { paths: [], sidecars: [] },
  })
})
