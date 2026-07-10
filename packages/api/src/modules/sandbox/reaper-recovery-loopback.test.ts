// P2 correctness pins for the control-path resolver + reaper + loopback:
//   (b) RECOVERY (S9/CORRECTION 5): a 'failed' sandbox row still resolves a ref
//       (state-agnostic) so isSandboxRuntimeAlive reports ALIVE ⇒ a live runtime
//       is killed before a recovery commit snapshots a dir under active write.
//   (c) REAPER-SURVIVAL: healthy docker sessions survive reconcile+reap via the REAL
//       listReconcileCandidateSessionIds + REAL buildSandboxRefFromSandboxRow with an
//       EMPTY liveSandboxHandles map. Only the LOWEST docker seam (inspect/ps) stubbed.
//   (d) PRE-BOOTSTRAP ORPHAN: a labeled container with NO sandboxes row (live mount,
//       sandbox_id NULL) is reaped even when the current provider is not docker.
//   UNION-superset: candidate set = live-mount arm ∪ live-sandbox arm.
//   (f) LOOPBACK (S7/CORRECTION 6): a device-less local sandbox's endpoint is
//       accepted by validateTunnelInternalUrl → hasLiveLocalSandboxMount
//       (re-keyed to the sandboxes row).

import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import { sql } from "kysely"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import {
  getSandboxById,
  getLiveSandboxBySession,
  listReconcileCandidateSessionIds,
  hasDockerMountHistory,
} from "./repo.js"
import { insertFileMount, updateFileMount } from "./repo-space.js"
import type { FileMountRow } from "./repo-space.js"
import {
  mintLocalSandboxRuntimeTx,
  hasLiveLocalSandboxMount,
} from "../devices/repo.js"
import { validateTunnelInternalUrl } from "../devices/control-plane.js"
import { reapDockerSandboxOrphans } from "./docker-sandbox-backend.js"
import { isSandboxRuntimeAlive, reconcileSandboxes } from "./service.js"

function rid(): string {
  return Math.random().toString(36).slice(2, 10)
}

// A fake `docker` CLI seam: records argv, scripts stdout per subcommand.
function fakeDocker(
  handler: (args: string[]) => {
    stdout?: string
    stderr?: string
    code?: number
  }
) {
  const calls: string[][] = []
  const spawnImpl = ((_cmd: string, args: string[]) => {
    calls.push(args)
    const res = handler(args)
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    setImmediate(() => {
      if (res.stdout) child.stdout.emit("data", Buffer.from(res.stdout))
      if (res.stderr) child.stderr.emit("data", Buffer.from(res.stderr))
      child.emit("exit", res.code ?? 0)
    })
    return child
  }) as never
  return { spawnImpl, calls }
}

