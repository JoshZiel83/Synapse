import test from "node:test"
import assert from "node:assert/strict"
import {
  ACCESS_BINDABLE_RESOURCE_TYPES,
  ACCESS_RESOURCE_TYPES,
} from "@synapse/shared"
import { ACCESS_ACTIONS, getAccessActionSpec } from "./actions.js"

test("every ACCESS_ACTIONS entry references a known resource type", () => {
  const knownResources = new Set<string>(ACCESS_RESOURCE_TYPES)
  for (const [actionKey, spec] of Object.entries(ACCESS_ACTIONS)) {
    assert.ok(
      knownResources.has(spec.resourceType),
      `action ${actionKey} references unknown resource type ${spec.resourceType}`
    )
  }
})

test("ACCESS_ACTIONS permission fields are non-empty strings", () => {
  for (const [actionKey, spec] of Object.entries(ACCESS_ACTIONS)) {
    assert.equal(
      typeof spec.permission,
      "string",
      `action ${actionKey} permission is not a string`
    )
    assert.ok(
      spec.permission.length > 0,
      `action ${actionKey} permission is empty`
    )
  }
})

test("ACCESS_ACTIONS keys follow `<resource>.<verb>` convention", () => {
  for (const actionKey of Object.keys(ACCESS_ACTIONS)) {
    assert.match(
      actionKey,
      /^[a-z_]+\.[a-z_]+$/,
      `action key ${actionKey} does not match <resource>.<verb> pattern`
    )
  }
})

test("getAccessActionSpec returns the same object as ACCESS_ACTIONS[key]", () => {
  for (const [actionKey, expected] of Object.entries(ACCESS_ACTIONS)) {
    const spec = getAccessActionSpec(actionKey as keyof typeof ACCESS_ACTIONS)
    assert.deepEqual(spec, expected)
  }
})

test("bindable resource types are all referenced by at least one action", () => {
  const seen = new Set<string>()
  for (const spec of Object.values(ACCESS_ACTIONS)) {
    seen.add(spec.resourceType)
  }
  for (const bindable of ACCESS_BINDABLE_RESOURCE_TYPES) {
    assert.ok(
      seen.has(bindable),
      `bindable resource type ${bindable} has no actions defined in ACCESS_ACTIONS`
    )
  }
})
