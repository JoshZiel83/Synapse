// Phase 4 gate: system/callable tools get their co-located presentation
// descriptor auto-attached at registration, retrievable via getToolPlugin.

import test from "node:test"
import assert from "node:assert/strict"
import { registerCallableToolPlugins } from "./session-tools.js"
import { registerActorFileToolPlugins } from "./file-tools.js"
import { registerActorStateCallableToolPlugins } from "./tools.js"
import { getToolPlugin } from "./tool-plugins.js"
import { SYSTEM_TOOL_PRESENTATION } from "./system-tools.presentation.js"

// Registration is idempotent-guarded (throws on duplicate), so register once.
let registered = false
function ensureRegistered() {
  if (registered) return
  registerActorStateCallableToolPlugins()
  registerCallableToolPlugins()
  registerActorFileToolPlugins()
  registered = true
}

test("getToolPlugin returns the auto-attached presentation for a system tool", () => {
  ensureRegistered()
  const memory = getToolPlugin("memory_search")
  assert.ok(memory, "memory_search should be registered")
  assert.ok(memory!.presentation, "memory_search should carry a presentation")
  assert.equal(memory!.presentation!.title.message, "搜索记忆 {query}")
  assert.equal(memory!.presentation!.title.args?.query?.path, "queryText")
})

test("file tools get a presentation too (upload_file)", () => {
  ensureRegistered()
  const upload = getToolPlugin("upload_file")
  assert.ok(upload?.presentation)
  assert.equal(upload!.presentation!.title.args?.file?.path, "filename")
})

test("every SYSTEM_TOOL_PRESENTATION key maps to a registered plugin", () => {
  ensureRegistered()
  for (const name of Object.keys(SYSTEM_TOOL_PRESENTATION)) {
    assert.ok(
      getToolPlugin(name),
      `presentation declared for "${name}" but no plugin registered under that name`
    )
  }
})

test("unknown tool name → undefined (resolver falls back to generic)", () => {
  ensureRegistered()
  assert.equal(getToolPlugin("definitely_not_a_tool"), undefined)
})
