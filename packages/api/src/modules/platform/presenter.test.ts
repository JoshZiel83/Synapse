import test from "node:test"
import assert from "node:assert/strict"
import { PLATFORM_ACCESS_KEYS, PLATFORM_ACCESS_SOURCE } from "@synapse/shared"
import {
  PlatformAccessBindingListViewSchema,
  PlatformAccessBindingViewSchema,
  PlatformAccessGrantInputSchema,
  PlatformNavigationViewSchema,
} from "@synapse/shared/schemas"
import {
  presentPlatformAccessBinding,
  presentPlatformNavigation,
} from "./presenter.js"

const createdAt = new Date("2026-06-13T00:00:00.000Z")
const updatedAt = new Date("2026-06-13T00:01:00.000Z")

test("presentPlatformNavigation output parses PlatformNavigationViewSchema", () => {
  const parsed = PlatformNavigationViewSchema.safeParse(
    presentPlatformNavigation({ canManagePlatform: true })
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("PlatformAccessGrantInputSchema owns platform grant app body", () => {
  const parsed = PlatformAccessGrantInputSchema.parse({
    userId: "00000000-0000-4000-8000-000000000001",
    accessKey: PLATFORM_ACCESS_KEYS[0],
  })

  assert.deepEqual(parsed, {
    userId: "00000000-0000-4000-8000-000000000001",
    accessKey: PLATFORM_ACCESS_KEYS[0],
  })
  assert.throws(() =>
    PlatformAccessGrantInputSchema.parse({
      userId: "00000000-0000-4000-8000-000000000001",
      access_key: PLATFORM_ACCESS_KEYS[0],
    })
  )
  assert.throws(() =>
    PlatformAccessGrantInputSchema.parse({
      userId: "00000000-0000-4000-8000-000000000001",
      accessKey: "not_a_real_key",
    })
  )
})

test("presentPlatformAccessBinding output parses platform access schemas", () => {
  const binding = presentPlatformAccessBinding({
    userId: "00000000-0000-4000-8000-000000000001",
    accessKey: PLATFORM_ACCESS_KEYS[0],
    source: PLATFORM_ACCESS_SOURCE.MANUAL,
    assignedByUserId: "00000000-0000-4000-8000-000000000002",
    createdAt,
    updatedAt,
    userName: "Admin",
    userEmail: "admin@example.com",
    avatarUrl: null,
  })

  const single = PlatformAccessBindingViewSchema.safeParse(binding)
  assert.ok(single.success, JSON.stringify(single.error?.issues))

  const list = PlatformAccessBindingListViewSchema.safeParse([binding])
  assert.ok(list.success, JSON.stringify(list.error?.issues))

  assert.throws(() =>
    PlatformAccessBindingViewSchema.parse({
      ...binding,
      source: "environment",
    })
  )
})
