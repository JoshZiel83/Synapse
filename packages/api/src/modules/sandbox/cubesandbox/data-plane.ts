// OFF-BOX (cubesandbox:bare) DATA PLANE (§4.7 / P4b). Implements SandboxDataPlane
// over the CubeSandbox envd wire client — the confined tool surface a REMOTE
// sandbox VM exposes, in place of the host-side buildConfinedHostFs used by
// local:bare / docker:bare.
//
// THE SECURITY CORE = path confinement WITHOUT realpath. The API cannot realpath a
// remote filesystem, so confinement here is LEXICAL and the VM is the isolation
// boundary. For every path arg we:
//   1. canonicalVfsPath(path) — the SAME canonicalizer the host planes use. It
//      normalizes `..`, rejects backslash/colon/DOS names + the reserved
//      /.synapse-internal namespace, and collapses `..`-escapes so an attempted
//      escape resolves to a path that then fails the scope check below
//      (CanonicalPathError → invalid_request).
//   2. ctx.scope confinement (the SAME semantics buildConfinedHostFs applies via
//      backend.withGrantPrefixes, but enforced LEXICALLY, not via realpath): a
//      scoped grant (string[] prefixes) MUST have the canonical path under one of
//      its prefixes; WHOLE_SCOPE = under any MOUNT_ROOTS entry; an empty scope can
//      never reach here (deriveConfinementScope hard-denies it upstream). A path
//      outside the grant throws GrantPrefixDeniedError → permission_denied.
//   3. lower the canonical VFS path to the in-sandbox absolute path
//      `${vmRoot}${canonical}` (vmRoot default /workspace). envd result paths are
//      back-translated (VM root stripped) so no `/workspace/...` leaks to the model.
//
// Cube envd quirks handled: exec exitCode omitted when 0 (client normalizes);
// MakeDir on an existing dir → 409 already_exists (mapped to created:false, NOT an
// error); writeFile auto-creates parents + is a truncating whole-file replace (NOT
// atomic — descriptor.core.atomicWrite:false); GET /files supports Range; a
// nonexistent command → exit 127 in-band.

import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { SANDBOX_MOUNT_POINTS } from "@synapse/shared"
import {
  canonicalVfsPath,
  pathUnderPrefix,
  WHOLE_SCOPE,
  GrantPrefixDeniedError,
  StaleWriteError,
} from "@synapse/device-runtime"
import { fromExternalRfc3339 } from "@synapse/device-protocol/instant"
import {
  GrantAccessDeniedError,
  CapabilityUnsupportedError,
  PlaneCapError,
  PlaneDisposedError,
  type ConfinementCtx,
  type ConfinementScope,
  type SandboxDataPlane,
  type SandboxExecPayload,
  type SandboxExecResult,
  type SandboxFileStat,
} from "../data-plane.js"
import type { SandboxCapabilityDescriptor } from "../model.js"
import { CubeEnvdError, CubeEnvdNotFoundError } from "./types.js"
import type {
  ExecOptions,
  ExecRequest,
  ExecResult,
  FileEntry,
  FileType,
  ReadFileOptions,
  WriteFileOptions,
} from "./types.js"

/** Mount roots a WHOLE_SCOPE grant is confined to (== SANDBOX_MOUNT_POINTS). */
const MOUNT_ROOTS: readonly string[] = [...SANDBOX_MOUNT_POINTS]

/** Default remote exec deadline when the caller supplies none. */
const DEFAULT_REMOTE_EXEC_TIMEOUT_MS = 60_000

/** Upper bound teardown waits for in-flight fs ops / exec calls to settle (R3.7). */
const PLANE_DRAIN_TIMEOUT_MS = 5_000

/** Grace window dispose() gives the graceful envd close() before FORCE-closing the
 *  dispatcher (m7b) — bounds teardown so a request hung near its per-request timeout
 *  cannot make close() (which awaits in-flight requests) block past the drain budget. */
const ENVD_CLOSE_GRACE_MS = 1_000

/**
 * The subset of the CubeEnvdClient the plane consumes. Declared structurally so a
 * unit test can inject a stub (no network) and CubeEnvdClient satisfies it verbatim.
 */
