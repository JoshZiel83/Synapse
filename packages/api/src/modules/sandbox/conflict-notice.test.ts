import test from "node:test"
import assert from "node:assert/strict"
import {
  partitionSidecars,
  formatRestoredPair,
  formatUnrestoredPair,
  transientUnrestoredSentence,
  permanentUnrestoredSentence,
} from "./conflict-notice.js"
import type { ConflictSidecarRef } from "./service.js"
import type { SidecarRestoreFailureReason } from "./model.js"

/**
 * P2/P3: when a pending conflict sidecar fails to re-materialize on the current
 * provision (the on-disk leaf is absent), the agent notice must NOT instruct
 * "read it" against that path — and must word a TRANSIENT failure (retry later)
 * differently from a PERMANENT one (corrupt/missing payload, unrecoverable).
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
const corruptRef: ConflictSidecarRef = {
  original: "/actor/legacy.txt",
  sidecar: "/actor/.synapse-conflicts/h3",
  kind: "file",
  // no contentSha — a pre-round-11 / corrupt record
}

function reasons(
  entries: [string, SidecarRestoreFailureReason][]
): Map<string, SidecarRestoreFailureReason> {
  return new Map(entries)
}

test("partitionSidecars: routes by per-sidecar reason (restored / transient / permanent)", () => {
  const { restored, transient, permanent } = partitionSidecars(
    [fileRef, symlinkRef, corruptRef],
    reasons([
      [symlinkRef.sidecar, "transient"],
      [corruptRef.sidecar, "permanent"],
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
    [corruptRef.sidecar],
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

test("transientUnrestoredSentence: lists paths, forbids reading, PROMISES a later restore", () => {
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
    /later turn will restore/i.test(sentence),
    "promises a later-turn restore for a transient failure"
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
  const sentence = permanentUnrestoredSentence([corruptRef])
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
