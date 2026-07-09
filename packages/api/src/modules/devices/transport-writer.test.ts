// Functional (real-DB) test for updateRuntimeServiceTransport (§3 P3a). The value
// is written at tunnel.up from the reachability the SSRF validator accepted. The
// safety-critical property: the writer is scoped to service_kind='device_runtime'
// so it can NEVER write a non-'direct' transport onto a bare_dataplane row (which
// chk_runtime_services_transport_kind forbids — that would throw / corrupt).

import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { sql } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { updateRuntimeServiceTransport } from "./repo.js"

async function seedWorkspace(db: any): Promise<string> {
  const workspaceId = randomUUID()
  const userId = randomUUID()
  await db.executeQuery(
    sql`INSERT INTO users (id, email, name) VALUES (${userId}, ${`${userId}@test`}, 'tester')`.compile(
      db
    )
  )
  await db.executeQuery(
    sql`INSERT INTO workspaces (id, name, slug, owner_id) VALUES (${workspaceId}, 'ws', ${`ws-${workspaceId.slice(0, 8)}`}, ${userId})`.compile(
      db
    )
  )
  return workspaceId
}

async function transportOf(db: any, serviceId: string): Promise<string> {
  const res = await db.executeQuery(
    sql`SELECT transport FROM runtime_services WHERE id = ${serviceId}`.compile(
      db
    )
  )
  return res.rows[0]?.transport as string
}

test("updateRuntimeServiceTransport writes the reachability on a device_runtime service", async () => {
  await withTestDb(async (db) => {
    const workspaceId = await seedWorkspace(db)
    const runtimeId = randomUUID()
    await db.executeQuery(
      sql`INSERT INTO runtimes (id, workspace_id, kind) VALUES (${runtimeId}, ${workspaceId}, 'device')`.compile(
        db
      )
    )
    await db.executeQuery(
      sql`INSERT INTO devices (id, workspace_id, title, device_type, public_key, public_key_fingerprint, trust_status)
          VALUES (${runtimeId}, ${workspaceId}, 'd', 'desktop_computer', ${`pk-${runtimeId}`}, ${`fp-${runtimeId}`}, 'trusted')`.compile(
        db
      )
    )
    const serviceId = randomUUID()
    await db.executeQuery(
      sql`INSERT INTO runtime_services (id, runtime_id, service_kind, status) VALUES (${serviceId}, ${runtimeId}, 'device_runtime', 'online')`.compile(
        db
      )
    )
    // Default is 'none' until a data plane comes up.
    assert.equal(await transportOf(db, serviceId), "none")

    await updateRuntimeServiceTransport(serviceId, "indirect", db)
    assert.equal(await transportOf(db, serviceId), "indirect")

    await updateRuntimeServiceTransport(serviceId, "direct", db)
    assert.equal(await transportOf(db, serviceId), "direct")
  })
})

test("updateRuntimeServiceTransport is a NO-OP on a bare_dataplane service (protects the CHECK)", async () => {
  await withTestDb(async (db) => {
    const workspaceId = await seedWorkspace(db)
    const runtimeId = randomUUID()
    await db.executeQuery(
      sql`INSERT INTO runtimes (id, workspace_id, kind) VALUES (${runtimeId}, ${workspaceId}, 'sandbox')`.compile(
        db
      )
    )
    await db.executeQuery(
      sql`INSERT INTO sandboxes (id, workspace_id, mode, adapter, state)
          VALUES (${runtimeId}, ${workspaceId}, 'bare', 'local', 'active')`.compile(
        db
      )
    )
    const bareServiceId = randomUUID()
    await db.executeQuery(
      sql`INSERT INTO runtime_services (id, runtime_id, service_kind, status, data_plane_endpoint, transport)
          VALUES (${bareServiceId}, ${runtimeId}, 'bare_dataplane', 'online', ${`inprocess:${runtimeId}`}, 'direct')`.compile(
        db
      )
    )
    assert.equal(await transportOf(db, bareServiceId), "direct")

    // Attempting to write 'indirect' must NOT touch the bare row (service_kind
    // scope) — if it did, chk_runtime_services_transport_kind would reject it.
    await updateRuntimeServiceTransport(bareServiceId, "indirect", db)
    assert.equal(
      await transportOf(db, bareServiceId),
      "direct",
      "bare_dataplane transport must remain 'direct' — writer is device_runtime-scoped"
    )
  })
})
