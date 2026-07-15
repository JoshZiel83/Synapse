import test from "node:test"
import assert from "node:assert/strict"
import {
  decodePendingConflicts,
  mergePendingConflicts,
  toConflictSidecarRef,
} from "./pending-conflicts.js"
import type { PendingCommitConflict } from "./pending-conflicts.js"
import type { ConflictSidecar } from "@synapse/device-runtime"

/**
 * decodePendingConflicts is a STRICT Zod decode of the stashed pending-commit-conflict
 * blob (subpath -> {paths, sidecars}). There is NO per-field old-data coercion: a blob
 * that does not match the current shape fails SAFE to {} at the top level.
 */

test("decodePendingConflicts: a well-formed blob (file + symlink sidecars) passes through", () => {
  const cur = {
    conversation: {
      paths: ["/a.txt", "/b.txt"],
      sidecars: [
        {
          original: "/conversation/a.txt",
          sidecar: "/conversation/.synapse-conflicts/a.txt",
          kind: "file",
          contentSha: "a".repeat(64),
        },
        {
          original: "/conversation/link",
          sidecar: "/conversation/.synapse-conflicts/link",
          kind: "symlink",
          target: "/etc/hosts",
        },
      ],
    },
  }
  assert.deepEqual(decodePendingConflicts(cur), cur)
})

test("decodePendingConflicts: null/garbage → empty object", () => {
  assert.deepEqual(decodePendingConflicts(undefined), {})
  assert.deepEqual(decodePendingConflicts(null), {})
  assert.deepEqual(decodePendingConflicts("nope"), {})
  assert.deepEqual(decodePendingConflicts(42), {})
})

test("decodePendingConflicts: a malformed blob fails SAFE to {} — no per-field coercion (strict, no old-data defaults)", () => {
  // A required field missing (kind), a wrong-typed field, and a non-record subpath value
  // each make the WHOLE blob fail the strict decode → {} (never a silently-defaulted
  // partial). This is the intended fail-closed: we own the write shape, so a
  // non-conforming blob is corruption, not old data to be patched up.
  assert.deepEqual(
    decodePendingConflicts({
      b: { paths: [], sidecars: [{ original: "/b/y", sidecar: "/b/z" }] }, // sidecar missing required kind
    }),
    {}
  )
  assert.deepEqual(
    decodePendingConflicts({ a: { paths: "not-an-array", sidecars: [] } }),
    {}
  )
  assert.deepEqual(decodePendingConflicts({ conversation: ["/a.txt"] }), {})
})

test("decodePendingConflicts: the per-variant payload is REQUIRED (strict union) — a payload-less or unknown-kind ref fails the whole blob", () => {
  const base = { original: "/c/a", sidecar: "/c/.synapse-conflicts/a" }
  // file with no contentSha → rejected (payload required, not defaulted).
  assert.deepEqual(
    decodePendingConflicts({
      c: { paths: [], sidecars: [{ ...base, kind: "file" }] },
    }),
    {}
  )
  // symlink with no target → rejected.
  assert.deepEqual(
    decodePendingConflicts({
      c: { paths: [], sidecars: [{ ...base, kind: "symlink" }] },
    }),
    {}
  )
  // unknown kind → the discriminated union has no matching member → rejected.
  assert.deepEqual(
    decodePendingConflicts({
      c: {
        paths: [],
        sidecars: [{ ...base, kind: "dir", contentSha: "x" }],
      },
    }),
    {}
  )
  // an unknown EXTRA key → strictObject rejects (no silent strip).
  assert.deepEqual(
    decodePendingConflicts({
      c: {
        paths: [],
        sidecars: [{ ...base, kind: "file", contentSha: "x", extra: 1 }],
      },
    }),
    {}
  )
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
  const prev: Record<string, PendingCommitConflict> = {
    conversation: {
      paths: ["/a.txt"],
      sidecars: [
        {
          original: "/conversation/a.txt",
          sidecar: "/conversation/.synapse-conflicts/hash1",
          kind: "file",
          contentSha: "sha1",
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
          contentSha: "sha1",
        },
        // SAME original, DIFFERENT content → distinct leaf → must be KEPT.
        {
          original: "/conversation/a.txt",
          sidecar: "/conversation/.synapse-conflicts/hash2",
          kind: "file",
          contentSha: "sha2",
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
  const incoming: Record<string, PendingCommitConflict> = {
    actor: {
      paths: ["/x"],
      sidecars: [
        {
          original: "/actor/x",
          sidecar: "/actor/.synapse-conflicts/x",
          kind: "file",
          contentSha: "shax",
        },
      ],
    },
  }
  assert.deepEqual(mergePendingConflicts({}, incoming), incoming)
})

/**
 * toConflictSidecarRef validates + prefixes the wire ConflictSidecar (flat,
 * optional payload) into the durable ref (strict union, required payload). It
 * THROWS on a payload the fs-helper is proven to always supply, so a Rust
 * regression fails LOUD instead of persisting an unrecoverable ref.
 */
test("toConflictSidecarRef: maps a file sidecar + prefixes the mount subpath", () => {
  const wire: ConflictSidecar = {
    original: "/a.txt",
    sidecar: "/.synapse-conflicts/h1",
    kind: "file",
    content_sha: "a".repeat(64),
  }
  assert.deepEqual(toConflictSidecarRef(wire, "actor"), {
    kind: "file",
    original: "/actor/a.txt",
    sidecar: "/actor/.synapse-conflicts/h1",
    contentSha: "a".repeat(64),
  })
})

test("toConflictSidecarRef: maps a symlink sidecar (target payload)", () => {
  const wire: ConflictSidecar = {
    original: "/link",
    sidecar: "/.synapse-conflicts/h2",
    kind: "symlink",
    target: "../elsewhere",
  }
  assert.deepEqual(toConflictSidecarRef(wire, "conversation"), {
    kind: "symlink",
    original: "/conversation/link",
    sidecar: "/conversation/.synapse-conflicts/h2",
    target: "../elsewhere",
  })
})

test("toConflictSidecarRef: THROWS on a missing payload or unknown kind (fail-loud invariant)", () => {
  assert.throws(
    () =>
      toConflictSidecarRef(
        { original: "/a", sidecar: "/.synapse-conflicts/a", kind: "file" },
        "actor"
      ),
    /file.*no content_sha/
  )
  assert.throws(
    () =>
      toConflictSidecarRef(
        { original: "/l", sidecar: "/.synapse-conflicts/l", kind: "symlink" },
        "actor"
      ),
    /symlink.*no target/
  )
  assert.throws(
    () =>
      toConflictSidecarRef(
        {
          original: "/d",
          sidecar: "/.synapse-conflicts/d",
          kind: "dir",
        } as unknown as ConflictSidecar,
        "actor"
      ),
    /unrecognized kind/
  )
})
