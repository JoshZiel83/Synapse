import test from "node:test"
import assert from "node:assert/strict"
import {
  normalizePendingConflicts,
  mergePendingConflicts,
} from "./pending-conflicts.js"

/**
 * normalizePendingConflicts coerces the session's stashed pending-commit-conflict
 * blob into the current {paths, sidecars} shape (a malformed/absent blob → {}).
 */

test("normalizePendingConflicts: current shape passes through (kind defaulted)", () => {
  const cur = {
    conversation: {
      paths: ["/a.txt", "/b.txt"],
      sidecars: [
        {
          original: "/conversation/a.txt",
          sidecar: "/conversation/.synapse-conflicts/a.txt",
          kind: "file",
        },
      ],
    },
  }
  const out = normalizePendingConflicts(cur)
  assert.deepEqual(out, cur)
})

test("normalizePendingConflicts: a bare-array (non-record) subpath value is dropped", () => {
  // No back-compat with the pre-round-7 string[] shape (removed): a non-record
  // value is not the current {paths, sidecars} shape, so it is skipped.
  const out = normalizePendingConflicts({
    conversation: ["/a.txt"],
    actor: { paths: ["/c.txt"], sidecars: [] },
  })
  assert.deepEqual(out, { actor: { paths: ["/c.txt"], sidecars: [] } })
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
    b: { sidecars: [{ original: "/b/y", sidecar: "/b/.synapse-conflicts/y" }] }, // missing paths + sidecar kind
    c: {}, // both missing
    d: { paths: "not-an-array", sidecars: "nope" }, // wrong types
  }
  const out = normalizePendingConflicts(mixed)
  assert.deepEqual(out, {
    a: { paths: ["/x"], sidecars: [] },
    b: {
      paths: [],
      // a pre-round-10 sidecar (no kind) defaults to "file" (it was always
      // a readable file before symlink sidecars existed).
      sidecars: [
        {
          original: "/b/y",
          sidecar: "/b/.synapse-conflicts/y",
          kind: "file",
        },
      ],
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

test("mergePendingConflicts: same-original distinct sidecars BOTH survive (round-10 #2)", () => {
  // Round-10 #2: two unconsumed conflicts on the SAME original have DISTINCT
  // sidecar leaves (content discriminator); both recovery copies must persist.
  // Dedup is by SIDECAR path, so a re-record of the SAME sidecar is idempotent
  // but a new distinct sidecar for the same original is kept.
  const prev = {
    conversation: {
      paths: ["/a.txt"],
      sidecars: [
        {
          original: "/conversation/a.txt",
          sidecar: "/conversation/.synapse-conflicts/hash1",
          kind: "file",
        },
      ],
    },
  }
  const out = mergePendingConflicts(prev, {
    conversation: {
      paths: ["/a.txt"],
      sidecars: [
        // SAME sidecar leaf → idempotent (deduped).
        {
          original: "/conversation/a.txt",
          sidecar: "/conversation/.synapse-conflicts/hash1",
          kind: "file",
        },
        // SAME original, DIFFERENT content → distinct leaf → must be KEPT.
        {
          original: "/conversation/a.txt",
          sidecar: "/conversation/.synapse-conflicts/hash2",
          kind: "file",
        },
      ],
    },
  })
  assert.equal(
    out.conversation.sidecars.length,
    2,
    "two distinct sidecar leaves for the same original both survive"
  )
  const leaves = out.conversation.sidecars.map((s) => s.sidecar).sort()
  assert.deepEqual(leaves, [
    "/conversation/.synapse-conflicts/hash1",
    "/conversation/.synapse-conflicts/hash2",
  ])
})

test("mergePendingConflicts: empty prev returns the incoming verbatim", () => {
  const incoming = {
    actor: {
      paths: ["/x"],
      sidecars: [
        {
          original: "/actor/x",
          sidecar: "/actor/.synapse-conflicts/x",
          kind: "file",
        },
      ],
    },
  }
  assert.deepEqual(mergePendingConflicts({}, incoming), incoming)
})
