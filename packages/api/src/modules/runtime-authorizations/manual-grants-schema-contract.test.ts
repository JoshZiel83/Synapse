import assert from "node:assert/strict"
import test from "node:test"
import {
  CreateManualRuntimeAuthorizationGrantInputSchema,
  RuntimeAuthorizationGrantRecordViewSchema,
} from "@synapse/shared/schemas"

const runtimeCapabilityId = "00000000-0000-4000-8000-000000000001"

function browserGrantPolicy(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    capability: "browser",
    browser: {
      action: "read",
      scopeType: "origin",
      origin: "https://example.com",
      operations: ["page.read"],
      ...overrides,
    },
  }
}

test("manual runtime authorization grant input uses app-facing camelCase", () => {
  const parsed = CreateManualRuntimeAuthorizationGrantInputSchema.safeParse({
    runtimeCapabilityId,
    policy: browserGrantPolicy(),
  })
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("manual runtime authorization grant input validates grant policy branch", () => {
  assert.equal(
    CreateManualRuntimeAuthorizationGrantInputSchema.safeParse({
      runtimeCapabilityId,
      policy: { capability: "browser" },
    }).success,
    false
  )
  assert.equal(
    CreateManualRuntimeAuthorizationGrantInputSchema.safeParse({
      runtimeCapabilityId,
      policy: browserGrantPolicy({ operations: ["not.a.real.operation"] }),
    }).success,
    false
  )
})

test("manual runtime authorization grant input strips browser scopeSource", () => {
  const parsed = CreateManualRuntimeAuthorizationGrantInputSchema.parse({
    runtimeCapabilityId,
    policy: browserGrantPolicy({ scopeSource: "requested_action" }),
  })
  assert.equal("scopeSource" in parsed.policy.browser!, false)
})

test("manual runtime authorization grant input rejects legacy snake_case", () => {
  const parsed = CreateManualRuntimeAuthorizationGrantInputSchema.safeParse({
    runtime_capability_id: runtimeCapabilityId,
    policy: browserGrantPolicy(),
  })
  assert.equal(parsed.success, false)
})

function runtimeAuthorizationGrantView(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "grant-1",
    workspaceId: "workspace-1",
    runtimeId: "device-1",
    runtimeCapabilityId,
    runtimeExposureId: "exposure-1",
    subject: { kind: "workspace", workspaceId: "workspace-1" },
    scopeLabel: "workspace",
    sourceRequestArgs: {},
    retention: "until_revoked",
    status: "active",
    ...browserGrantPolicy(),
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  }
}

test("manual runtime authorization grant response validates subject and policy branches", () => {
  const parsed = RuntimeAuthorizationGrantRecordViewSchema.safeParse(
    runtimeAuthorizationGrantView()
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("manual runtime authorization grant response rejects legacy subject and missing policy branch", () => {
  assert.equal(
    RuntimeAuthorizationGrantRecordViewSchema.safeParse(
      runtimeAuthorizationGrantView({
        subject: { kind: "workspace", workspace_id: "workspace-1" },
      })
    ).success,
    false
  )
  assert.equal(
    RuntimeAuthorizationGrantRecordViewSchema.safeParse(
      runtimeAuthorizationGrantView({
        capability: "browser",
        browser: undefined,
      })
    ).success,
    false
  )
})