export interface RemoteEnvdTransport {
  exec(request: ExecRequest, options?: ExecOptions): Promise<ExecResult>
  writeFile(
    path: string,
    bytes: Uint8Array,
    options?: WriteFileOptions
  ): Promise<FileEntry[]>
  readFile(path: string, options?: ReadFileOptions): Promise<Buffer>
  stat(path: string): Promise<FileEntry>
  listDir(path: string): Promise<FileEntry[]>
  makeDir(path: string): Promise<FileEntry>
  move(source: string, destination: string): Promise<FileEntry>
  remove(path: string): Promise<void>
  close(): Promise<void>
  /** FORCE-close the transport, aborting in-flight requests (undici Agent.destroy()).
   *  Optional so a test stub need not implement it — the plane's bounded teardown
   *  falls back to the (already time-boxed) close() when it is absent. */
  destroy?(): Promise<void>
}

export interface RemoteBareDataPlaneOptions {
  /** The cube sandbox id (== sandboxes.resource_id). */
  sandboxID: string
  descriptor: SandboxCapabilityDescriptor
  /** In-sandbox absolute root the VFS maps onto (SANDBOX_VM_ROOT; default /workspace). */
  vmRoot: string
  /** The envd data-plane transport (a CubeEnvdClient in prod; a stub in tests). */
  envd: RemoteEnvdTransport
  /** Default remote exec timeout when the caller supplies none (ms). */
  defaultExecTimeoutMs?: number
}

// ─────────────────────────── pure path helpers ───────────────────────────────

/** Strip trailing slashes from the VM root ("/workspace/" → "/workspace"). */
export function trimTrailingSlash(p: string): string {
  const trimmed = p.replace(/\/+$/, "")
  return trimmed === "" ? "/" : trimmed
}

/** Lower a canonical VFS path ("/conversation/x") to the in-VM absolute path
 *  ("${vmRoot}/conversation/x"). canonical always begins with "/". */
export function vfsToVm(canonical: string, vmRoot: string): string {
  const root = trimTrailingSlash(vmRoot)
  if (canonical === "/") return root
  return root === "/" ? canonical : `${root}${canonical}`
}

/** Back-translate an envd-returned in-VM absolute path to a VFS path (strip the VM
 *  root). A path NOT under the VM root returns `fallback` so `/workspace/...` (or a
 *  bare/relative envd path) never leaks to the model. */
export function vmToVfs(
  vmPath: string,
  vmRoot: string,
  fallback: string
): string {
  const root = trimTrailingSlash(vmRoot)
  if (vmPath === root) return "/"
  if (root === "/") return vmPath.startsWith("/") ? vmPath : fallback
  if (vmPath.startsWith(`${root}/`)) return vmPath.slice(root.length)
  return fallback
}

/** Join a canonical VFS dir with a child name into a canonical VFS path. */
function joinVfs(canonicalDir: string, name: string): string {
  if (canonicalDir === "/") return `/${name}`
  return `${canonicalDir}/${name}`
}

/** Strip the in-VM root PREFIX from every occurrence in a message so an envd error
 *  string (e.g. `filesystem Stat failed: … /workspace/conversation/x`) never leaks
 *  the raw `${vmRoot}/...` path to the model — `/workspace/conversation/x` becomes
 *  the canonical `/conversation/x`. Best-effort textual scrub at the confinement
 *  boundary; the lookahead keeps a sibling like `/workspaces` intact. */
function stripVmRoot(message: string, vmRoot: string): string {
  const root = trimTrailingSlash(vmRoot)
  if (root === "/" || root === "") return message
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return message.replace(new RegExp(`${escaped}(?=[/\\s"')\\]]|$)`, "g"), "")
}

/** Sanitize a thrown error's message IN PLACE (preserving its TYPE, so the internal
 *  CubeEnvdNotFoundError / StaleWriteError mapping is unaffected) by stripping the
 *  in-VM root prefix. Returns the same error for rethrow. */
function sanitizeVmRootInError(err: unknown, vmRoot: string): unknown {
  if (err instanceof Error) {
    err.message = stripVmRoot(err.message, vmRoot)
  }
  return err
}

/** Map an envd FileType to the SandboxFileStat kind vocabulary. */
function fileTypeToKind(
  type: FileType
): "file" | "directory" | "symlink" | "other" {
  switch (type) {
    case "file":
      return "file"
    case "directory":
      return "directory"
    case "symlink":
      return "symlink"
    default:
      return "other"
  }
}

