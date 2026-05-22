import test from "node:test"
import assert from "node:assert/strict"
import {
  resolveActorActionStatus,
  resolveSessionThinkingStatus,
} from "./status-resolver.js"

test("actor.action with web tool resolves to web", () => {
  assert.equal(
    resolveActorActionStatus({
      actions: [{ tool: "web_search", args: {} }],
    }),
    "web"
  )
})

test("actor.action with coding tool resolves to coding", () => {
  assert.equal(
    resolveActorActionStatus({
      actions: [{ name: "edit_file" }],
    }),
    "coding"
  )
})

test("actor.action with multiple tools picks the dominant (coding > web)", () => {
  assert.equal(
    resolveActorActionStatus({
      actions: [{ name: "web_search" }, { name: "edit_file" }],
    }),
    "coding"
  )
})

test("actor.action with empty actions returns null (caller decides done)", () => {
  assert.equal(resolveActorActionStatus({ actions: [] }), null)
  assert.equal(resolveActorActionStatus({}), null)
})

test("actor.action with unknown tool falls back to tool", () => {
  assert.equal(
    resolveActorActionStatus({ actions: [{ name: "mystery_op" }] }),
    "tool"
  )
})

test("session.thinking with phase=tool uses tool", () => {
  assert.equal(resolveSessionThinkingStatus({ phase: "tool" }), "tool")
})

test("session.thinking with phase=done returns done", () => {
  assert.equal(resolveSessionThinkingStatus({ phase: "done" }), "done")
})

test("session.thinking default is thinking", () => {
  assert.equal(resolveSessionThinkingStatus({}), "thinking")
  assert.equal(
    resolveSessionThinkingStatus({ status: "Analyzing message..." }),
    "thinking"
  )
})
