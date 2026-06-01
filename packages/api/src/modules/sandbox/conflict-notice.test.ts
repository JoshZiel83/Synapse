import test from "node:test"
import assert from "node:assert/strict"
import {
  partitionSidecars,
  formatRestoredPair,
  formatUnrestoredPair,
  unrestoredSidecarSentence,
} from "./conflict-notice.js"
import type { ConflictSidecarRef } from "./service.js"

/**
 * P2: when a pending conflict sidecar fails to re-materialize on the current
 * provision (the on-disk leaf is absent though the bytes are CAS-safe), the
 * agent notice must NOT instruct "read it" against that path. These cover the
 * pure partition + formatting the worker uses to build that notice.
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

test("partitionSidecars: routes by failed-sidecar membership", () => {
  const { restored, unrestored } = partitionSidecars(
    [fileRef, symlinkRef],
    new Set([symlinkRef.sidecar])
  )
  assert.deepEqual(
    restored.map((s) => s.sidecar),
    [fileRef.sidecar],
    "the restorable file sidecar is 'restored'"
  )
  assert.deepEqual(
    unrestored.map((s) => s.sidecar),
    [symlinkRef.sidecar],
    "the failed symlink sidecar is 'unrestored'"
  )
})

test("partitionSidecars: empty failed-set → everything restored", () => {
  const { restored, unrestored } = partitionSidecars(
    [fileRef, symlinkRef],
    new Set()
  )
  assert.equal(restored.length, 2)
  assert.equal(unrestored.length, 0)
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
  // The unrestored phrasing intentionally avoids the arrow that the restored
  // 'read it' phrasing uses, so the two are visually distinct in the notice.
  assert.ok(!s.includes("→"), "unrestored pair must not use the restored arrow")
})

test("unrestoredSidecarSentence: empty list → empty string (safe to concat)", () => {
  assert.equal(unrestoredSidecarSentence([]), "")
})

test("unrestoredSidecarSentence: lists paths and forbids reading the leaf", () => {
  const sentence = unrestoredSidecarSentence([fileRef, symlinkRef])
  assert.ok(
    sentence.includes("could NOT be") && sentence.includes("re-materialized"),
    "explains the copy is preserved but not on disk"
  )
  assert.ok(
    /do NOT try to read/i.test(sentence),
    "explicitly tells the agent NOT to read the missing sidecar path"
  )
  assert.ok(
    sentence.includes("/actor/x.txt") && sentence.includes("/actor/link"),
    "names every unrestored original path"
  )
})
