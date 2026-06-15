// Round-6 P1-4: the remote-agents response schemas in
// @synapse/shared/schemas/remote-agents.ts were deepened from z.unknown() to
// real Zod. The controller sends present*() output through sendData (parses
// through z.output), so an under-modeled schema would strip fields on the wire.
// These tests pin the presenter → shared-schema contract.

import test from "node:test"
import assert from "node:assert/strict"
import { REMOTE_AGENT_BINDING_STATUS } from "@synapse/shared"
import {
  RemoteAgentViewSchema,
  RemoteAgentMachineViewSchema,
  RemoteAgentRuntimeCatalogEntryViewSchema,
  RemoteAgentGroupTaskGrantViewSchema,
  RemoteAgentMachineBindingViewSchema,
  RemoteAgentRuntimeSummaryViewSchema,
} from "@synapse/shared/schemas"
import {
  presentRemoteAgent,
  presentMachineListItem,
  presentMachineFromCamelRow,
  presentRuntimeCatalogEntry,
  presentGroupTaskGrant,
  presentMachineBinding,
  type RemoteAgentRow,
} from "./presenter.js"

const asDate = new Date("2026-06-12T00:00:00.000Z")

const baseAgentRow: RemoteAgentRow = {
  id: "ra-1",
  workspaceId: "ws-1",
  displayName: "Agent",
  title: "Title",
  description: "desc",
  runtimeKind: "claude_code",
  avatarFileId: null,
  avatarEmoji: null,
  isActive: true,
  isPublicShared: false,
  metadata: { x: 1 },
  ownerWorkspaceMemberId: "wm-1",
  createdAt: asDate,
  updatedAt: asDate,
}

test("presentRemoteAgent (unbound) parses RemoteAgentViewSchema", () => {
  const parsed = RemoteAgentViewSchema.safeParse(
    presentRemoteAgent(baseAgentRow, true)
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("presentRemoteAgent (bound, with runtime summary) parses RemoteAgentViewSchema", () => {
  const bound: RemoteAgentRow = {
    ...baseAgentRow,
    machineId: "m-1",
    machineTitle: "Machine",
    bindingStatus: REMOTE_AGENT_BINDING_STATUS.ACTIVE,
    runtimePath: "/usr/bin/claude",
    machineLifecycleState: "online",
    runtimeState: "idle",
    statusText: "ready",
    pendingConversationCount: 2,
    unreadDeliveryCount: 0,
    lastActivityAt: asDate,
    capabilities: { supportsPlanMode: true },
  }
  const parsed = RemoteAgentViewSchema.safeParse(
    presentRemoteAgent(bound, false)
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("presentMachineListItem parses RemoteAgentMachineViewSchema", () => {
  const parsed = RemoteAgentMachineViewSchema.safeParse(
    presentMachineListItem({
      id: "m-1",
      workspaceId: "ws-1",
      title: "Machine",
      description: null,
      trustStatus: "active",
      lifecycleState: "online",
      bindingCount: 3,
      lastSeenAt: asDate,
      createdAt: asDate,
      updatedAt: asDate,
    })
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("presentMachineFromCamelRow parses RemoteAgentMachineViewSchema", () => {
  const parsed = RemoteAgentMachineViewSchema.safeParse(
    presentMachineFromCamelRow({
      id: "m-1",
      workspaceId: "ws-1",
      title: "Machine",
      description: null,
      trustStatus: "active",
      lifecycleState: "online",
      lastSeenAt: asDate,
      createdAt: asDate,
      updatedAt: asDate,
    })
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("presentRuntimeCatalogEntry parses RemoteAgentRuntimeCatalogEntryViewSchema", () => {
  const parsed = RemoteAgentRuntimeCatalogEntryViewSchema.safeParse(
    presentRuntimeCatalogEntry({
      runtimeKind: "codex",
      executablePath: "/usr/bin/codex",
      status: "available",
      version: "1.0.0",
      metadata: {},
      lastSeenAt: asDate,
    })
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("presentGroupTaskGrant parses RemoteAgentGroupTaskGrantViewSchema", () => {
  const parsed = RemoteAgentGroupTaskGrantViewSchema.safeParse(
    presentGroupTaskGrant(
      {
        workspaceMemberId: "wm-1",
        grantedByWorkspaceMemberId: "wm-2",
        createdAt: asDate,
        updatedAt: asDate,
        userId: "u-1",
        userName: "User",
      },
      "https://avatar"
    )
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("presentMachineBinding parses RemoteAgentMachineBindingViewSchema", () => {
  const parsed = RemoteAgentMachineBindingViewSchema.safeParse(
    presentMachineBinding({
      remoteAgentId: "ra-1",
      displayName: "Agent",
      runtimeKind: "claude_code",
      runtimePath: "/usr/bin/claude",
      status: REMOTE_AGENT_BINDING_STATUS.ACTIVE,
      runtimeState: "idle",
      pendingConversationCount: 0,
      unreadDeliveryCount: 0,
    })
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("remote-agent shared app schemas reject unknown runtime, machine, and binding statuses", () => {
  assert.equal(
    RemoteAgentRuntimeSummaryViewSchema.safeParse({
      runtimeKind: "claude_code",
      state: "manual",
      pendingConversationCount: 0,
      unreadDeliveryCount: 0,
    }).success,
    false
  )
  assert.equal(
    RemoteAgentMachineViewSchema.safeParse({
      id: "m-1",
      workspaceId: "ws-1",
      title: "Machine",
      trustStatus: "trusted",
      lifecycleState: "online",
    }).success,
    false
  )
  assert.equal(
    RemoteAgentMachineViewSchema.safeParse({
      id: "m-1",
      workspaceId: "ws-1",
      title: "Machine",
      trustStatus: "active",
      lifecycleState: "booting",
    }).success,
    false
  )
  assert.equal(
    RemoteAgentRuntimeCatalogEntryViewSchema.safeParse({
      runtimeKind: "codex",
      status: "installed",
      metadata: {},
    }).success,
    false
  )
  const agentWithInvalidLifecycleState = presentRemoteAgent(
    {
      ...baseAgentRow,
      machineId: "m-1",
      machineLifecycleState: "online",
    },
    false
  )
  assert.ok(agentWithInvalidLifecycleState.binding)
  assert.equal(
    RemoteAgentViewSchema.safeParse({
      ...agentWithInvalidLifecycleState,
      binding: {
        ...agentWithInvalidLifecycleState.binding,
        machineLifecycleState: "booting",
      },
    }).success,
    false
  )
  assert.equal(
    RemoteAgentViewSchema.safeParse({
      ...agentWithInvalidLifecycleState,
      binding: {
        ...agentWithInvalidLifecycleState.binding,
        status: "paused",
      },
    }).success,
    false
  )
  assert.equal(
    RemoteAgentMachineBindingViewSchema.safeParse({
      remoteAgentId: "ra-1",
      displayName: "Agent",
      runtimeKind: "claude_code",
      status: "paused",
      runtimeSummary: {
        runtimeKind: "claude_code",
        state: "idle",
        pendingConversationCount: 0,
        unreadDeliveryCount: 0,
      },
    }).success,
    false
  )
})
