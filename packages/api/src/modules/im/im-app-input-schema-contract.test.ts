import assert from "node:assert/strict"
import test from "node:test"
import {
  TransportAccountCreateInputSchema,
  TransportAccountUpdateInputSchema,
  TransportExternalUserLinkedMemberInputSchema,
  TransportExternalUsersListQuerySchema,
  TransportSessionSettingsInputSchema,
} from "@synapse/shared/schemas"

const actorId = "00000000-0000-4000-8000-000000000001"
const workspaceMemberId = "00000000-0000-4000-8000-000000000002"
const transportAccountId = "00000000-0000-4000-8000-000000000003"

test("TransportAccountCreateInputSchema preserves generic account defaults", () => {
  const parsed = TransportAccountCreateInputSchema.safeParse({
    transportKind: "feishu",
    accountKey: "main",
    displayName: "Main Feishu",
    connectionMode: "webhook",
  })

  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  assert.equal(parsed.data.ownerScope, "workspace")
})

test("TransportAccountCreateInputSchema validates owner and inbound actor invariants", () => {
  assert.equal(
    TransportAccountCreateInputSchema.safeParse({
      transportKind: "feishu",
      accountKey: "member",
      displayName: "Member Account",
      connectionMode: "webhook",
      ownerScope: "workspace_member",
      inboundActorMode: "follow_owner_chief_actor",
    }).success,
    false
  )

  assert.ok(
    TransportAccountCreateInputSchema.safeParse({
      transportKind: "feishu",
      accountKey: "member",
      displayName: "Member Account",
      connectionMode: "webhook",
      ownerScope: "workspace_member",
      ownerWorkspaceMemberId: workspaceMemberId,
      inboundActorMode: "specified_actor",
      inboundActorId: actorId,
    }).success
  )
})

test("TransportAccountUpdateInputSchema rejects invalid generic inbound actor updates", () => {
  assert.equal(
    TransportAccountUpdateInputSchema.safeParse({
      ownerScope: "workspace",
      inboundActorMode: "follow_owner_chief_actor",
    }).success,
    false
  )

  assert.ok(
    TransportAccountUpdateInputSchema.safeParse({
      inboundActorMode: "specified_actor",
      inboundActorId: actorId,
    }).success
  )
})

test("TransportSessionSettingsInputSchema validates conversation actor mode", () => {
  assert.equal(
    TransportSessionSettingsInputSchema.safeParse({
      inboundActorMode: "workspace_chief_actor",
      inboundActorId: actorId,
    }).success,
    false
  )

  assert.ok(
    TransportSessionSettingsInputSchema.safeParse({
      inboundActorMode: "specified_actor",
      inboundActorId: actorId,
      outboundEnabled: true,
    }).success
  )
})

test("IM query/link input schemas reject snake_case fields", () => {
  assert.equal(
    TransportExternalUsersListQuerySchema.safeParse({
      transport_account_id: transportAccountId,
    }).success,
    false
  )

  assert.ok(
    TransportExternalUsersListQuerySchema.safeParse({
      transportAccountId,
    }).success
  )

  assert.equal(
    TransportExternalUserLinkedMemberInputSchema.safeParse({
      workspace_member_id: workspaceMemberId,
    }).success,
    false
  )
})
