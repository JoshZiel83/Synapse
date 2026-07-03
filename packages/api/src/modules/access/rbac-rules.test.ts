import test from "node:test"
import assert from "node:assert/strict"
import {
  evaluatePlatformPermission,
  evaluateWorkspacePermission,
  PLATFORM_PERMISSION_RULES,
  WORKSPACE_PERMISSION_RULES,
} from "./rbac-rules.js"

test("platform.manage requires any platform access key", () => {
  assert.equal(evaluatePlatformPermission("manage", []), false)
  assert.equal(evaluatePlatformPermission("manage", ["support"]), true)
  assert.equal(evaluatePlatformPermission("manage", ["super_admin"]), true)
})

test("platform.manage_workspaces is granted by super_admin or workspace_admin", () => {
  assert.equal(evaluatePlatformPermission("manage_workspaces", []), false)
  assert.equal(
    evaluatePlatformPermission("manage_workspaces", ["support"]),
    false
  )
  assert.equal(
    evaluatePlatformPermission("manage_workspaces", ["workspace_admin"]),
    true
  )
  assert.equal(
    evaluatePlatformPermission("manage_workspaces", ["super_admin"]),
    true
  )
})

test("unknown platform permission denies", () => {
  assert.equal(
    evaluatePlatformPermission("delete_universe", ["super_admin"]),
    false
  )
})

test("workspace.view is always allowed", () => {
  assert.equal(
    evaluateWorkspacePermission("view", {
      isAdmin: false,
      accessKeys: [],
      trustLevel: "guest",
    }),
    true
  )
})

test("workspace.manage requires admin", () => {
  assert.equal(
    evaluateWorkspacePermission("manage", {
      isAdmin: false,
      accessKeys: ["actor_admin"],
      trustLevel: "member",
    }),
    false
  )
  assert.equal(
    evaluateWorkspacePermission("manage", {
      isAdmin: true,
      accessKeys: [],
      trustLevel: "member",
    }),
    true
  )
})

test("workspace.manage_actors granted by admin or actor_admin key", () => {
  assert.equal(
    evaluateWorkspacePermission("manage_actors", {
      isAdmin: false,
      accessKeys: ["skill_admin"],
      trustLevel: "member",
    }),
    false
  )
  assert.equal(
    evaluateWorkspacePermission("manage_actors", {
      isAdmin: false,
      accessKeys: ["actor_admin"],
      trustLevel: "member",
    }),
    true
  )
  assert.equal(
    evaluateWorkspacePermission("manage_actors", {
      isAdmin: true,
      accessKeys: [],
      trustLevel: "member",
    }),
    true
  )
})

test("workspace.manage_devices granted by admin or device_admin key", () => {
  // Regression guard for the relay→device naming drift: the canonical
  // workspace permission key is `manage_devices` (not the legacy
  // `manage_relays`), backed by the `device_admin` access key. evaluator.ts
  // device/exposure/capability handlers call this key, and an unknown key
  // would silently deny via the `if (!rule) return false` guard.
  assert.equal(
    evaluateWorkspacePermission("manage_devices", {
      isAdmin: false,
      accessKeys: ["skill_admin"],
      trustLevel: "member",
    }),
    false
  )
  assert.equal(
    evaluateWorkspacePermission("manage_devices", {
      isAdmin: false,
      accessKeys: ["device_admin"],
      trustLevel: "member",
    }),
    true
  )
  assert.equal(
    evaluateWorkspacePermission("manage_devices", {
      isAdmin: true,
      accessKeys: [],
      trustLevel: "member",
    }),
    true
  )
})

test("workspace.manage_relays is NOT a permission key (legacy name removed)", () => {
  // The relay→device rename retired `manage_relays`. If it ever reappears as a
  // rules-table key, the stale literal in evaluator.ts call sites would start
  // resolving again and mask a regression — so assert it stays unknown.
  assert.equal(
    evaluateWorkspacePermission("manage_relays", {
      isAdmin: true,
      accessKeys: ["device_admin"],
      trustLevel: "admin",
    }),
    false
  )
})

test("workspace.create_conversation excludes guests only", () => {
  assert.equal(
    evaluateWorkspacePermission("create_conversation", {
      isAdmin: false,
      accessKeys: [],
      trustLevel: "guest",
    }),
    false
  )
  assert.equal(
    evaluateWorkspacePermission("create_conversation", {
      isAdmin: false,
      accessKeys: [],
      trustLevel: "member",
    }),
    true
  )
  assert.equal(
    evaluateWorkspacePermission("create_conversation", {
      isAdmin: true,
      accessKeys: [],
      trustLevel: "admin",
    }),
    true
  )
})

test("unknown workspace permission denies", () => {
  assert.equal(
    evaluateWorkspacePermission("delete_universe", {
      isAdmin: true,
      accessKeys: ["actor_admin"],
      trustLevel: "admin",
    }),
    false
  )
})

test("every rule entry has a defined kind", () => {
  for (const [name, rule] of Object.entries(PLATFORM_PERMISSION_RULES)) {
    assert.ok(rule.kind, `platform rule ${name} missing kind`)
  }
  for (const [name, rule] of Object.entries(WORKSPACE_PERMISSION_RULES)) {
    assert.ok(rule.kind, `workspace rule ${name} missing kind`)
  }
})
