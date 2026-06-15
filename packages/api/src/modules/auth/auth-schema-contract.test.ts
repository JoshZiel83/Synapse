import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import {
  AuthMeViewSchema,
  UnlinkAccountInputSchema,
  UpdateMeInputSchema,
} from "@synapse/shared/schemas"

const NOW = "2026-06-14T00:00:00.000Z"

test("AuthMeViewSchema validates the custom auth profile app response", () => {
  assert.equal(
    AuthMeViewSchema.safeParse({
      user: {
        id: crypto.randomUUID(),
        email: "user@example.com",
        name: "Example User",
        avatarUrl: "/api/v1/files/avatar",
        createdAt: NOW,
        updatedAt: NOW,
      },
      session: {
        id: crypto.randomUUID(),
      },
    }).success,
    true
  )
})

test("AuthMeViewSchema rejects non-app response fields", () => {
  assert.equal(
    AuthMeViewSchema.safeParse({
      user: {
        id: crypto.randomUUID(),
        email: "user@example.com",
        name: "Example User",
        createdAt: NOW,
        updatedAt: NOW,
      },
      session: {
        id: crypto.randomUUID(),
        expires_at: NOW,
      },
    }).success,
    false
  )
})

test("UpdateMeInputSchema is a strict camelCase app request body", () => {
  assert.equal(
    UpdateMeInputSchema.safeParse({
      name: "Renamed User",
      avatarFileId: crypto.randomUUID(),
    }).success,
    true
  )

  assert.equal(
    UpdateMeInputSchema.safeParse({
      name: "Renamed User",
      avatar_file_id: crypto.randomUUID(),
    }).success,
    false
  )

  assert.equal(UpdateMeInputSchema.safeParse({}).success, false)
})

test("UnlinkAccountInputSchema is strict and app-facing", () => {
  assert.equal(
    UnlinkAccountInputSchema.safeParse({
      providerId: "github",
      accountId: "acct_123",
    }).success,
    true
  )

  assert.equal(
    UnlinkAccountInputSchema.safeParse({
      provider_id: "github",
      accountId: "acct_123",
    }).success,
    false
  )
})
