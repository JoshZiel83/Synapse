import test from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
  promises as fsp,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"

import {
  createLocalFsBackend,
  generateTmpToken,
  generateRestoreToken,
  GrantPrefixDeniedError,
  StaleWriteError,
  InternalTokenError,
  CanonicalPathError,
  assertHelperWorkDirOutsideRoot,
  WHOLE_SCOPE,
} from "./vfs.js"

function freshRoot(prefix = "synapse-vfs-be-"): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

test("safeResolve('/') succeeds and returns root", async () => {
  const root = freshRoot()
  try {
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    const host = await be.safeResolve("/")
    assert.equal(host, await fsp.realpath(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("safeResolve realpath grant recheck blocks in-root symlink bypass", async () => {
  const root = freshRoot()
  try {
    mkdirSync(join(root, "allowed"))
    mkdirSync(join(root, "secret"))
    writeFileSync(join(root, "secret", "leak.txt"), "secrets")
    symlinkSync(join(root, "secret"), join(root, "allowed", "link"))
    const be = createLocalFsBackend({
      rootPath: root,
      initialGrantPrefixes: ["/allowed"],
    })
    await be.start()
    writeFileSync(join(root, "allowed", "foo"), "ok")
    await be.safeResolve("/allowed/foo")
    await assert.rejects(
      () => be.safeResolve("/allowed/link/leak.txt"),
      GrantPrefixDeniedError
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("safeResolve allows in-root symlink when grant covers target", async () => {
  const root = freshRoot()
  try {
    mkdirSync(join(root, "a"))
    mkdirSync(join(root, "b"))
    writeFileSync(join(root, "b", "x"), "ok")
    symlinkSync(join(root, "b"), join(root, "a", "blink"))
    const be = createLocalFsBackend({
      rootPath: root,
      initialGrantPrefixes: ["/a", "/b"],
    })
    await be.start()
    await be.safeResolve("/a/blink/x")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("safeResolve rejects FIFO files when host supports mkfifo", async () => {
  const root = freshRoot()
  try {
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    try {
      execSync(`mkfifo ${JSON.stringify(join(root, "pipe"))}`)
    } catch {
      return
    }
    await assert.rejects(
      () => be.safeResolve("/pipe"),
      (e: unknown) =>
        e instanceof CanonicalPathError && /special file/.test(e.message)
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("safeResolve rejects existing symlink that escapes root", async () => {
  const root = freshRoot()
  const outsideDir = freshRoot("synapse-vfs-outside-")
  try {
    writeFileSync(join(outsideDir, "secret.txt"), "leak")
    symlinkSync(outsideDir, join(root, "escape"))
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    await assert.rejects(
      () => be.safeResolve("/escape/secret.txt"),
      CanonicalPathError
    )
  } finally {
    rmSync(outsideDir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test("atomicWrite tmp+rename writes data + reports sha256", async () => {
  const root = freshRoot()
  try {
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    const r = await be.atomicWrite("/file", new Uint8Array([1, 2, 3]), {})
    assert.equal(r.bytesWritten, 3)
    assert.equal(
      r.sha256,
      "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"
    )
    const back = await fsp.readFile(join(root, "file"))
    assert.deepEqual(Uint8Array.from(back), new Uint8Array([1, 2, 3]))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("atomicWrite createOnly rejects when destination exists (pre_create)", async () => {
  const root = freshRoot()
  try {
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    writeFileSync(join(root, "existing"), "x")
    await assert.rejects(
      () =>
        be.atomicWrite("/existing", new Uint8Array([9]), { createOnly: true }),
      (e: unknown) => e instanceof StaleWriteError && e.phase === "pre_create"
    )
    assert.equal((await fsp.readFile(join(root, "existing"))).toString(), "x")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("atomicWrite expectedShaForCAS rejects stale overwrite (pre_rename)", async () => {
  const root = freshRoot()
  try {
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    writeFileSync(join(root, "f"), "v1")
    const wrongSha =
      "0000000000000000000000000000000000000000000000000000000000000000"
    await assert.rejects(
      () =>
        be.atomicWrite("/f", new Uint8Array([2]), {
          expectedShaForCAS: wrongSha,
        }),
      (e: unknown) => e instanceof StaleWriteError && e.phase === "pre_rename"
    )
    assert.equal((await fsp.readFile(join(root, "f"))).toString(), "v1")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("atomicWrite expectedShaForCAS accepts matching sha", async () => {
  const root = freshRoot()
  try {
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    writeFileSync(join(root, "f"), "v1")
    const sha = await be.streamSha256("/f")
    await be.atomicWrite("/f", Buffer.from("v2"), {
      expectedShaForCAS: sha.sha256,
    })
    assert.equal((await fsp.readFile(join(root, "f"))).toString(), "v2")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("streamSha256 bounded by maxBytes", async () => {
  const root = freshRoot()
  try {
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    writeFileSync(join(root, "big"), Buffer.alloc(1024, "x"))
    const r = await be.streamSha256("/big", { maxBytes: 512 })
    assert.equal(r.sha256, null)
    assert.equal(r.truncated, true)
    assert.equal(r.size, 1024)
    const r2 = await be.streamSha256("/big", { maxBytes: 2048 })
    assert.equal(r2.truncated, false)
    assert.match(r2.sha256 as string, /^[0-9a-f]{64}$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("readBytes window + truncated", async () => {
  const root = freshRoot()
  try {
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    writeFileSync(join(root, "f"), Buffer.from("0123456789"))
    const a = await be.readBytes("/f", { startByte: 2, endByte: 5 })
    assert.equal(Buffer.from(a.bytes).toString(), "234")
    assert.equal(a.totalSize, 10)
    const b = await be.readBytes("/f", { maxBytes: 4 })
    assert.equal(Buffer.from(b.bytes).toString(), "0123")
    assert.equal(b.truncated, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("resolveInternalPath validates token format strictly", () => {
  const root = freshRoot()
  try {
    const be = createLocalFsBackend({ rootPath: root })
    const goodTmp = generateTmpToken()
    const goodRestore = generateRestoreToken()
    assert.ok(be.resolveInternalPath("tmp", goodTmp).includes(goodTmp))
    assert.ok(
      be.resolveInternalPath("restore", goodRestore).includes(goodRestore)
    )
    assert.throws(
      () => be.resolveInternalPath("tmp", "tmp-ZZ"),
      InternalTokenError
    )
    assert.throws(
      () => be.resolveInternalPath("tmp", goodRestore),
      InternalTokenError
    )
    assert.throws(
      () => be.resolveInternalPath("evil" as unknown as "tmp", goodTmp),
      InternalTokenError
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("withPathLock serializes per-path operations", async () => {
  const root = freshRoot()
  try {
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    const order: string[] = []
    const p1 = be.withPathLock("/f", async () => {
      await new Promise((r) => setTimeout(r, 30))
      order.push("a")
    })
    const p2 = be.withPathLock("/f", async () => {
      order.push("b")
    })
    await Promise.all([p1, p2])
    assert.deepEqual(order, ["a", "b"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("withGrantPrefixes scopes the realpath grant recheck", async () => {
  const root = freshRoot()
  try {
    mkdirSync(join(root, "allowed"))
    mkdirSync(join(root, "secret"))
    writeFileSync(join(root, "secret", "leak"), "x")
    symlinkSync(join(root, "secret"), join(root, "allowed", "link"))
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    await be.safeResolve("/allowed/link/leak")
    await be.withGrantPrefixes(["/allowed"], async () => {
      await assert.rejects(
        () => be.safeResolve("/allowed/link/leak"),
        GrantPrefixDeniedError
      )
    })
    await be.safeResolve("/allowed/link/leak")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("withGrantPrefixes isolates concurrent tool calls (no cross-talk)", async () => {
  const root = freshRoot()
  try {
    mkdirSync(join(root, "public"))
    mkdirSync(join(root, "secret"))
    writeFileSync(join(root, "secret", "leak"), "x")
    symlinkSync(join(root, "secret"), join(root, "public", "link"))
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    let narrowSuccess = 0
    let narrowDenied = 0
    const iterations = 30
    const narrow = async () => {
      for (let i = 0; i < iterations; i++) {
        await be.withGrantPrefixes(["/public"], async () => {
          try {
            await be.safeResolve("/public/link/leak")
            narrowSuccess += 1
          } catch (e) {
            if (e instanceof GrantPrefixDeniedError) narrowDenied += 1
          }
        })
      }
    }
    const wide = async () => {
      for (let i = 0; i < iterations; i++) {
        await be.withGrantPrefixes(["/"], async () => {
          await be.safeResolve("/public/link/leak")
        })
      }
    }
    await Promise.all([narrow(), wide()])
    assert.equal(
      narrowSuccess,
      0,
      "narrow grant scope must never see the symlink target despite concurrent wide-scope calls"
    )
    assert.equal(narrowDenied, iterations)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ─────────────────────────── S3B / F-C: WHOLE_SCOPE ──────────────────────────

test("S3B: withGrantPrefixes([]) is a structural deny-all (NOT allow-all)", async () => {
  const root = freshRoot()
  try {
    mkdirSync(join(root, "pub"))
    writeFileSync(join(root, "pub", "f"), "x")
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    // Pre-S3B this DISABLED the recheck (allow-all). Now every resolve denies.
    await be.withGrantPrefixes([], async () => {
      await assert.rejects(
        () => be.safeResolve("/pub/f"),
        GrantPrefixDeniedError,
        "an explicit empty prefix set must deny every resolve, never allow-all"
      )
      await assert.rejects(() => be.safeResolve("/"), GrantPrefixDeniedError)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("S3B: withGrantPrefixes(WHOLE_SCOPE) root-jails within-root only", async () => {
  const root = freshRoot()
  const outside = freshRoot("synapse-vfs-out-")
  try {
    mkdirSync(join(root, "pub"))
    writeFileSync(join(root, "pub", "f"), "x")
    writeFileSync(join(outside, "secret"), "s")
    // A symlink escaping the root must still be rejected under WHOLE_SCOPE
    // (the root boundary escape check is independent of the prefix recheck).
    symlinkSync(outside, join(root, "escape"))
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    await be.withGrantPrefixes(WHOLE_SCOPE, async () => {
      // within-root resolves succeed (no prefix constraint)
      await be.safeResolve("/pub/f")
      await be.safeResolve("/")
      // escaping the root via symlink is still denied (root-jail)
      await assert.rejects(
        () => be.safeResolve("/escape/secret"),
        (e: unknown) =>
          e instanceof CanonicalPathError ||
          e instanceof GrantPrefixDeniedError,
        "WHOLE_SCOPE must NOT allow escaping the sandbox root"
      )
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("S3B / A9: legit non-empty and ['/'] whole-scope grants behave byte-identically (resident hardening parity)", async () => {
  const root = freshRoot()
  try {
    mkdirSync(join(root, "conversation"))
    writeFileSync(join(root, "conversation", "note.txt"), "hello")
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    // scoped grant (non-empty prefixes) → unchanged
    await be.withGrantPrefixes(["/conversation"], async () => {
      await be.safeResolve("/conversation/note.txt")
    })
    // legit whole-scope via ['/'] array path (pre-S3B representation) → unchanged
    await be.withGrantPrefixes(["/"], async () => {
      await be.safeResolve("/conversation/note.txt")
    })
    // WHOLE_SCOPE sentinel resolves the same within-root path identically
    await be.withGrantPrefixes(WHOLE_SCOPE, async () => {
      await be.safeResolve("/conversation/note.txt")
    })
    // store-unset (no grant frame) internal op path unchanged: recheck skipped
    await be.safeResolve("/conversation/note.txt")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ─────────────────────────── S3: mkdir / move / remove ───────────────────────

test("S3: mkdir creates a directory (recursive creates parents) within the grant", async () => {
  const root = freshRoot()
  try {
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    await be.withGrantPrefixes(["/work"], async () => {
      // parent /work does not exist yet → non-recursive fails
      await assert.rejects(() => be.mkdir("/work/a", { recursive: false }))
      const r = await be.mkdir("/work/a/b", { recursive: true })
      assert.equal(r.created, true)
      const st = await be.safeStat("/work/a/b")
      assert.equal(st?.kind, "directory")
    })
    // mkdir outside the grant prefix is denied
    await be.withGrantPrefixes(["/work"], async () => {
      await assert.rejects(
        () => be.mkdir("/other", { recursive: true }),
        GrantPrefixDeniedError
      )
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("S3 / F-C: move resolves BOTH endpoints in the same grant frame (dest outside prefix denied)", async () => {
  const root = freshRoot()
  try {
    mkdirSync(join(root, "allowed"))
    mkdirSync(join(root, "secret"))
    writeFileSync(join(root, "allowed", "src.txt"), "payload")
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    // happy path: src + dest both under the grant
    await be.withGrantPrefixes(["/allowed"], async () => {
      await be.move("/allowed/src.txt", "/allowed/dst.txt", {})
      assert.equal((await be.safeStat("/allowed/dst.txt"))?.kind, "file")
      assert.equal(await be.safeStat("/allowed/src.txt"), null)
    })
    // F-C: dest outside the granted prefix must be DENIED even though src is in.
    writeFileSync(join(root, "allowed", "src2.txt"), "p2")
    await be.withGrantPrefixes(["/allowed"], async () => {
      await assert.rejects(
        () => be.move("/allowed/src2.txt", "/secret/exfil.txt", {}),
        GrantPrefixDeniedError,
        "dest outside the grant frame cannot be authorized by a src-in-grant move"
      )
    })
    // src still present (move aborted before rename)
    assert.equal((await be.safeStat("/allowed/src2.txt"))?.kind, "file")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("S3: move honors expected_source_sha + overwrite guard", async () => {
  const root = freshRoot()
  try {
    mkdirSync(join(root, "w"))
    writeFileSync(join(root, "w", "a"), "content-a")
    writeFileSync(join(root, "w", "b"), "content-b")
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    await be.withGrantPrefixes(["/w"], async () => {
      // wrong source sha → StaleWriteError (nothing moved)
      await assert.rejects(
        () => be.move("/w/a", "/w/c", { expectedSourceSha: "deadbeef" }),
        StaleWriteError
      )
      assert.equal((await be.safeStat("/w/a"))?.kind, "file")
      // overwrite:false onto an existing dest → deny
      await assert.rejects(
        () => be.move("/w/a", "/w/b", { overwrite: false }),
        StaleWriteError
      )
      // overwrite:true succeeds
      await be.move("/w/a", "/w/b", { overwrite: true })
      assert.equal(await be.safeStat("/w/a"), null)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("S3: remove deletes a file/subtree within the grant, denies outside", async () => {
  const root = freshRoot()
  try {
    mkdirSync(join(root, "w"))
    mkdirSync(join(root, "w", "sub"))
    writeFileSync(join(root, "w", "sub", "x"), "x")
    mkdirSync(join(root, "keep"))
    writeFileSync(join(root, "keep", "y"), "y")
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    await be.withGrantPrefixes(["/w"], async () => {
      // non-recursive remove of a non-empty dir fails
      await assert.rejects(() => be.remove("/w/sub", { recursive: false }))
      await be.remove("/w/sub", { recursive: true })
      assert.equal(await be.safeStat("/w/sub"), null)
      // removing outside the grant prefix is denied
      await assert.rejects(
        () => be.remove("/keep/y", { recursive: false }),
        GrantPrefixDeniedError
      )
    })
    assert.equal((await be.safeStat("/keep/y"))?.kind, "file")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("start rejects when /.synapse-internal is a pre-existing symlink", async () => {
  const root = freshRoot()
  try {
    // Pre-place a symlink at the reserved name pointing to a sibling
    // in-root directory. Without the lstat check, runtime would happily
    // mkdir-through it and stage tmp files there, where list_dir/fs_read
    // could see them via the alias.
    const aliasTarget = freshRoot("synapse-alias-")
    symlinkSync(aliasTarget, join(root, ".synapse-internal"))
    const be = createLocalFsBackend({ rootPath: root })
    await assert.rejects(
      () => be.start(),
      /reserved internal namespace must be a real directory|reserved namespace must not alias/
    )
    rmSync(aliasTarget, { recursive: true, force: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("start rejects when /.synapse-internal/tmp is a symlink to another in-root dir", async () => {
  const root = freshRoot()
  try {
    mkdirSync(join(root, "public"))
    mkdirSync(join(root, ".synapse-internal"))
    // Symlink tmp into a list-visible directory.
    symlinkSync(join(root, "public"), join(root, ".synapse-internal", "tmp"))
    const be = createLocalFsBackend({ rootPath: root })
    await assert.rejects(
      () => be.start(),
      /reserved internal namespace must be a real directory|must not alias/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("list root excludes /.synapse-internal directory entry", async () => {
  const root = freshRoot()
  try {
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    writeFileSync(join(root, "visible.txt"), "yes")
    const entries = await be.list("/")
    const names = entries.map((e) => e.name).sort()
    assert.deepEqual(names, ["visible.txt"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("assertHelperWorkDirOutsideRoot fails when work-dir is under root", async () => {
  const root = freshRoot()
  try {
    await assert.rejects(
      () => assertHelperWorkDirOutsideRoot(root, join(root, "fs-work")),
      /must not live under rootPath/
    )
    await assert.rejects(
      () => assertHelperWorkDirOutsideRoot(root, root),
      /must not live under rootPath/
    )
    // Separate dir is fine.
    const outside = freshRoot("synapse-fs-work-")
    try {
      await assertHelperWorkDirOutsideRoot(root, outside)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
