import test from "node:test"
import assert from "node:assert/strict"
import {
  partitionSidecars,
  formatRestoredPair,
  formatUnrestoredPair,
  transientUnrestoredSentence,
  permanentUnrestoredSentence,
} from "./conflict-notice.js"
import type { ConflictSidecarRef } from "./pending-conflicts.js"
import type { SidecarRestoreFailureReason } from "./model.js"

/**
 * P2/P3: when a pending conflict sidecar fails to re-materialize on the current
 * provision (the on-disk leaf is absent), the agent notice must NOT instruct
 * "read it" against that path — and must word a TRANSIENT failure (retry later)
 * differently from a PERMANENT one (unroutable sidecar path, unrecoverable).
 * These cover the pure partition + formatting the worker uses to build that
 * notice.
 */

const fileRef: ConflictSidecarRef = {
  original: "/actor/x.txt",
  sidecar: "/actor/.synapse-conflicts/h1",
  kind: "file",
  contentSha: "abc",
}
const symlinkRef: ConflictSidecarRef = {
  original: "/actor/link",
  sidecar: "/actor/.synapse-conflicts/h2",
  kind: "symlink",
  target: "../elsewhere",
}
const unroutableRef: ConflictSidecarRef = {
  original: "/actor/legacy.txt",
  sidecar: "actor/.synapse-conflicts/h3", // no leading slash → unroutable path
  kind: "file",
  contentSha: "abc",
}

function reasons(
  entries: [string, SidecarRestoreFailureReason][]
): Map<string, SidecarRestoreFailureReason> {
  return new Map(entries)
}

test("partitionSidecars: routes by per-sidecar reason (restored / transient / permanent)", () => {
  const { restored, transient, permanent } = partitionSidecars(
    [fileRef, symlinkRef, unroutableRef],
    reasons([
      [symlinkRef.sidecar, "transient"],
      [unroutableRef.sidecar, "permanent"],
    ])
  )
  assert.deepEqual(
    restored.map((s) => s.sidecar),
    [fileRef.sidecar],
    "a sidecar absent from the failed map is restored"
  )
  assert.deepEqual(
    transient.map((s) => s.sidecar),
    [symlinkRef.sidecar],
    "a transient failure is bucketed transient"
  )
  assert.deepEqual(
    permanent.map((s) => s.sidecar),
    [unroutableRef.sidecar],
    "a permanent failure is bucketed permanent"
  )
})

test("partitionSidecars: empty failed-map → everything restored", () => {
  const { restored, transient, permanent } = partitionSidecars(
    [fileRef, symlinkRef],
    reasons([])
  )
  assert.equal(restored.length, 2)
  assert.equal(transient.length, 0)
  assert.equal(permanent.length, 0)
})

test("partitionSidecars: restoreStatusUnknown buckets well-formed refs transient but keeps unroutable refs permanent (P3 truthfulness)", () => {
  // Unknown restore status must NOT present any well-formed sidecar as readable
  // (→ transient, retryable). But a ref whose own path is UNROUTABLE (can never
  // be written) must STILL be permanent — never over-promised as "will be
  // retried". (A missing payload is no longer a cause: the strict union means a
  // payload-less ref cannot decode into the pending store in the first place.)
  const { restored, transient, permanent } = partitionSidecars(
    [fileRef, symlinkRef, unroutableRef],
    reasons([]),
    true
  )
  assert.equal(restored.length, 0, "nothing is presented as restored")
  assert.deepEqual(
    transient.map((s) => s.sidecar).sort(),
    [fileRef.sidecar, symlinkRef.sidecar].sort(),
    "well-formed refs are transient (retryable, no 'read it')"
  )
  assert.deepEqual(
    permanent.map((s) => s.sidecar).sort(),
    [unroutableRef.sidecar].sort(),
    "an unroutable-path ref stays permanent even when status is unknown"
  )
})

test("formatRestoredPair: file uses arrow, symlink annotates JSON", () => {
  assert.equal(
    formatRestoredPair(fileRef),
    "/actor/x.txt → /actor/.synapse-conflicts/h1"
  )
  assert.equal(
    formatRestoredPair(symlinkRef),
    "/actor/link → /actor/.synapse-conflicts/h2 (symlink target, read as JSON)"
  )
})

test("formatUnrestoredPair: names the preserved path WITHOUT a read instruction", () => {
  const s = formatUnrestoredPair(fileRef)
  assert.equal(
    s,
    "/actor/x.txt (preserved copy at /actor/.synapse-conflicts/h1)"
  )
  assert.ok(!/read/i.test(s), "must not tell the agent to read it")
  assert.ok(!s.includes("→"), "unrestored pair must not use the restored arrow")
})

test("transientUnrestoredSentence: empty list → empty string (safe to concat)", () => {
  assert.equal(transientUnrestoredSentence([]), "")
})

test("transientUnrestoredSentence: lists paths, forbids reading, promises a RETRY (not a guaranteed restore)", () => {
  const sentence = transientUnrestoredSentence([fileRef, symlinkRef])
  assert.ok(
    sentence.includes("could NOT be") && sentence.includes("re-materialized"),
    "explains the copy is preserved but not on disk"
  )
  assert.ok(
    /do NOT try to read/i.test(sentence),
    "explicitly tells the agent NOT to read the missing sidecar path"
  )
  assert.ok(
    /will be retried on a later turn/i.test(sentence),
    "promises a retry next turn for a transient failure"
  )
  assert.ok(
    !/later turn will restore it|will be restored/i.test(sentence),
    "must NOT over-promise a guaranteed restore (transient = retry, not certain)"
  )
  assert.ok(
    sentence.includes("/actor/x.txt") && sentence.includes("/actor/link"),
    "names every transiently-unrestored original path"
  )
})

test("permanentUnrestoredSentence: empty list → empty string", () => {
  assert.equal(permanentUnrestoredSentence([]), "")
})

test("permanentUnrestoredSentence: flags UNRECOVERABLE, makes NO retry promise, tells agent to redo", () => {
  const sentence = permanentUnrestoredSentence([unroutableRef])
  assert.ok(/UNRECOVERABLE/i.test(sentence), "marks the copy as unrecoverable")
  assert.ok(
    !/later turn will restore|will be restored/i.test(sentence),
    "must NOT promise a later-turn restore for a permanent failure"
  )
  assert.ok(
    /do NOT try to read/i.test(sentence),
    "still tells the agent not to read the missing path"
  )
  assert.ok(
    /redo|lost/i.test(sentence),
    "tells the agent to treat the work as lost / redo it"
  )
  assert.ok(
    sentence.includes("/actor/legacy.txt"),
    "names the permanently-unrestored original path"
  )
})
