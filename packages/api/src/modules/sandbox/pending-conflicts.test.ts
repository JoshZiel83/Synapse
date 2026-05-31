import test from "node:test"
import assert from "node:assert/strict"
import { normalizePendingConflicts, mergePendingConflicts } from "./service.js"

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

/**
 * mergePendingConflicts is the at-least-once-safe union used when a NEW turn-end
 * commit conflict arrives while a prior turn's notice is still undelivered (its
 * actorThink threw before clearing). It must union, never clobber (round-7 #4).
 */

test("mergePendingConflicts: new subpath is added alongside existing", () => {
  const prev = {
    conversation: { paths: ["/a.txt"], sidecars: [] },
  }
  const out = mergePendingConflicts(prev, {
    actor: { paths: ["/b.txt"], sidecars: [] },
  })
  assert.deepEqual(out, {
    conversation: { paths: ["/a.txt"], sidecars: [] },
    actor: { paths: ["/b.txt"], sidecars: [] },
  })
})

test("mergePendingConflicts: same subpath unions + dedups paths (no clobber)", () => {
  const prev = {
    conversation: { paths: ["/a.txt", "/b.txt"], sidecars: [] },
  }
  const out = mergePendingConflicts(prev, {
    conversation: { paths: ["/b.txt", "/c.txt"], sidecars: [] },
  })
  assert.deepEqual(out.conversation.paths.sort(), [
    "/a.txt",
    "/b.txt",
    "/c.txt",
  ])
})

test("mergePendingConflicts: sidecars dedup by original (latest wins)", () => {
  const prev = {
    conversation: {
      paths: ["/a.txt"],
      sidecars: [
        {
          original: "/conversation/a.txt",
          sidecar: "/conversation/.synapse-conflicts/a.txt",
        },
      ],
    },
  }
  const out = mergePendingConflicts(prev, {
    conversation: {
      paths: ["/a.txt"],
      sidecars: [
        // same original, (hypothetically) different sidecar → latest kept, no dup
        {
          original: "/conversation/a.txt",
          sidecar: "/conversation/.synapse-conflicts/a.txt",
        },
        {
          original: "/conversation/d.txt",
          sidecar: "/conversation/.synapse-conflicts/d.txt",
        },
      ],
    },
  })
  assert.equal(out.conversation.sidecars.length, 2, "deduped by original")
  const originals = out.conversation.sidecars.map((s) => s.original).sort()
  assert.deepEqual(originals, ["/conversation/a.txt", "/conversation/d.txt"])
})

test("mergePendingConflicts: empty prev returns the incoming verbatim", () => {
  const incoming = {
    actor: {
      paths: ["/x"],
      sidecars: [
        { original: "/actor/x", sidecar: "/actor/.synapse-conflicts/x" },
      ],
    },
  }
  assert.deepEqual(mergePendingConflicts({}, incoming), incoming)
})