/** Parse an external RFC-3339 timestamp (envd modifiedTime, control-plane
 *  startedAt, …) into epoch-ms. Routes through the canonical fail-loud parser
 *  (never a bare Date.parse); an absent/unparseable value becomes 'absent'
 *  (undefined) — NEVER a fabricated now (datetime discipline). */
export function rfc3339ToEpochMs(
  value: string | undefined
): number | undefined {
  if (!value) return undefined
  try {
    const ms = new Date(fromExternalRfc3339(value)).getTime()
    return Number.isFinite(ms) ? ms : undefined
  } catch {
    return undefined
  }
}

// ─────────────────────────── confinement (LEXICAL) ───────────────────────────

/**
 * Enforce ctx.scope confinement on an ALREADY-canonical VFS path — the off-box
 * mirror of buildConfinedHostFs's `withGrantPrefixes(ctx.scope, …)` realpath
 * recheck, done LEXICALLY because a remote fs cannot be realpath'd. A scoped grant
 * (non-empty prefix array) requires the path under one of its prefixes; WHOLE_SCOPE
 * requires it under one of the mount roots. An empty scope can never arrive here
 * (deriveConfinementScope hard-denies it upstream). Throws GrantPrefixDeniedError
 * (→ permission_denied) on a path outside the grant — the SAME error type/mapping
 * the host planes raise, so the model sees identical taxonomy.
 */
function assertUnderScope(canonical: string, scope: ConfinementScope): void {
  const prefixes = scope === WHOLE_SCOPE ? MOUNT_ROOTS : scope
  for (const prefix of prefixes) {
    if (pathUnderPrefix(canonical, prefix)) return
  }
  throw new GrantPrefixDeniedError(canonical)
}

/**
 * The confine-and-lower primitive every path arg flows through: canonicalize
 * (rejects escapes/reserved), enforce ctx.scope (lexical prefix confine), then lower
 * to the in-VM absolute path. Returns BOTH so callers surface the canonical VFS path
 * to the model but dial envd with the VM path.
 */
function lower(
  path: string,
  ctx: ConfinementCtx,
  vmRoot: string
): { canonical: string; vm: string } {
  const canonical = canonicalVfsPath(path)
  assertUnderScope(canonical, ctx.scope)
  return { canonical, vm: vfsToVm(canonical, vmRoot) }
}

/** Fail-closed write-access assertion for the mutating plane methods (mirrors the
 *  host plane's assertWriteAccess; a read-only grant must never mutate). */
function assertWriteAccess(ctx: ConfinementCtx): void {
  if (ctx.access !== "write") {
    throw new GrantAccessDeniedError()
  }
}

// ─────────────────────────── the remote plane ────────────────────────────────

/**
 * Build the off-box data plane for a cubesandbox:bare runtime over a CubeEnvdClient.
 * Mirrors the R3 lifecycle machinery of the host planes: a disposed-guard + in-flight
 * fs counter (drained by awaitFsIdle) and a separate exec counter (drained by
 * awaitExecIdle) so teardown stays consistent with R3.7 (drain before the commit).
 * There is no host child to abort — dispose() only awaits in-flight remote calls to
 * settle, then releases the pooled envd dispatcher.
 */
