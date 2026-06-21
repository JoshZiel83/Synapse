// Unit tests for validateTunnelInternalUrl — the SSRF/token gate that decides
// whether a device-supplied tunnel internal_url may be registered for dispatch.
// Two accept paths: the frp edge (origin + /d/<token>) and the strict local
// loopback (127.0.0.1/[::1] http, only for a device with a LIVE local sandbox
// mount). Everything else must be rejected.

import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { sql } from "kysely"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import { withTestDb } from "../../test/helpers/db.js"
import { validateTunnelInternalUrl } from "./control-plane.js"

const EDGE = "http://tunnel-edge:8080"

async function withEdgeEnv<T>(
  value: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const prev = process.env.SYNAPSE_DEVICE_TUNNEL_EDGE_URL
  if (value === undefined) delete process.env.SYNAPSE_DEVICE_TUNNEL_EDGE_URL
  else process.env.SYNAPSE_DEVICE_TUNNEL_EDGE_URL = value
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.SYNAPSE_DEVICE_TUNNEL_EDGE_URL
    else process.env.SYNAPSE_DEVICE_TUNNEL_EDGE_URL = prev
  }
}

/** Bind validateTunnelInternalUrl to the per-test testcontainer db (the
 *  production default executor is the global singleton, which the testcontainer
 *  db is NOT). */
function validatorFor(db: KyselyDb) {
  return (candidate: string, deviceServiceId: string) =>
    validateTunnelInternalUrl({ candidate, deviceServiceId, executor: db })
}

/** Seed workspace + device + device_runtime service, optionally with a live
 *  local sandbox file_mount and/or a tunnel_path_token. Returns the serviceId. */
async function seedService(
  db: any,
  opts: {
    tunnelPathToken?: string
    liveLocalMount?: boolean
    mountStatus?: string
    mountBackend?: "local" | "docker"
  } = {}
): Promise<string> {
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
  const deviceId = randomUUID()
  await db.executeQuery(
    sql`INSERT INTO devices (id, workspace_id, title, host_kind, device_type, public_key, public_key_fingerprint, trust_status)
        VALUES (${deviceId}, ${workspaceId}, 'd', 'local', 'desktop_computer', ${`pk-${deviceId}`}, ${`fp-${deviceId}`}, 'trusted')`.compile(
      db
    )
  )
  const serviceId = randomUUID()
  await db.executeQuery(
    sql`INSERT INTO device_services (id, device_id, service_kind, status, tunnel_path_token)
        VALUES (${serviceId}, ${deviceId}, 'device_runtime', 'online', ${opts.tunnelPathToken ?? null})`.compile(
      db
    )
  )
  if (opts.liveLocalMount) {
    // Minimal FK chain for a file_mount: actor + conversation + session +
    // access_subject(actor) + file_space.
    const actorId = randomUUID()
    // workspace_resources.created_by_subject_id is NOT NULL with no default; mint
    // a workspace-kind access_subject (same workspace) as the creator. The
    // fixture has no owning member, so owner_subject_id stays NULL.
    const creatorSubjectId = randomUUID()
    await db.executeQuery(
      sql`INSERT INTO access_subjects (id, kind, workspace_id) VALUES (${creatorSubjectId}, 'workspace', ${workspaceId})`.compile(
        db
      )
    )
    await db.executeQuery(
      sql`INSERT INTO workspace_resources (id, workspace_id, kind, display_name, status, created_by_subject_id)
          VALUES (${actorId}, ${workspaceId}, 'actor', 'a', 'active', ${creatorSubjectId})`.compile(
        db
      )
    )
    await db.executeQuery(
      sql`INSERT INTO actors (id, role, title) VALUES (${actorId}, 'assistant', 'A')`.compile(
        db
      )
    )
    const convId = randomUUID()
    await db.executeQuery(
      sql`INSERT INTO conversations (id, workspace_id, kind) VALUES (${convId}, ${workspaceId}, 'direct')`.compile(
        db
      )
    )
    const sessionId = randomUUID()
    await db.executeQuery(
      sql`INSERT INTO sessions (id, workspace_id, actor_id, conversation_id) VALUES (${sessionId}, ${workspaceId}, ${actorId}, ${convId})`.compile(
        db
      )
    )
    const subjectId = randomUUID()
    await db.executeQuery(
      sql`INSERT INTO access_subjects (id, kind, workspace_id, actor_id) VALUES (${subjectId}, 'actor', ${workspaceId}, ${actorId})`.compile(
        db
      )
    )
    const spaceId = randomUUID()
    await db.executeQuery(
      sql`INSERT INTO file_spaces (id, workspace_id, owner_subject_id) VALUES (${spaceId}, ${workspaceId}, ${subjectId})`.compile(
        db
      )
    )
    await db.executeQuery(
      sql`INSERT INTO file_mounts (id, workspace_id, session_id, file_space_id, mount_subpath, device_id, status, sandbox_backend)
          VALUES (${randomUUID()}, ${workspaceId}, ${sessionId}, ${spaceId}, 'actor', ${deviceId}, ${opts.mountStatus ?? "active"}, ${opts.mountBackend ?? "local"})`.compile(
        db
      )
    )
  }
  return serviceId
}

