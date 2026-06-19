/**
 * Service-level regression for the updateAutomationEventSource blocker fix.
 *
 * The workspace_resource authz fold moved an automation event source's
 * display_name + status off the automation_event_sources detail table and onto
 * the workspace_resources ROOT. The blocker was that updateAutomationEventSource
 * tried to write display_name/status into the detail table (columns that no
 * longer exist) and crashed. The fix routes them through
 * updateWorkspaceResourceRootDefault instead. This test proves the fix: a
 * non-integration event source is created, then updated with a NEW name + a NEW
 * status, and we assert (a) the call does not throw, and (b) the
 * workspace_resources root now carries the new display_name + status.
 *
 * Like membership-lifecycle.test.ts, this exercises the HIGH-LEVEL service
 * functions which use the global `db` singleton bound to DATABASE_URL, so it is
 * skipped when DATABASE_URL is unset (the default testcontainer unit run). CI /
 * local runs that export DATABASE_URL (a throwaway DB with the current schema
 * bootstrapped) execute it.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

const HAS_DB = Boolean(process.env.DATABASE_URL)
const maybe = HAS_DB ? test : test.skip

function rid() {
  return Math.random().toString(36).slice(2, 10)
}

maybe(
  "updateAutomationEventSource persists a new name + status onto the workspace_resources root without throwing",
  { timeout: 5 * 60_000 },
  async () => {
    const { db } = await import("../../infrastructure/database/kysely.js")
    const { createAutomationEventSource, updateAutomationEventSource } =
      await import("./service.js")

    const userId = (
      await db
        .insertInto("users")
        .values({ email: `aes-${rid()}@e.test`, name: "AES creator" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id as string
    const workspaceId = (
      await db
        .insertInto("workspaces")
        .values({ ownerId: userId, slug: `aes-${rid()}`, name: "AES WS" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id as string
    const memberId = (
      await db
        .insertInto("workspaceMembers")
        .values({ workspaceId, userId, trustLevel: "member" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id as string

    const creator = {
      kind: "workspace_member" as const,
      workspaceMemberId: memberId,
    }

    // Create a non-integration (provider_kind: "internal") event source. The
    // service writes the root (display_name + status) and the detail row.
    const created = await createAutomationEventSource(workspaceId, creator, {
      providerKind: "internal",
      name: "Original Source Name",
      description: "original description",
      status: "active",
    })
    assert.equal(created.name, "Original Source Name")
    assert.equal(created.status, "active")

    // The blocker path: update with a NEW name and a NEW status. Pre-fix this
    // threw because display_name/status were written to the detail table.
    const newName = `Renamed Source ${rid()}`
    const updated = await updateAutomationEventSource(
      workspaceId,
      created.id,
      { workspaceMemberId: memberId },
      { name: newName, status: "disabled" }
    )

    // (a) returned presentation reflects the new name + status.
    assert.equal(updated.name, newName)
    assert.equal(updated.status, "disabled")

    // (b) the workspace_resources ROOT itself carries the new display_name +
    // status (the columns the blocker fix re-routed writes to).
    const root = await db
      .selectFrom("workspaceResources")
      .select(["displayName", "status"])
      .where("id", "=", created.id)
      .executeTakeFirstOrThrow()
    assert.equal(root.displayName, newName)
    assert.equal(root.status, "disabled")
  }
)