export function createRemoteBareDataPlane(
  opts: RemoteBareDataPlaneOptions
): SandboxDataPlane {
  const { envd, vmRoot } = opts
  const caps = opts.descriptor.core
  const execTimeoutDefault =
    opts.defaultExecTimeoutMs ?? DEFAULT_REMOTE_EXEC_TIMEOUT_MS

  // R3.3 (disposed-guard) + R3.7 (drain). `disposed` fails NEW ops closed the instant
  // teardown fires; the in-flight counters let dispose() AWAIT outstanding remote
  // calls to settle before it releases the dispatcher — the same one-synchronous-span
  // disposed-check + increment the host plane uses (no await between them).
  let disposed = false
  let fsInflight = 0
  let fsIdleResolvers: Array<() => void> = []
  let execInflight = 0
  let execIdleResolvers: Array<() => void> = []

  function drain(
    getCount: () => number,
    pushResolver: (r: () => void) => void,
    timeoutMs: number
  ): Promise<void> {
    if (getCount() === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      pushResolver(done)
    })
  }
  function noteFsSettled(): void {
    if (fsInflight === 0 && fsIdleResolvers.length > 0) {
      const resolvers = fsIdleResolvers
      fsIdleResolvers = []
      for (const r of resolvers) r()
    }
  }
  function noteExecSettled(): void {
    if (execInflight === 0 && execIdleResolvers.length > 0) {
      const resolvers = execIdleResolvers
      execIdleResolvers = []
      for (const r of resolvers) r()
    }
  }
  function awaitFsIdle(timeoutMs: number): Promise<void> {
    return drain(
      () => fsInflight,
      (r) => fsIdleResolvers.push(r),
      timeoutMs
    )
  }
  function awaitExecIdle(timeoutMs: number): Promise<void> {
    return drain(
      () => execInflight,
      (r) => execIdleResolvers.push(r),
      timeoutMs
    )
  }
  /** disposed-check + fsInflight++ in ONE synchronous span; decrement in finally. */
  function guardedFsOp<T>(fn: () => Promise<T>): Promise<T> {
    if (disposed) {
      return Promise.reject(
        new PlaneDisposedError("sandbox data plane has been torn down")
      )
    }
    fsInflight += 1
    return fn()
      .catch((err: unknown) => {
        // m3: strip the in-VM root prefix from any surfaced fs-op error message so an
        // envd error that flows through the generic mapPlaneError branch never leaks
        // `/workspace/...` to the model. Mutating the message in place preserves the
        // error TYPE (the internal 404/CubeEnvdNotFoundError paths are handled inside
        // rawFs BEFORE this catch, so they are unaffected).
        throw sanitizeVmRootInError(err, vmRoot)
      })
      .finally(() => {
        fsInflight -= 1
        noteFsSettled()
      })
  }

  /** Best-effort in-VM mtime (advisory posture; envd carries no sha). This is only
   *  called right AFTER a write, for the REQUIRED `mtimeMs` return field: when envd
   *  omits a parseable mtime, the mutation time (≈now) is the honest advisory value
   *  — the file WAS just modified — not a value-masking fallback for a real value. */
  async function bestEffortMtimeMs(vm: string): Promise<number> {
    try {
      const st = await envd.stat(vm)
      // datetime-ok: envd omitted a parseable mtime; the write just occurred, so ≈now.
      return rfc3339ToEpochMs(st.modifiedTime) ?? Date.now()
    } catch {
      // datetime-ok: stat failed post-write; the write just occurred, so ≈now.
      return Date.now()
    }
  }

  const rawFs = {
    async stat(path: string, ctx: ConfinementCtx): Promise<SandboxFileStat> {
      const { canonical, vm } = lower(path, ctx, vmRoot)
      try {
        const e = await envd.stat(vm)
        return {
          path: canonical,
          exists: true,
          kind: fileTypeToKind(e.type),
          size: e.size,
          mtimeMs: rfc3339ToEpochMs(e.modifiedTime),
          isSymlink: e.type === "symlink",
        }
      } catch (err) {
        if (err instanceof CubeEnvdNotFoundError) {
          return { path: canonical, exists: false }
        }
        throw err
      }
    },
    async list(
      path: string,
      ctx: ConfinementCtx
    ): Promise<
      Array<{ name: string; path: string; kind: string; size?: number }>
    > {
      const { canonical, vm } = lower(path, ctx, vmRoot)
      const entries = await envd.listDir(vm)
      return entries.map((e) => ({
        name: e.name,
        // Back-translate the VM path → VFS; fall back to composing from the
        // requested canonical dir + name so `/workspace/...` never leaks.
        path: vmToVfs(e.path, vmRoot, joinVfs(canonical, e.name)),
        kind: fileTypeToKind(e.type),
        size: e.size,
      }))
    },
    async read(
      path: string,
      readOpts: { maxBytes?: number; startByte?: number; endByte?: number },
      ctx: ConfinementCtx
    ): Promise<{ bytes: Uint8Array; totalSize: number; truncated: boolean }> {
      // Capability gate (Layer 2, defense-in-depth over the CORE gate): a byte
      // window under !rangeRead is unsupported. cube sets rangeRead:true.
      if (
        !caps.rangeRead &&
        (readOpts.startByte !== undefined || readOpts.endByte !== undefined)
      ) {
        throw new CapabilityUnsupportedError(
          "range read (start_byte/end_byte) is not supported by this sandbox"
        )
      }
      const { vm } = lower(path, ctx, vmRoot)
      const cap = Math.min(
        readOpts.maxBytes ?? caps.maxReadBytes,
        caps.maxReadBytes
      )
      // The byte stream carries no length, so stat for the authoritative total.
      const st = await envd.stat(vm)
      const totalSize = st.size ?? 0
      const start = readOpts.startByte ?? 0
      if (totalSize <= 0 || start >= totalSize) {
        return { bytes: new Uint8Array(0), totalSize, truncated: false }
      }
      const lastIndex = totalSize - 1
      const requestedEnd =
        readOpts.endByte !== undefined
          ? Math.min(readOpts.endByte, lastIndex)
          : lastIndex
      if (requestedEnd < start) {
        return { bytes: new Uint8Array(0), totalSize, truncated: false }
      }
      const availableLen = requestedEnd - start + 1
      const cappedLen = Math.min(availableLen, cap)
      const truncated = cappedLen < availableLen
      const endInclusive = start + cappedLen - 1
      const buf = await envd.readFile(vm, {
        range: { start, end: endInclusive },
      })
      // Defensive slice: the server may return a wider window than requested.
      const bytes = new Uint8Array(buf.subarray(0, cappedLen))
      return { bytes, totalSize, truncated }
    },
    async write(
      path: string,
      bytes: Uint8Array,
      writeOpts: {
        createParents?: boolean
        expectedSha256?: string | null
        expectedMtimeMs?: number | null
      },
      ctx: ConfinementCtx
    ): Promise<{ sha256: string; bytesWritten: number; mtimeMs: number }> {
      assertWriteAccess(ctx)
      // envd auto-creates parents, so create_parents is always honorable (mkdir cap
      // is true for cube); mirror the host gate anyway for defense-in-depth.
      if (!caps.mkdir && writeOpts.createParents === true) {
        throw new CapabilityUnsupportedError(
          "create_parents requires the mkdir capability (unsupported by this sandbox)"
        )
      }
      const { canonical, vm } = lower(path, ctx, vmRoot)
      // Oversized-write reject BEFORE hashing/IO (per-op cap).
      if (bytes.length > caps.maxWriteBytes) {
        throw new PlaneCapError(
          `write_too_large: ${bytes.length} bytes exceeds cap ${caps.maxWriteBytes}`
        )
      }
      // ADVISORY stale-write guard (staleWriteGuard:'advisory'). There is no
      // host-side path-locked CAS off-box, so we only honor an EXPLICIT caller
      // precondition (expected_sha256 / expected_mtime_ms): best-effort pre-check
      // via stat (+ read for sha) and reject on mismatch. No forced self-CAS.
      const wantSha = writeOpts.expectedSha256 != null
      const wantMtime = writeOpts.expectedMtimeMs != null
      if (wantSha || wantMtime) {
        let priorMtimeMs: number | undefined
        let priorSha: string | null = null
        let priorExists = false
        // The sha pre-check is BEST-EFFORT (advisory posture): computing the prior
        // file's hash means reading it WHOLE, so a file larger than the read cap is
        // NOT pre-checked (M1) — we SKIP the un-affordable read (using st.size, which
        // stat already carries) rather than hash a multi-GB agent-staged file and OOM
        // the shared API process. The write then proceeds without the sha stale check;
        // the advisory guard degrades gracefully. The mtime pre-check reads nothing
        // beyond the stat below, so it stays affordable regardless of file size.
        let shaPrecheckable = wantSha
        try {
          const st = await envd.stat(vm)
          priorExists = true
          priorMtimeMs = rfc3339ToEpochMs(st.modifiedTime)
          if (wantSha) {
            if ((st.size ?? 0) > caps.maxReadBytes) {
              // Too large to hash within the read cap → skip the advisory sha check.
              shaPrecheckable = false
            } else {
              const cur = await envd.readFile(vm)
              priorSha = createHash("sha256").update(cur).digest("hex")
            }
          }
        } catch (err) {
          if (err instanceof CubeEnvdNotFoundError) {
            priorExists = false
          } else {
            throw err
          }
        }
        if (
          wantMtime &&
          (!priorExists || priorMtimeMs !== writeOpts.expectedMtimeMs)
        ) {
          throw new StaleWriteError("pre_open", canonical)
        }
        if (
          wantSha &&
          shaPrecheckable &&
          (!priorExists || priorSha !== writeOpts.expectedSha256)
        ) {
          throw new StaleWriteError("pre_open", canonical)
        }
      }
      await envd.writeFile(vm, bytes)
      const sha256 = createHash("sha256")
        .update(Buffer.from(bytes))
        .digest("hex")
      const mtimeMs = await bestEffortMtimeMs(vm)
      return { sha256, bytesWritten: bytes.length, mtimeMs }
    },
    async mkdir(
      path: string,
      _opts: { recursive?: boolean },
      ctx: ConfinementCtx
    ): Promise<{ created: boolean }> {
      if (!caps.mkdir) {
        throw new CapabilityUnsupportedError(
          "mkdir is not supported by this sandbox"
        )
      }
      assertWriteAccess(ctx)
      const { vm } = lower(path, ctx, vmRoot)
      // Cube MakeDir is recursive (auto-parents). An EXISTING dir → 409
      // already_exists; that is NOT an error — map it to created:false.
      try {
        await envd.makeDir(vm)
        return { created: true }
      } catch (err) {
        if (
          err instanceof CubeEnvdError &&
          (err.status === 409 || err.code === "already_exists")
        ) {
          return { created: false }
        }
        throw err
      }
    },
    async move(
      src: string,
      dest: string,
      _opts: { overwrite?: boolean; expectedSourceSha256?: string | null },
      ctx: ConfinementCtx
    ): Promise<{ mtimeMs: number }> {
      if (!caps.move) {
        throw new CapabilityUnsupportedError(
          "move is not supported by this sandbox"
        )
      }
      assertWriteAccess(ctx)
      // SINGLE grant frame covering BOTH endpoints (F-C): confine src AND dest under
      // the SAME ctx.scope. (Cube Move silently overwrites an existing destination.)
      const { vm: vmSrc } = lower(src, ctx, vmRoot)
      const { vm: vmDest } = lower(dest, ctx, vmRoot)
      const entry = await envd.move(vmSrc, vmDest)
      // datetime-ok: envd omitted the moved entry's mtime; the move just occurred, so
      // ≈now is the honest advisory value for this REQUIRED field (not a value mask).
      return { mtimeMs: rfc3339ToEpochMs(entry.modifiedTime) ?? Date.now() }
    },
    async remove(
      path: string,
      _opts: { recursive?: boolean },
      ctx: ConfinementCtx
    ): Promise<{ removed: boolean }> {
      if (!caps.remove) {
        throw new CapabilityUnsupportedError(
          "remove is not supported by this sandbox"
        )
      }
      assertWriteAccess(ctx)
      const { vm } = lower(path, ctx, vmRoot)
      // Cube Remove is idempotent (no error if absent).
      await envd.remove(vm)
      return { removed: true }
    },
    async search(): Promise<{ hits: unknown[]; truncated: boolean }> {
      // MVP: no in-VM ripgrep bridge (descriptor.core.search=false → fs_search is
      // omitted at the catalog). Defense-in-depth fail-closed here regardless.
      throw new CapabilityUnsupportedError(
        "search is not supported by this sandbox"
      )
    },
  }

  return {
    descriptor: opts.descriptor,
    stat: (path, ctx) => guardedFsOp(() => rawFs.stat(path, ctx)),
    list: (path, ctx) => guardedFsOp(() => rawFs.list(path, ctx)),
    read: (path, readOpts, ctx) =>
      guardedFsOp(() => rawFs.read(path, readOpts, ctx)),
    write: (path, bytes, writeOpts, ctx) =>
      guardedFsOp(() => rawFs.write(path, bytes, writeOpts, ctx)),
    mkdir: (path, mkdirOpts, ctx) =>
      guardedFsOp(() => rawFs.mkdir(path, mkdirOpts, ctx)),
    move: (src, dest, moveOpts, ctx) =>
      guardedFsOp(() => rawFs.move(src, dest, moveOpts, ctx)),
    remove: (path, removeOpts, ctx) =>
      guardedFsOp(() => rawFs.remove(path, removeOpts, ctx)),
    search: (_input, _ctx) => guardedFsOp(() => rawFs.search()),
    async exec(
      payload: SandboxExecPayload,
      _ctx: ConfinementCtx
    ): Promise<SandboxExecResult> {
      // R3.7 (drain — one synchronous span): disposed-check + concurrency
      // reservation with NO await between, BEFORE any async I/O, so an exec op is
      // either counted (→ awaitExecIdle drains it) or rejected — never able to slip
      // past the disposed-check and race the teardown.
      if (disposed) {
        throw new PlaneDisposedError("sandbox data plane has been torn down")
      }
      if (execInflight >= caps.maxConcurrentExec) {
        throw new PlaneCapError(
          `exec_concurrency_exceeded: ${execInflight}/${caps.maxConcurrentExec} in flight`
        )
      }
      execInflight += 1
      try {
        const cwd = payload.cwd
          ? lowerCwd(payload.cwd, vmRoot)
          : trimTrailingSlash(vmRoot)
        // bash → the command text verbatim (client wraps `bash -l -c <cmd>`);
        // exec_file → program + argv (client shell-quotes into `bash -l -c`).
        const request: ExecRequest =
          payload.executor === "bash"
            ? { cmd: payload.command ?? "", cwd, envs: {} }
            : {
                cmd: payload.program ?? "",
                args: [...(payload.args ?? [])],
                cwd,
                envs: {},
              }
        const res = await envd.exec(request, {
          timeoutMs: payload.timeoutMs ?? execTimeoutDefault,
          maxOutputBytes: caps.maxReadBytes,
        })
        return {
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
          truncated: Boolean(res.truncated),
          // Cube surfaces no distinct "killed" signal in-band; a timeout aborts
          // the request (thrown → mapped to runtime_constraint by the CORE layer).
          killed: false,
        }
      } finally {
        execInflight -= 1
        noteExecSettled()
      }
    },
    async dispose(): Promise<void> {
      // R3.3 + R3.7 (drain, in order): (1) flip the disposed-guard so NO new fs/exec
      // op can start; (2) DRAIN in-flight fs ops (a mid-write must settle before the
      // commit-PULL snapshots the remote working set); (3) DRAIN in-flight exec calls
      // (no host child to abort — remote); (4) release the pooled envd dispatcher.
      disposed = true
      await awaitFsIdle(PLANE_DRAIN_TIMEOUT_MS)
      await awaitExecIdle(PLANE_DRAIN_TIMEOUT_MS)
      await boundedEnvdShutdown(envd, ENVD_CLOSE_GRACE_MS)
    },
  }
}

