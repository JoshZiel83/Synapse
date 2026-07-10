import assert from "node:assert/strict"
import test from "node:test"
import { stableKeyFromSnapshot } from "./resolver.js"

test("stableKeyFromSnapshot reads object snapshots and JSON string snapshots", () => {
  assert.equal(
    stableKeyFromSnapshot("runtime", {
      exposureStableKey: "synapse.builtin.filesystem.v1",
      visibleToolName: "read_file",
    }),
    "synapse.builtin.filesystem.v1/read_file"
  )

  assert.equal(
    stableKeyFromSnapshot(
      "plugin",
      JSON.stringify({
        publisherSlug: "acme",
        itemSlug: "search",
        upstreamToolName: "lookup",
      })
    ),
    "plugin/acme/search/lookup"
  )
})

test("stableKeyFromSnapshot ignores non-object snapshots", () => {
  assert.equal(
    stableKeyFromSnapshot("system", JSON.stringify(["bad"])),
    undefined
  )
  assert.equal(stableKeyFromSnapshot("runtime", "not json"), undefined)
  assert.equal(stableKeyFromSnapshot("plugin", 42), undefined)
})
