import assert from "node:assert/strict"
import test from "node:test"
import {
  AuditLogListQuerySchema,
  AuditLogListViewSchema,
} from "@synapse/shared/schemas"
import { presentAuditLogList } from "./presenter.js"
import { normalizeAuditLogRow } from "./repo.js"

test("AuditLogListQuerySchema owns audit list app query defaults", () => {
  const query = AuditLogListQuerySchema.parse({
    action: "workspace.create",
    resourceType: "workspace",
    resourceId: "22222222-2222-4222-8222-222222222222",
  })

  assert.deepEqual(query, {
    action: "workspace.create",
    resourceType: "workspace",
    resourceId: "22222222-2222-4222-8222-222222222222",
    page: 1,
    pageSize: 50,
  })
  assert.throws(() =>
    AuditLogListQuerySchema.parse({ resourceId: "not-a-uuid" })
  )
})

test("presentAuditLogList output parses AuditLogListViewSchema", () => {
  const createdAt = new Date("2026-06-13T08:00:00.000Z")
  const view = presentAuditLogList({
    items: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        action: "workspace.create",
        resourceType: "workspace",
        resourceId: "22222222-2222-4222-8222-222222222222",
        userId: "33333333-3333-4333-8333-333333333333",
        actorId: null,
        details: { source: "test" },
        ipAddress: "127.0.0.1",
        createdAt,
        userName: "owner@example.com",
        actorName: null,
      },
    ],
    total: 1,
    page: 1,
    pageSize: 20,
  })

  assert.equal(view.items[0]?.createdAt, createdAt.toISOString())
  assert.deepEqual(AuditLogListViewSchema.parse(view), view)
})

test("AuditLogViewSchema requires details to be a JSON object", () => {
  const createdAt = new Date("2026-06-13T08:00:00.000Z")
  const normalized = normalizeAuditLogRow({
    id: "11111111-1111-4111-8111-111111111111",
    action: "workspace.create",
    resourceType: "workspace",
    resourceId: "22222222-2222-4222-8222-222222222222",
    userId: "33333333-3333-4333-8333-333333333333",
    actorId: null,
    details: JSON.stringify({ source: "test" }),
    ipAddress: "127.0.0.1",
    createdAt,
    userName: "owner@example.com",
    actorName: null,
  })
  const view = presentAuditLogList({
    items: [normalized],
    total: 1,
    page: 1,
    pageSize: 20,
  })

  assert.deepEqual(view.items[0]?.details, { source: "test" })
  assert.deepEqual(AuditLogListViewSchema.parse(view), view)
  assert.equal(
    AuditLogListViewSchema.safeParse({
      ...view,
      items: [{ ...view.items[0]!, details: ["not-object"] }],
    }).success,
    false
  )
})

test("normalizeAuditLogRow rejects malformed details JSON at repo exit", () => {
  const createdAt = new Date("2026-06-13T08:00:00.000Z")

  assert.throws(
    () =>
      normalizeAuditLogRow({
        id: "11111111-1111-4111-8111-111111111111",
        action: "workspace.create",
        resourceType: "workspace",
        resourceId: "22222222-2222-4222-8222-222222222222",
        userId: "33333333-3333-4333-8333-333333333333",
        actorId: null,
        details: "not json",
        ipAddress: "127.0.0.1",
        createdAt,
        userName: "owner@example.com",
        actorName: null,
      }),
    /audit log details must be valid JSON/
  )
})

test("normalizeAuditLogRow rejects non-object details JSON at repo exit", () => {
  const createdAt = new Date("2026-06-13T08:00:00.000Z")

  assert.throws(
    () =>
      normalizeAuditLogRow({
        id: "11111111-1111-4111-8111-111111111111",
        action: "workspace.create",
        resourceType: "workspace",
        resourceId: "22222222-2222-4222-8222-222222222222",
        userId: "33333333-3333-4333-8333-333333333333",
        actorId: null,
        details: JSON.stringify(["not-object"]),
        ipAddress: "127.0.0.1",
        createdAt,
        userName: "owner@example.com",
        actorName: null,
      }),
    /audit log details must be a JSON object/
  )
})
