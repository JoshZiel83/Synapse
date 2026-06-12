// Cloud-device body contract regression (P0-1).
//
// The SDK sends the cloud-create body WITHOUT workspaceId (it travels in the
// URL); the API route validates with CreateCloudDeviceInputSchema.omit({
// workspaceId }) — a strictObject. Earlier the SDK sent the full parsed input
// (incl. workspaceId), which the strict server schema rejected with 400. These
// tests pin the agreed body shape so SDK and server can't drift again.

import test from "node:test"
import assert from "node:assert/strict"
import { CreateCloudDeviceInputSchema } from "@synapse/shared/schemas"

// The exact schema the API cloud route uses to validate the request body.
const cloudBodySchema = CreateCloudDeviceInputSchema.omit({ workspaceId: true })

const wsId = "00000000-0000-4000-8000-000000000001"

test("cloud body: SDK shape (no workspaceId) is accepted", () => {
  const body = { title: "Cloud", hostProvider: "e2b" as const, preset: "p" }
  assert.equal(cloudBodySchema.safeParse(body).success, true)
})

test("cloud body: omitting title/hostProvider is accepted (server applies defaults)", () => {
  assert.equal(cloudBodySchema.safeParse({}).success, true)
})

test("cloud body: an extra workspaceId key is REJECTED (strictObject)", () => {
  const bodyWithWorkspaceId = {
    workspaceId: wsId,
    title: "Cloud",
    hostProvider: "e2b" as const,
  }
  assert.equal(
    cloudBodySchema.safeParse(bodyWithWorkspaceId).success,
    false,
    "sending workspaceId in the body must be rejected — it belongs in the URL"
  )
})

test("cloud body: the full input schema still requires workspaceId (URL param source)", () => {
  // The SDK's input contract (before stripping for the body) keeps workspaceId
  // so the SDK can build the URL.
  assert.equal(
    CreateCloudDeviceInputSchema.safeParse({ workspaceId: wsId }).success,
    true
  )
  assert.equal(
    CreateCloudDeviceInputSchema.safeParse({ title: "x" }).success,
    false,
    "workspaceId is required on the SDK input contract"
  )
})
