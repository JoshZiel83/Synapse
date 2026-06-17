import test from "node:test"
import assert from "node:assert/strict"
import {
  WorkspaceInvitePublicViewSchema,
  WorkspaceInviteRedeemResultSchema,
  WorkspaceInviteViewSchema,
} from "@synapse/shared/schemas"
import {
  presentWorkspaceInvite,
  presentWorkspaceInvitePublic,
  presentWorkspaceInviteRedeemResult,
} from "./presenter.js"
import type {
  WorkspaceInviteRecord,
  WorkspaceInviteRedeemRecord,
  WorkspaceInviteWithWorkspaceNameRecord,
} from "./repo.js"

const inviteRecord: WorkspaceInviteRecord = {
  id: "invite-1",
  workspaceId: "workspace-1",
  token: "invite-token",
  createdByWorkspaceMemberId: "member-1",
  trustLevel: "member",
  maxUses: 5,
  useCount: 1,
  expiresAt: new Date("2026-06-20T00:00:00.000Z"),
  isRevoked: false,
  createdAt: new Date("2026-06-13T00:00:00.000Z"),
  updatedAt: new Date("2026-06-13T01:00:00.000Z"),
}

test("presentWorkspaceInvite output parses WorkspaceInviteViewSchema", () => {
  const parsed = WorkspaceInviteViewSchema.safeParse(
    presentWorkspaceInvite(inviteRecord)
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("presentWorkspaceInvitePublic output parses WorkspaceInvitePublicViewSchema", () => {
  const record: WorkspaceInviteWithWorkspaceNameRecord = {
    ...inviteRecord,
    workspaceName: "Workspace",
  }
  const parsed = WorkspaceInvitePublicViewSchema.safeParse(
    presentWorkspaceInvitePublic(record)
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("presentWorkspaceInviteRedeemResult output parses WorkspaceInviteRedeemResultSchema", () => {
  const record: WorkspaceInviteRedeemRecord = {
    workspaceId: "workspace-1",
    workspaceName: "Workspace",
    trustLevel: "member",
  }
  const parsed = WorkspaceInviteRedeemResultSchema.safeParse(
    presentWorkspaceInviteRedeemResult(record)
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})