/** Lower an exec working directory (a VFS path) to the in-VM absolute path;
 *  default to the VM root on any canonicalization failure (exec confinement is the
 *  VM boundary, not a per-path realpath, so a best-effort lowering is sufficient). */
function lowerCwd(cwd: string, vmRoot: string): string {
  try {
    return vfsToVm(canonicalVfsPath(cwd), vmRoot)
  } catch {
    return trimTrailingSlash(vmRoot)
  }
}

/**
 * Bounded envd shutdown (m7b): race the graceful close() against a short grace
 * window, then FORCE-close via destroy(). undici's Agent.close() AWAITS in-flight
 * requests — a request hung near its ~30s per-request timeout would otherwise block
 * teardown far past the drain budget — so if close() has not settled within
 * `graceMs`, destroy() (Agent.destroy() aborts in-flight) is called so dispose()
 * never blocks appreciably past the drains. A transport whose stub omits destroy()
 * simply waits out the (already time-boxed) close(). Both a resolved and a rejected
 * close() count as "graceful path done"; the rejection handler keeps the still-
 * pending close() from surfacing as an unhandled rejection after a forced destroy().
 */
async function boundedEnvdShutdown(
  envd: RemoteEnvdTransport,
  graceMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const graced = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), graceMs)
  })
  const closed = envd.close().then(
    () => "closed" as const,
    () => "closed" as const
  )
  const outcome = await Promise.race([closed, graced])
  if (timer !== undefined) clearTimeout(timer)
  if (outcome === "timeout" && envd.destroy) {
    await envd.destroy().catch(() => undefined)
  }
}