test("validateTunnelInternalUrl: frp edge URL with matching token is accepted", async () => {
  await withTestDb(async (db) => {
    const validate = validatorFor(db)
    const serviceId = await seedService(db, { tunnelPathToken: "tok-abc" })
    await withEdgeEnv(EDGE, async () => {
      const res = await validate(`${EDGE}/d/tok-abc`, serviceId)
      assert.deepEqual(res, { ok: true })
    })
  })
})

test("validateTunnelInternalUrl: frp edge URL with wrong token is rejected", async () => {
  await withTestDb(async (db) => {
    const validate = validatorFor(db)
    const serviceId = await seedService(db, { tunnelPathToken: "tok-abc" })
    await withEdgeEnv(EDGE, async () => {
      const res = await validate(`${EDGE}/d/tok-WRONG`, serviceId)
      assert.equal(res.ok, false)
    })
  })
})

test("validateTunnelInternalUrl: loopback accepted ONLY with a live local mount", async () => {
  await withTestDb(async (db) => {
    const validate = validatorFor(db)
    const withMount = await seedService(db, { liveLocalMount: true })
    const withoutMount = await seedService(db, { liveLocalMount: false })
    await withEdgeEnv(EDGE, async () => {
      const ok = await validate("http://127.0.0.1:45321", withMount)
      assert.deepEqual(ok, { ok: true }, "live local mount → loopback accepted")
      const no = await validate("http://127.0.0.1:45321", withoutMount)
      assert.equal(no.ok, false, "no live local mount → loopback rejected")
    })
  })
})

test("validateTunnelInternalUrl: a docker-backed mount does NOT unlock loopback", async () => {
  await withTestDb(async (db) => {
    const validate = validatorFor(db)
    const dockerSvc = await seedService(db, {
      liveLocalMount: true,
      mountBackend: "docker",
    })
    await withEdgeEnv(EDGE, async () => {
      const res = await validate("http://127.0.0.1:45321", dockerSvc)
      assert.equal(res.ok, false)
    })
  })
})

test("validateTunnelInternalUrl: a closed local mount does NOT unlock loopback", async () => {
  await withTestDb(async (db) => {
    const validate = validatorFor(db)
    const closedSvc = await seedService(db, {
      liveLocalMount: true,
      mountStatus: "closed",
    })
    await withEdgeEnv(EDGE, async () => {
      const res = await validate("http://127.0.0.1:45321", closedSvc)
      assert.equal(res.ok, false)
    })
  })
})

test("validateTunnelInternalUrl: rejects non-loopback / unsafe loopback variants", async () => {
  await withTestDb(async (db) => {
    const validate = validatorFor(db)
    const svc = await seedService(db, { liveLocalMount: true })
    await withEdgeEnv(EDGE, async () => {
      const reject = async (candidate: string, why: string) => {
        const res = await validate(candidate, svc)
        assert.equal(res.ok, false, why)
      }
      await reject(
        "http://localhost:8080",
        "localhost is not a literal loopback"
      )
      await reject("http://10.0.0.5:8080", "private IP rejected")
      await reject("http://169.254.169.254:80", "cloud metadata IP rejected")
      await reject(
        "https://127.0.0.1:8080",
        "https loopback rejected (http only)"
      )
      await reject("http://127.0.0.1:8080/d/x", "loopback with a path rejected")
      await reject("http://user:pass@127.0.0.1:8080", "credentials rejected")
      await reject("not-a-url", "garbage rejected")
    })
  })
})

test("validateTunnelInternalUrl: [::1] loopback accepted with a live local mount", async () => {
  await withTestDb(async (db) => {
    const validate = validatorFor(db)
    const svc = await seedService(db, { liveLocalMount: true })
    await withEdgeEnv(EDGE, async () => {
      const res = await validate("http://[::1]:45321", svc)
      assert.deepEqual(res, { ok: true })
    })
  })
})

test("validateTunnelInternalUrl: with no edge configured, only local loopback can register", async () => {
  await withTestDb(async (db) => {
    const validate = validatorFor(db)
    const svc = await seedService(db, { liveLocalMount: true })
    await withEdgeEnv(undefined, async () => {
      const loop = await validate("http://127.0.0.1:45321", svc)
      assert.deepEqual(loop, { ok: true }, "loopback still works without edge")
      const edge = await validate("http://tunnel-edge:8080/d/whatever", svc)
      assert.equal(
        edge.ok,
        false,
        "non-loopback rejected when no edge configured"
      )
    })
  })
})