async function seedSession(db: Kysely<any>): Promise<{
  workspaceId: string
  actorId: string
  conversationId: string
  sessionId: string
  fileSpaceId: string
}> {
  const user = await db
    .insertInto("users")
    .values({ email: `${rid()}@rrl`, name: "u" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({ ownerId: user.id, slug: `ws-${rid()}`, name: "rrl ws" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const workspaceId = ws.id as string
  const subjectId = (
    await db
      .insertInto("accessSubjects")
      .values({ kind: "workspace", workspaceId } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id as string
  const actorRoot = await db
    .insertInto("workspaceResources")
    .values({
      id: randomUUID(),
      workspaceId,
      kind: "actor",
      displayName: `a-${rid()}`,
      status: "active",
      createdBySubjectId: subjectId,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  await db
    .insertInto("actors")
    .values({
      id: actorRoot.id as string,
      role: "assistant",
      title: "t",
      currentVersion: 1,
    } as any)
    .execute()
  const conv = await db
    .insertInto("conversations")
    .values({ workspaceId, kind: "direct", title: "t" } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const session = await db
    .insertInto("sessions")
    .values({
      workspaceId,
      conversationId: conv.id,
      actorId: actorRoot.id,
      status: "running",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  // A file_space for the mount (owner=actor).
  const space = await db
    .insertInto("fileSpaces")
    .values({
      id: randomUUID(),
      workspaceId,
      ownerSubjectId: subjectId,
      namespaceKey: "default",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return {
    workspaceId,
    actorId: actorRoot.id as string,
    conversationId: conv.id as string,
    sessionId: session.id as string,
    fileSpaceId: space.id as string,
  }
}

/** Insert a device-less sandbox-kind runtime (runtimes + sandboxes) with an
 *  explicit adapter/state/resource_id (raw so state can be terminal). */
async function insertSandboxRuntime(
  db: Kysely<any>,
  args: {
    workspaceId: string
    sessionId: string | null
    adapter: string
    state: string
    resourceId?: string
  }
): Promise<string> {
  const runtimeId = randomUUID()
  await db
    .insertInto("runtimes")
    .values({ id: runtimeId, workspaceId: args.workspaceId, kind: "sandbox" })
    .execute()
  await sql`
    INSERT INTO sandboxes (id, workspace_id, session_id, mode, adapter, state, resource_id, host_pid)
    VALUES (${runtimeId}, ${args.workspaceId}, ${args.sessionId}, 'resident', ${args.adapter}, ${args.state}::sandboxes_state, ${args.resourceId ?? ""}, NULL)`.execute(
    db
  )
  return runtimeId
}

async function insertActiveMount(
  db: Kysely<any>,
  seed: { workspaceId: string; sessionId: string; fileSpaceId: string },
  patch: { sandboxId?: string } = {}
): Promise<FileMountRow> {
  const mount = await insertFileMount(db as any, {
    workspaceId: seed.workspaceId,
    sessionId: seed.sessionId,
    fileSpaceId: seed.fileSpaceId,
    mountSubpath: "conversation",
    baseSnapshotId: null,
  })
  await updateFileMount(db as any, mount.id, {
    status: "active",
    // P3: the mount's sole identity is sandbox_id → the owning sandboxes row.
    sandboxId: patch.sandboxId ?? null,
  })
  return mount
}

// ── (b) RECOVERY: a 'failed' sandbox still resolves a ref (state-agnostic) ────

test("(b) recovery: a 'failed' sandbox row resolves a ref (state-agnostic) ⇒ isSandboxRuntimeAlive ALIVE", async () => {
  await withTestDb(async (db) => {
    const seed = await seedSession(db)
    const runtimeId = await insertSandboxRuntime(db, {
      workspaceId: seed.workspaceId,
      sessionId: seed.sessionId,
      adapter: "docker",
      state: "failed",
      resourceId: "cid-fail",
    })

    // State-agnostic control-path lookup resolves the FAILED row…
    const byId = await getSandboxById(runtimeId, db)
    assert.ok(
      byId,
      "getSandboxById resolves a 'failed' sandbox (no state filter)"
    )
    assert.equal(byId!.state, "failed")
    // …while the state-filtered reuse lookup does NOT.
    const live = await getLiveSandboxBySession(seed.sessionId, db)
    assert.equal(
      live,
      null,
      "getLiveSandboxBySession excludes a 'failed' sandbox"
    )

    // The still-running runtime is detected ALIVE via the state-agnostic resolver
    // (stub ONLY the docker inspect seam → container running).
    const docker = fakeDocker((a) =>
      a[0] === "inspect" ? { stdout: "true\n" } : { stdout: "" }
    )
    const mounts = [
      {
        sessionId: seed.sessionId,
        sandboxId: runtimeId,
      } as unknown as FileMountRow,
    ]
    const alive = await isSandboxRuntimeAlive(mounts, {
      run: db as any,
      dockerSpawnImpl: docker.spawnImpl,
    })
    assert.equal(
      alive,
      true,
      "a failed sandbox with a live container reports ALIVE"
    )
    assert.ok(
      docker.calls.some((c) => c[0] === "inspect" && c.includes("cid-fail")),
      "resolved the container id from the failed sandbox row"
    )
  })
})

// ── UNION-superset: candidate set = live-mount ∪ live-sandbox ─────────────────

test("UNION-superset: candidates = mount-bearing session ∪ mount-less sandbox session", async () => {
  await withTestDb(async (db) => {
    // sess-A: a live sandboxes row + an active mount (the mount-arm candidate).
    const a = await seedSession(db)
    const runtimeA = await insertSandboxRuntime(db, {
      workspaceId: a.workspaceId,
      sessionId: a.sessionId,
      adapter: "docker",
      state: "active",
      resourceId: "cid-A",
    })
    await insertActiveMount(db, a, { sandboxId: runtimeA })
    // sess-C: a live sandboxes row, NO file_mount (the sandbox-arm candidate — a
    // mount-less sandbox is invisible to a mount-only scan).
    const c = await seedSession(db)
    await insertSandboxRuntime(db, {
      workspaceId: c.workspaceId,
      sessionId: c.sessionId,
      adapter: "docker",
      state: "active",
      resourceId: "cid-C",
    })

    const ids = await listReconcileCandidateSessionIds(db)
    assert.ok(ids.includes(a.sessionId), "mount-arm session included")
    assert.ok(
      ids.includes(c.sessionId),
      "sandbox-arm (mount-less) session included"
    )
    assert.equal(await hasDockerMountHistory(db), true)
  })
})

// ── (c) REAPER-SURVIVAL: both docker sessions survive reconcile+reap ──────────

test("(c) reaper-survival: healthy docker sessions survive reconcile+reap", async () => {
  await withTestDb(async (db) => {
    // Fixture A — live sandboxes row + active mount (sandbox_id).
    const a = await seedSession(db)
    const runtimeA = await insertSandboxRuntime(db, {
      workspaceId: a.workspaceId,
      sessionId: a.sessionId,
      adapter: "docker",
      state: "active",
      resourceId: "cid-A",
    })
    await insertActiveMount(db, a, { sandboxId: runtimeA })
    // Fixture B — live sandboxes row + active mount (sandbox_id).
    const b = await seedSession(db)
    const runtimeB = await insertSandboxRuntime(db, {
      workspaceId: b.workspaceId,
      sessionId: b.sessionId,
      adapter: "docker",
      state: "active",
      resourceId: "cid-B",
    })
    await insertActiveMount(db, b, { sandboxId: runtimeB })

    // Lowest seam ONLY: inspect → running; ps → both labeled containers.
    const psLine = `cid-A ${a.sessionId}\ncid-B ${b.sessionId}\n`
    const docker = fakeDocker((args) => {
      if (args[0] === "inspect") return { stdout: "true\n" }
      if (args[0] === "ps") return { stdout: psLine }
      return { stdout: "" }
    })

    const captured: { live?: Set<string> } = {}
    await reconcileSandboxes({
      executor: db as any,
      dockerSpawnImpl: docker.spawnImpl,
      // Wrap the REAL reap only to capture the live set it is handed.
      reap: (live) => {
        captured.live = live
        return reapDockerSandboxOrphans(live, { spawnImpl: docker.spawnImpl })
      },
    })

    assert.ok(captured.live, "reap ran")
    assert.ok(
      captured.live.has(a.sessionId) && captured.live.has(b.sessionId),
      "BOTH sessions in the reaper shield (derived via the REAL resolver)"
    )
    assert.ok(
      !docker.calls.some((c) => c[0] === "rm"),
      "no container was rm'd — both healthy sessions survived"
    )
  })
})

// ── (d) PRE-BOOTSTRAP ORPHAN: reaped even after flip-to-local (P3d regression) ─

test("(d) a pre-bootstrap docker orphan (live mount, NO sandboxes row) is reaped even when the current provider is not docker", async () => {
  await withTestDb(async (db) => {
    // The API `docker run`+LABELED a container, then crashed BEFORE the bootstrap
    // consume minted the sandboxes row: a live 'provisioning' mount with sandbox_id
    // STILL NULL, and NO sandboxes row. Operator restarts with provider≠docker.
    const orphan = await seedSession(db)
    await insertFileMount(db as any, {
      workspaceId: orphan.workspaceId,
      sessionId: orphan.sessionId,
      fileSpaceId: orphan.fileSpaceId,
      mountSubpath: "conversation",
      baseSnapshotId: null,
    })

    // The reap gate must fire via hasDockerMountHistory's live-mount arm — arm (1)
    // (sandboxes.adapter='docker') is blind here (no sandboxes row was ever minted).
    assert.equal(
      await hasDockerMountHistory(db),
      true,
      "a live mount with NULL sandbox_id trips the reap gate (pre-bootstrap fingerprint)"
    )

    // The labeled orphan container is running; the current provider is NOT docker.
    const docker = fakeDocker((args) => {
      if (args[0] === "ps")
        return { stdout: `cid-orphan ${orphan.sessionId}\n` }
      return { stdout: "" }
    })
    await reconcileSandboxes({
      executor: db as any,
      dockerSpawnImpl: docker.spawnImpl,
      reap: (live) =>
        reapDockerSandboxOrphans(live, { spawnImpl: docker.spawnImpl }),
    })
    // The orphan's mounts were torn down (not in liveSessionIds) AND its labeled
    // container was rm'd — the leak the P3d narrowing had reintroduced.
    assert.ok(
      docker.calls.some((c) => c[0] === "rm" && c.includes("cid-orphan")),
      "pre-bootstrap orphan container is reaped despite the flip-to-local"
    )
  })
})

// ── (f) LOOPBACK: a device-less local sandbox's endpoint is accepted ──────────

test("(f) loopback: a device-less local sandbox is accepted by hasLiveLocalSandboxMount + validateTunnelInternalUrl", async () => {
  await withTestDb(async (db) => {
    const seed = await seedSession(db)
    const minted = await mintLocalSandboxRuntimeTx({
      runtimeId: randomUUID(),
      workspaceId: seed.workspaceId,
      sessionId: seed.sessionId,
      serviceId: randomUUID(),
      serviceKeyId: randomUUID(),
      servicePubkey: "svc-pubkey-pem",
      serviceFingerprint: `sfp-${rid()}`,
      adapter: "local",
      mode: "resident",
      executor: db as any,
    })

    // hasLiveLocalSandboxMount resolves via the sandboxes row (NOT file_mounts).
    assert.equal(
      await hasLiveLocalSandboxMount(minted.serviceId, db as any),
      true,
      "device-less local sandbox has a live local mount (re-keyed to sandboxes)"
    )

    // The loopback endpoint is accepted (frp edge unset in test → loopback path).
    const result = await validateTunnelInternalUrl({
      candidate: "http://127.0.0.1:12345",
      runtimeServiceId: minted.serviceId,
      executor: db as any,
    })
    assert.deepEqual(result, { ok: true, reach: "direct" })
  })
})
