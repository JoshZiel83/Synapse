// Round-6 P1-4: the IM response schemas in @synapse/shared/schemas/im.ts were
// deepened from z.unknown() to real Zod. Because the IM controller sends these
// through sendData (which parses through z.output), a schema that under-models
// what the normalizers emit would silently strip fields on the wire. These
// tests pin the normalizer → shared-schema contract: a representative DB row
// run through each normalizer must parse cleanly against the matching shared
// interior schema.

import test from "node:test"
import assert from "node:assert/strict"
import {
  TransportAccountSummarySchema,
  TransportEndpointSummarySchema,
  TransportSessionSummarySchema,
  TransportExternalUserSummarySchema,
} from "@synapse/shared/schemas"
import {
  normalizeAccountRow,
  normalizeEndpointRow,
  normalizeTransportSessionRow,
  normalizeTransportExternalUserRow,
} from "./repo.js"

const ISO = "2026-06-12T00:00:00.000Z"
const asDate = new Date(ISO)

test("normalizeAccountRow output parses TransportAccountSummarySchema", () => {
  const row = {
    id: "acct-1",
    workspaceId: "ws-1",
    transportKind: "feishu" as const,
    accountKey: "key-1",
    displayName: "Feishu Bot",
    ownerScope: "workspace",
    ownerWorkspaceMemberId: "wm-1",
    accountInboundActorMode: "specified_actor",
    accountInboundActorId: "actor-1",
    connectionMode: "webhook" as const,
    status: "active" as const,
    credentials: JSON.stringify({ appSecret: "x" }),
    config: JSON.stringify({ baseUrl: "https://x" }),
    metadata: JSON.stringify({ note: "y" }),
    createdAt: asDate,
    updatedAt: asDate,
  }
  const summary = normalizeAccountRow(row as never)
  const parsed = TransportAccountSummarySchema.safeParse(summary)
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("normalizeEndpointRow output parses TransportEndpointSummarySchema", () => {
  const row = {
    endpointId: "ep-1",
    transportAccountId: "acct-1",
    endpointType: "group",
    endpointExternalId: "ext-1",
    endpointDisplayName: "Group",
    endpointMetadata: JSON.stringify({}),
    endpointCreatedAt: asDate,
    endpointUpdatedAt: asDate,
  }
  const summary = normalizeEndpointRow(row as never, "feishu")
  const parsed = TransportEndpointSummarySchema.safeParse(summary)
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("normalizeTransportSessionRow output parses TransportSessionSummarySchema", () => {
  const row = {
    id: "sess-1",
    bindingId: "bind-1",
    endpointId: "ep-1",
    transportAccountId: "acct-1",
    accountWorkspaceId: "ws-1",
    workspaceId: "ws-1",
    transportKind: "feishu" as const,
    accountKey: "key-1",
    displayName: "Feishu Bot",
    connectionMode: "webhook" as const,
    status: "active" as const,
    outboundEnabled: true,
    inboundActorMode: "inherit_account",
    accountInboundActorMode: "none",
    config: JSON.stringify({}),
    metadata: JSON.stringify({}),
    bindingMetadata: JSON.stringify({}),
    endpointType: "group",
    endpointExternalId: "ext-1",
    bindingCreatedAt: asDate,
    bindingUpdatedAt: asDate,
    createdAt: asDate,
    updatedAt: asDate,
    conversationId: "conv-1",
    conversationTitle: "Title",
  }
  const summary = normalizeTransportSessionRow(row as never)
  const parsed = TransportSessionSummarySchema.safeParse(summary)
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("normalizeTransportExternalUserRow output parses TransportExternalUserSummarySchema", () => {
  const row = {
    id: "eu-1",
    workspaceId: "ws-1",
    transportAccountId: "acct-1",
    transportKind: "feishu" as const,
    accountDisplayName: "Feishu Bot",
    externalId: "ext-1",
    displayName: "User",
    linkedWorkspaceMemberId: "wm-1",
    linkedWorkspaceMemberName: "Member",
    metadata: JSON.stringify({}),
    createdAt: asDate,
    updatedAt: asDate,
    sessions: JSON.stringify([{ conversationId: "conv-1" }]),
  }
  const summary = normalizeTransportExternalUserRow(row as never)
  const parsed = TransportExternalUserSummarySchema.safeParse(summary)
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})
