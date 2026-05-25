import test from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_FEISHU_EMOJI_TYPES,
  DEFAULT_STATUS_EMOJIS,
  DEFAULT_TOOL_PATTERNS,
  isStallStatus,
  isTerminalStatus,
  pickDominantToolStatus,
  resolveToolStatusLevel,
} from "./status-emojis.js"

test("default emoji table covers every status level", () => {
  const levels = [
    "queued",
    "thinking",
    "tool",
    "coding",
    "web",
    "done",
    "error",
    "stall",
    "stall_hard",
  ] as const
  for (const lvl of levels) {
    assert.ok(DEFAULT_STATUS_EMOJIS[lvl], `missing emoji for ${lvl}`)
    assert.ok(
      DEFAULT_FEISHU_EMOJI_TYPES[lvl],
      `missing Feishu emoji_type for ${lvl}`
    )
  }
})

test("resolveToolStatusLevel maps coding tools to coding", () => {
  assert.equal(resolveToolStatusLevel("edit_file"), "coding")
  assert.equal(resolveToolStatusLevel("bash"), "coding")
  assert.equal(resolveToolStatusLevel("Apply_Patch"), "coding")
  assert.equal(resolveToolStatusLevel("write"), "coding")
})

test("resolveToolStatusLevel maps web tools to web", () => {
  assert.equal(resolveToolStatusLevel("web_search"), "web")
  assert.equal(resolveToolStatusLevel("WebFetch"), "web")
  assert.equal(resolveToolStatusLevel("browser_navigate"), "web")
})

test("resolveToolStatusLevel maps generic tool names to tool", () => {
  assert.equal(resolveToolStatusLevel("mcp_invoke"), "tool")
  assert.equal(resolveToolStatusLevel("call_device_capability"), "tool")
  assert.equal(resolveToolStatusLevel("totally_unknown"), "tool")
  assert.equal(resolveToolStatusLevel(""), "tool")
})

test("resolveToolStatusLevel respects pattern priority (web > coding > tool)", () => {
  // "web_search" matches both "web" and "search" — web pattern is first
  assert.equal(resolveToolStatusLevel("web_search"), "web")
  // A custom name containing both "edit" and "fetch" — web wins because it's earlier
  // (the test guards against an accidental reordering)
  assert.equal(resolveToolStatusLevel("fetch_and_edit"), "web")
})

test("pickDominantToolStatus prefers coding > web > tool", () => {
  assert.equal(pickDominantToolStatus(["edit", "web_search"]), "coding")
  assert.equal(pickDominantToolStatus(["web_search", "mcp_x"]), "web")
  assert.equal(pickDominantToolStatus(["mcp_a", "mcp_b"]), "tool")
  assert.equal(pickDominantToolStatus([]), "tool")
})

test("isTerminalStatus and isStallStatus classify correctly", () => {
  assert.equal(isTerminalStatus("done"), true)
  assert.equal(isTerminalStatus("error"), true)
  assert.equal(isTerminalStatus("thinking"), false)
  assert.equal(isStallStatus("stall"), true)
  assert.equal(isStallStatus("stall_hard"), true)
  assert.equal(isStallStatus("thinking"), false)
})

test("DEFAULT_TOOL_PATTERNS is ordered web → coding → tool", () => {
  assert.equal(DEFAULT_TOOL_PATTERNS[0].level, "web")
  assert.equal(DEFAULT_TOOL_PATTERNS[1].level, "coding")
  assert.equal(DEFAULT_TOOL_PATTERNS[2].level, "tool")
})

test("custom patterns can override default mapping", () => {
  const custom = [{ level: "coding" as const, needles: ["foo"] }]
  assert.equal(resolveToolStatusLevel("foo_bar", custom), "coding")
  assert.equal(resolveToolStatusLevel("web_search", custom), "tool")
})

test("resolveToolStatusLevel handles case-mixed needles", () => {
  assert.equal(resolveToolStatusLevel("BASH"), "coding")
  assert.equal(resolveToolStatusLevel("WeB_SeArCh"), "web")
})
