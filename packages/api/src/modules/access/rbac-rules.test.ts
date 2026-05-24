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
  assert.equal(evaluatePlatformPermission("manage", ["auditor"]), true)
  assert.equal(evaluatePlatformPermission("manage", ["super_admin"]), true)
})

test("platform.manage_workspaces is granted by super_admin or workspace_admin", () => {
  assert.equal(evaluatePlatformPermission("manage_workspaces", []), false)
  assert.equal(
    evaluatePlatformPermission("manage_workspaces", ["auditor"]),
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

test("platform.audit only granted by super_admin or auditor", () => {
  assert.equal(evaluatePlatformPermission("audit", ["model_admin"]), false)
  assert.equal(evaluatePlatformPermission("audit", ["auditor"]), true)
  assert.equal(evaluatePlatformPermission("audit", ["super_admin"]), true)
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
