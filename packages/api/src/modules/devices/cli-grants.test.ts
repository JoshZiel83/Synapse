import test from "node:test"
import assert from "node:assert/strict"
import { computeCliGrantReconcilePlan } from "./cli-grants.js"

test("reconcile plan mints available-not-granted, skips already-granted (idempotent)", () => {
  const plan = computeCliGrantReconcilePlan({
    availableEntryPoints: ["cli-anything-audacity", "cli-anything-gimp"],
    managedEntryPoints: [
      "cli-anything-audacity",
      "cli-anything-gimp",
      "cli-anything-blender",
    ],
    existingGrants: [{ id: "g1", program: "cli-anything-audacity" }],
  })
  assert.deepEqual(plan.toMint, ["cli-anything-gimp"]) // audacity already granted
  assert.deepEqual(plan.toRevoke, [])
})

test("reconcile plan revokes a managed grant that flipped to unavailable", () => {
  const plan = computeCliGrantReconcilePlan({
    availableEntryPoints: ["cli-anything-audacity"],
    managedEntryPoints: ["cli-anything-audacity", "cli-anything-gimp"],
    existingGrants: [
      { id: "g1", program: "cli-anything-audacity" },
      { id: "g2", program: "cli-anything-gimp" }, // no longer available
    ],
  })
  assert.deepEqual(plan.toMint, [])
  assert.deepEqual(plan.toRevoke, [{ id: "g2", program: "cli-anything-gimp" }])
})

test("reconcile plan NEVER revokes a grant outside the managed set (operator manual grant is safe)", () => {
  const plan = computeCliGrantReconcilePlan({
    availableEntryPoints: [],
    managedEntryPoints: ["cli-anything-audacity"], // only audacity is ours
    existingGrants: [{ id: "gm", program: "some-operator-tool" }], // not a catalog CLI
  })
  assert.deepEqual(plan.toRevoke, [])
  assert.deepEqual(plan.toMint, [])
})

test("reconcile plan: second identical run is a no-op", () => {
  const plan = computeCliGrantReconcilePlan({
    availableEntryPoints: ["cli-anything-audacity"],
    managedEntryPoints: ["cli-anything-audacity"],
    existingGrants: [{ id: "g1", program: "cli-anything-audacity" }],
  })
  assert.deepEqual(plan.toMint, [])
  assert.deepEqual(plan.toRevoke, [])
})
