// Locks the per-tool filesystem projection (post-review round 10): writers
// must request action=write; subtree-based tools project the subtree, not "/";
// fs_search uses "/" so callers without any existing read grant get a
// surfaceable request rather than a meaningless empty path.

import test from "node:test"
import assert from "node:assert/strict"
import { buildRequestedAction } from "./service.js"

test("buildRequestedAction — fs_write requests action=write", () => {
  const action = buildRequestedAction({
    capability: "filesystem",
    toolName: "device__cap__fs_write",
    visibleToolName: "fs_write",
    args: { path: "/repo/x.ts", content: "..." },
  })
  assert.equal(action.filesystem?.access, "write")
  assert.deepEqual(action.filesystem?.pathPrefixes, ["/repo/x.ts"])
})

test("B12: layer-2 fs tools (fs_mkdir/fs_move/fs_remove) request write; fs_move constrains BOTH endpoints", () => {
  const mkdir = buildRequestedAction({
    capability: "filesystem",
    toolName: "device__cap__fs_mkdir",
    visibleToolName: "fs_mkdir",
    args: { path: "/repo/newdir", recursive: true },
  })
  assert.equal(mkdir.filesystem?.access, "write")
  assert.deepEqual(mkdir.filesystem?.pathPrefixes, ["/repo/newdir"])

  const remove = buildRequestedAction({
    capability: "filesystem",
    toolName: "device__cap__fs_remove",
    visibleToolName: "fs_remove",
    args: { path: "/repo/old", recursive: true },
  })
  assert.equal(remove.filesystem?.access, "write")
  assert.deepEqual(remove.filesystem?.pathPrefixes, ["/repo/old"])

  // fs_move MUST project source AND destination so the grant must cover both
  // endpoints (F-C — a grant covering only one side does not satisfy the claim).
  const move = buildRequestedAction({
    capability: "filesystem",
    toolName: "device__cap__fs_move",
    visibleToolName: "fs_move",
    args: { source: "/repo/a.ts", destination: "/repo/sub/b.ts" },
  })
  assert.equal(move.filesystem?.access, "write")
  assert.deepEqual(move.filesystem?.pathPrefixes, [
    "/repo/a.ts",
    "/repo/sub/b.ts",
  ])
})

test("buildRequestedAction — fs_edit / fs_delete / fs_history_restore request write", () => {
  for (const tool of ["fs_edit", "fs_delete", "fs_history_restore"]) {
    const action = buildRequestedAction({
      capability: "filesystem",
      toolName: `device__cap__${tool}`,
      visibleToolName: tool,
      args: { path: "/a/b" },
    })
    assert.equal(action.filesystem?.access, "write", `${tool} should be write`)
  }
})

test("buildRequestedAction — fs_read / fs_stat / list_dir / fs_history_list / fs_history_diff request read", () => {
  for (const tool of [
    "fs_read",
    "fs_stat",
    "list_dir",
    "fs_history_list",
    "fs_history_diff",
  ]) {
    const action = buildRequestedAction({
      capability: "filesystem",
      toolName: `device__cap__${tool}`,
      visibleToolName: tool,
      args: { path: "/a/b" },
    })
    assert.equal(action.filesystem?.access, "read", `${tool} should be read`)
  }
})

test("buildRequestedAction — fs_index_status projects args.subtree, not '/'", () => {
  const action = buildRequestedAction({
    capability: "filesystem",
    toolName: "device__cap__fs_index_status",
    visibleToolName: "fs_index_status",
    args: { subtree: "/repo" },
  })
  assert.equal(action.filesystem?.access, "read")
  assert.deepEqual(action.filesystem?.pathPrefixes, ["/repo"])
})

test("buildRequestedAction — fs_index_rebuild projects args.subtree (write semantics live device-side; projection only needs path)", () => {
  const action = buildRequestedAction({
    capability: "filesystem",
    toolName: "device__cap__fs_index_rebuild",
    visibleToolName: "fs_index_rebuild",
    args: { subtree: "/repo" },
  })
  assert.deepEqual(action.filesystem?.pathPrefixes, ["/repo"])
})

test("buildRequestedAction — fs_search keeps '/' so first-time callers get an approveable request", () => {
  const action = buildRequestedAction({
    capability: "filesystem",
    toolName: "device__cap__fs_search",
    visibleToolName: "fs_search",
    args: { mode: "content", query: "TODO" },
  })
  // Runtime evaluates fs_search against the caller's existing read grants;
  // a fresh caller without any fs grant still needs a request to fill, and
  // "/" is the only honest answer when there's no scoping info available.
  assert.equal(action.filesystem?.access, "read")
  assert.deepEqual(action.filesystem?.pathPrefixes, ["/"])
  assert.equal(action.filesystem?.scopeIsPushdown, true)
})

test("buildRequestedAction — fs_index_task_status sets scopeIsPushdown (no path/subtree at all)", () => {
  const action = buildRequestedAction({
    capability: "filesystem",
    toolName: "device__cap__fs_index_task_status",
    visibleToolName: "fs_index_task_status",
    args: { task_id: "rebuild-123" },
  })
  assert.equal(action.filesystem?.access, "read")
  assert.equal(action.filesystem?.scopeIsPushdown, true)
  assert.deepEqual(action.filesystem?.pathPrefixes, ["/"])
})

test("buildRequestedAction — fs_history_list WITHOUT path sets scopeIsPushdown", () => {
  const action = buildRequestedAction({
    capability: "filesystem",
    toolName: "device__cap__fs_history_list",
    visibleToolName: "fs_history_list",
    args: { limit: 50 },
  })
  assert.equal(action.filesystem?.scopeIsPushdown, true)
})

test("buildRequestedAction — fs_history_list WITH path projects normally (not pushdown)", () => {
  const action = buildRequestedAction({
    capability: "filesystem",
    toolName: "device__cap__fs_history_list",
    visibleToolName: "fs_history_list",
    args: { path: "/repo/x.ts" },
  })
  assert.equal(action.filesystem?.scopeIsPushdown, undefined)
  assert.deepEqual(action.filesystem?.pathPrefixes, ["/repo/x.ts"])
})
