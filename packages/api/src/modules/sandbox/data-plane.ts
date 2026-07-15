// Mode-B (bare sandbox) DATA PLANE (§4.7.1) — the confined tool surface a bare
// adapter exposes IN-PROCESS (local:bare) or over a remote bridge (docker:bare,
// S10 deferred). It is the terminus dispatchBareRuntimeTool routes to, in place
// of the resident device-runtime's MCP HTTP endpoint.
//
// Two hard invariants live here, at the TYPE level so they cannot be bypassed:
//   1. Every plane call carries a ConfinementCtx whose `scope` is the union
//      `readonly string[] | WHOLE_SCOPE` — NEVER `null`/`[]`. An empty derived
//      scope is rejected UPSTREAM (deriveConfinementScope throws EmptyScope) as
//      a HARD DENY (F-C), so a scope can only ever WIDEN nothing.
//   2. fs ops flow through the SAME `@synapse/device-runtime` vfs kernel the
//      resident builtin uses — `withGrantPrefixes(ctx.scope, …)` runs the
//      realpath grant recheck (WHOLE_SCOPE = root-jail; array = prefix confine;
//      empty = structural deny). One kernel, no drift.

import { existsSync } from "node:fs"
import { spawn as nodeSpawn } from "node:child_process"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { SANDBOX_MOUNT_POINTS } from "@synapse/shared"
import {
  WHOLE_SCOPE,
  canonicalVfsPath,
  collapsePrefixes,
  createLocalFsBackend,
  bwrapAvailable,
  wrapDescriptorWithBwrap,
  spawnTerminalProcess,
  buildUtf8Env,
  dispatchRipgrep,
  DEFAULT_SANDBOX_CWD,
  CanonicalPathError,
  GrantPrefixDeniedError,
  CrossMountError,
  StaleWriteError,
  type WholeScope,
  type ExtendedLocalBackend,
  type SpawnDescriptor,
} from "@synapse/device-runtime"
import type { SynapseError } from "@synapse/device-protocol"
import { FILESYSTEM_WRITE_TOOLS } from "@synapse/device-protocol"
import { runDockerCapture, type SpawnImpl } from "./docker-sandbox.js"
import type { McpDispatchResult } from "../devices/dispatch.js"
import type { RuntimeAuthorizationGrantRecord } from "../runtime-authorizations/repo.types.js"
import type { SandboxCapabilityDescriptor } from "./model.js"
import {
  SandboxResourceGoneError,
  type SandboxDataPlaneCredentials,
} from "./sandbox-lifecycle.js"

/** Mount roots the whole-scope search fans out over (== SANDBOX_MOUNT_POINTS). */
const MOUNT_ROOTS: readonly string[] = [...SANDBOX_MOUNT_POINTS]

/** A confinement scope at the plane boundary: a non-empty prefix array (scoped),
 *  or the WHOLE_SCOPE sentinel (root-jail). NEVER `[]`/`null` — see F-C. */
export type ConfinementScope = readonly string[] | WholeScope

/**
 * MANDATORY per-call confinement (F-C). Derived from `claim.grant` (never
 * re-parsed from the envelope) via deriveConfinementScope. `scope` is the union
 * above; the empty-derivation case is a HARD DENY raised before this object is
 * ever built, so the plane can trust every scope it receives.
 */
export interface ConfinementCtx {
  scope: ConfinementScope
  access: "read" | "write"
}

/** Raised when a scoped grant derives ∅ (F-C hard deny). Distinct type so the
 *  fork can map it to a structured permission_denied without a plane call. */
export class EmptyScopeDeniedError extends Error {
  constructor(message = "confinement scope is empty (structural deny-all)") {
    super(message)
    this.name = "EmptyScopeDeniedError"
  }
}

/**
 * Raised when a MUTATING plane method (write/mkdir/move/remove) is invoked under
 * a ConfinementCtx whose `access` is 'read'. ConfinementCtx.access is a mandatory
 * boundary (§4.7.1): a read-only grant must never mutate. Enforced fail-closed at
 * the TOP of each mutating method — this catches direct/internal callers, not just
 * the CORE dispatch fork. Maps to permission_denied. (The resident path enforces
 * write via prefix-narrowing in the vfs frame; the bare plane collapses a scope to
 * prefixes+WHOLE_SCOPE and loses the read/write bit, so it is asserted here.)
 */
export class GrantAccessDeniedError extends Error {
  constructor(
    message = "operation requires a write grant (grant access is read-only)"
  ) {
    super(message)
    this.name = "GrantAccessDeniedError"
  }
}

/** Fail-closed write-access assertion for the mutating plane methods (P7). One
 *  assertion per method — DRY, no separate write-tool allowlist to drift. */
function assertWriteAccess(ctx: ConfinementCtx): void {
  if (ctx.access !== "write") {
    throw new GrantAccessDeniedError()
  }
}

/**
 * Derive the ConfinementCtx scope from the claimed grant (§4.7.1 / F-C).
 *   - filesystem grant → collapsePrefixes(pathPrefixes.map(canonicalVfsPath));
 *     a NON-empty array confines to those prefixes; ∅ ⇒ HARD DENY (throws).
 *   - commandline grant → WHOLE_SCOPE (exec is separately bwrap-confined to the
 *     mount points; its fs "scope" is the whole sandbox root).
 *   - anything else → HARD DENY (fail-closed).
 * Never returns `[]` and never returns `null`.
 */
export function deriveConfinementScope(
  grant: RuntimeAuthorizationGrantRecord
): ConfinementScope {
  if (grant.capability === "filesystem" && grant.filesystem) {
    const prefixes: string[] = []
    for (const p of grant.filesystem.pathPrefixes) {
      try {
        prefixes.push(canonicalVfsPath(p))
      } catch {
        // skip an invalid prefix in the grant
      }
    }
    const collapsed = collapsePrefixes(prefixes)
    if (collapsed.length === 0) {
      // A filesystem grant that derives NO valid prefix is a structural deny —
      // never fall through to WHOLE_SCOPE / [] (the pre-S3B fail-open class).
      throw new EmptyScopeDeniedError(
        "filesystem grant derived an empty prefix set"
      )
    }
    // S13 degraded (confinedFs:'unsupported'): a WHOLE-SANDBOX-scope fs grant
    // (pathPrefixes:["/"] — the whole VFS root) → WHOLE_SCOPE root-jail, NOT a
    // literal "/" prefix. collapsePrefixes(["/","/x",…]) already collapsed any
    // sub-prefix under "/" away, so a surviving "/" means "the whole root".
    if (collapsed.length === 1 && collapsed[0] === "/") {
      return WHOLE_SCOPE
    }
    return collapsed
  }
  if (grant.capability === "commandline" && grant.commandline) {
    // exec is bwrap-confined to the literal mount points; the fs plane scope for
    // an exec/search under a commandline grant is the whole sandbox root-jail.
    return WHOLE_SCOPE
  }
  // Unknown / unsupported capability for the bare plane → fail closed.
  throw new EmptyScopeDeniedError(
    `grant capability ${String(grant.capability)} is not dispatchable on the bare data plane`
  )
}

/**
 * Derive the ConfinementCtx access bit (P7) FAIL-CLOSED. deriveConfinementScope
 * flattens a grant to prefixes+WHOLE_SCOPE and LOSES the read/write bit; this
 * recovers it so assertWriteAccess can re-impose it on the mutating plane methods.
 *
 * 'write' requires BOTH authoritative signals to agree — so neither an unknown
 * grant NOR an unclassified tool can silently confer write:
 *   - the tool is write-classified in FILESYSTEM_WRITE_TOOLS — the SAME set the
 *     projection matcher uses (single source of truth in device-protocol), so a
 *     read/unknown tool yields 'read'.
 *   - the claimed filesystem grant EXPLICITLY permits writes (a read-only or
 *     malformed grant does not). Non-filesystem (commandline) grants never confer
 *     fs-plane write — exec is bwrap-jailed separately, not assertWriteAccess-gated.
 * A write tool under a read/unknown grant therefore collapses to 'read' →
 * assertWriteAccess rejects (defense-in-depth for direct/internal callers).
 */
export function deriveConfinementAccess(
  grant: RuntimeAuthorizationGrantRecord,
  toolName: string
): "read" | "write" {
  const toolIsWrite = (FILESYSTEM_WRITE_TOOLS as readonly string[]).includes(
    toolName
  )
  const grantConfersWrite =
    grant.capability === "filesystem" && grant.filesystem?.access === "write"
  return toolIsWrite && grantConfersWrite ? "write" : "read"
}

// ─────────────────────────── plane surface ───────────────────────────────────

export interface SandboxExecPayload {
  executor: "bash" | "exec_file"
  /** bash: the command text. */
  command?: string
  /** exec_file: the bare program name + argv. */
  program?: string
  args?: string[]
  /** In-sandbox absolute cwd (already lowered; defaults applied by CORE). */
  cwd: string
  timeoutMs?: number
}

export interface SandboxExecResult {
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  killed: boolean
}

export interface SandboxFileStat {
  path: string
  exists: boolean
  kind?: "file" | "directory" | "symlink" | "other"
  size?: number
  mtimeMs?: number
  isSymlink?: boolean
}

/**
 * The confined data plane. Every method takes a ConfinementCtx (F-C). fs methods
 * run through the vfs kernel under `withGrantPrefixes(ctx.scope, …)`; `exec` runs
 * a bwrap-jailed child. Adapters implement this; the CORE layer (below) is the
 * single argument-validation / lowering / cap / CallToolResult layer on top.
 */
export interface SandboxDataPlane {
  readonly descriptor: SandboxCapabilityDescriptor
  stat(path: string, ctx: ConfinementCtx): Promise<SandboxFileStat>
  list(
    path: string,
    ctx: ConfinementCtx
  ): Promise<Array<{ name: string; path: string; kind: string; size?: number }>>
  read(
    path: string,
    opts: { maxBytes?: number; startByte?: number; endByte?: number },
    ctx: ConfinementCtx
  ): Promise<{ bytes: Uint8Array; totalSize: number; truncated: boolean }>
  write(
    path: string,
    bytes: Uint8Array,
    opts: {
      createParents?: boolean
      expectedSha256?: string | null
      // Caller stale-write conditions (staleWriteGuard:'strict'). Both are
      // PRE-CHECKED against a fresh stat/hash of the target and reject on
      // mismatch; the CAS write itself still uses a self-computed fresh sha.
      expectedMtimeMs?: number | null
    },
    ctx: ConfinementCtx
  ): Promise<{ sha256: string; bytesWritten: number; mtimeMs: number }>
  mkdir(
    path: string,
    opts: { recursive?: boolean },
    ctx: ConfinementCtx
  ): Promise<{ created: boolean }>
  move(
    src: string,
    dest: string,
    opts: { overwrite?: boolean; expectedSourceSha256?: string | null },
    ctx: ConfinementCtx
  ): Promise<{ mtimeMs: number }>
  remove(
    path: string,
    opts: { recursive?: boolean },
    ctx: ConfinementCtx
  ): Promise<{ removed: boolean }>
  search(
    input: {
      mode: "content" | "path"
      query: string
      regex?: boolean
      glob?: string
      limit?: number
      offset?: number
    },
    ctx: ConfinementCtx
  ): Promise<{ hits: unknown[]; truncated: boolean }>
  exec(
    payload: SandboxExecPayload,
    ctx: ConfinementCtx
  ): Promise<SandboxExecResult>
  /** Drain every child this plane spawned (scoped dispose, S4). */
  dispose(): Promise<void>
}

/**
 * The persisted-row projection an off-box bare adapter reconstructs its data plane
 * from on a bare-dispatch rebuild-on-miss (P4b). Carries ONLY row-authoritative
 * facts (never live config for the adapter kind): the persisted adapter tag, the
 * authoritative provider resource id (== sandboxes.resource_id), the scheme-tagged
 * endpoint, the Zod-decoded capability descriptor, and the session sandbox root.
 * `adapter.rebuildDataPlane(row)` maps these onto createRemoteBareDataPlane —
 * deployment-wide connection facts (domain/proxy/vmRoot) come from config, but the
 * per-sandbox identity (resource_id) and the descriptor come from THIS row.
 */
export interface BareDataPlaneRebuildRow {
  adapter: string
  resourceId: string | null
  dataPlaneEndpoint: string | null
  descriptor: SandboxCapabilityDescriptor
  sandboxRoot: string
  // ── R4 additions (§1.3/§1.6) ──
  /** The row's workspace id (creds AAD half; future per-ws key rotation). */
  workspaceId: string
  /**
   * (§1.3, F7) DECRYPTED off-box data-plane creds (envd/traffic tokens), or null.
   * The off-box rebuildDataPlane builds a TOKEN-BEARING plane from these; null for
   * host-side adapters + a creds decrypt miss (→ token-less; reconnect heals).
   * BRANDED redacted so a stray serialize can't leak the tokens (§6.7/3d).
   */
  credentials: SandboxDataPlaneCredentials | null
  /** (§1.6) provider platform/arch facts for readiness / bundle projection. */
  platform: string | null
  arch: string | null
}

/**
 * Working-set identity bridge (§8.1). For local:bare (host-visible shared CAS)
 * these are the EXISTING spine primitives verbatim — the adapter never touches
 * CAS. Kept as an interface so docker:bare's detached variant (S12, deferred)
 * can substitute a remote implementation without touching the spine.
 */
/**
 * (R6 #3/#6) The DURABILITY result of an off-box PULL. `unreadable` files were NOT
 * captured (transport read/stream error), so the VM's bytes are still the SOLE copy
 * and the caller MUST NOT delete the VM. An empty `unreadable` ⇒ the pull is durable
 * (every changed file was streamed/read into the mirror; a large file is STREAMED,
 * never skipped — the R6 #3 fix for the >10 MiB silent-loss).
 */
export interface PullOutcome {
  pulled: string[]
  pruned: string[]
  unreadable: string[]
}

export interface WorkingSetBridge {
  applyManifest(input: {
    manifestSha256?: string
    targetDir: string
  }): Promise<void>
  scanManifest(input: {
    dir: string
    baseManifestSha256?: string
    latestManifestSha256?: string
  }): Promise<unknown>
  /**
   * (R4 §6.3/§6.4) OFF-BOX PULL-only: reconcile the VM tree into the mirror
   * (`input.dir` == the mount's materializedDir), delete-PRUNING the mirror to
   * EXACTLY the VM listing (F1), so a subsequent commitSpaces scan of the same
   * mirror sees the true VM working set (incl. deletes). Host bridges leave this
   * undefined — their bytes are always in the mirror dir (no pull).
   */
  pull?(input: { dir: string }): Promise<PullOutcome>
  /**
   * (R4 review fix) Release any transport the bridge owns. The OFF-BOX bridge mints
   * a FRESH envd client (its own undici Agent + keep-alive socket pool to CubeProxy)
   * per workingSet() call, so the spine MUST dispose it after each push/pull —
   * otherwise the Agents leak under sustained session churn (FD/socket exhaustion).
   * Host bridges (docker-exec / local) own no persistent transport and leave it
   * undefined (a no-op `?.()`).
   */
  dispose?(): Promise<void>
}

/**
 * (R6 #6) The OFF-BOX working-set bridge NARROWS {@link WorkingSetBridge} so `pull`
 * is REQUIRED (not the optional host-bridge shape): an off-box VM is the SOLE store of
 * the turn's bytes, so teardown/recovery MUST pull it into the mirror before the VM is
 * deleted, and MUST branch on the {@link PullOutcome} durability result. Returned by
 * {@link OffBoxSandboxAdapter.workingSet}, so the spine calls `pull()` unconditionally
 * — the "did the adapter forget to implement pull?" hole is closed at the type level,
 * not by a runtime `if (bridge.pull)` guard.
 */
export interface OffBoxWorkingSetBridge extends WorkingSetBridge {
  pull(input: { dir: string }): Promise<PullOutcome>
}

// ─────────────────────────── local:bare reference plane ──────────────────────

export interface LocalBareDataPlaneOptions {
  /** Per-session sandbox FS root; children are the materialized mount points. */
  sandboxRoot: string
  descriptor: SandboxCapabilityDescriptor
  ripgrepPath?: string
}

/**
 * The confined HOST-SIDE fs surface shared by BOTH bare reference adapters
 * (§4.7.2 / §4.7.3). fs ops flow through the SAME `@synapse/device-runtime` vfs
 * kernel the resident builtin uses, under `withGrantPrefixes(ctx.scope, …)` — for
 * local:bare AND docker:bare alike, the bytes are host-local under
 * STORAGE_DIR/sandboxes/<id> (docker:bare's container merely volume-subpath-mounts
 * the SAME dirs). Host-side realpath even STRENGTHENS docker:bare: an in-container
 * absolute symlink resolves host-side OUTSIDE the granted prefix → rejected. Only
 * `exec` differs (bwrap child vs `docker exec`), so it is layered on top.
 */
interface ConfinedHostFs {
  backend: ExtendedLocalBackend
  ensureStarted: () => Promise<void>
  fs: Pick<
    SandboxDataPlane,
    "stat" | "list" | "read" | "write" | "mkdir" | "move" | "remove" | "search"
  >
  // R3.3 (disposed-guard). Teardown's dispose() flips this so a fs op that
  // passed the bare-dispatch close-gate BEFORE teardown began — and is still
  // running when dispose() fires — fails CLOSED (a clean runtime_constraint)
  // instead of touching a sandbox dir mid-removal (raw ENOENT / partial write).
  markDisposed: () => void
  isDisposed: () => boolean
  // R3.7 (drain). Resolve once no fs op is in flight (or after timeoutMs). dispose()
  // awaits this BEFORE teardown commits, so a mid-rename write lands on disk and is
  // captured by the snapshot rather than lost.
  awaitFsIdle: (timeoutMs: number) => Promise<void>
}

function buildConfinedHostFs(opts: {
  sandboxRoot: string
  descriptor: SandboxCapabilityDescriptor
  ripgrepPath?: string
}): ConfinedHostFs {
  const backend: ExtendedLocalBackend = createLocalFsBackend({
    rootPath: opts.sandboxRoot,
  })
  let startedOnce = false
  const ensureStarted = async (): Promise<void> => {
    if (startedOnce) return
    await backend.start()
    startedOnce = true
  }
  const caps = opts.descriptor.core

  // R3.3 (disposed-guard) + R3.7 (drain). `disposed` fails NEW ops closed the
  // instant teardown disposes the plane; `fsInflight` counts in-flight fs ops so
  // dispose() can AWAIT them to natural completion before teardown commits — a
  // mid-rename write must land on disk BEFORE the snapshot, else an acknowledged
  // write is silently lost (the precise R3.7 lost-write class). Both are consulted
  // through `guardedFsOp`, which does the disposed-check and the increment in ONE
  // synchronous span (no await between), so an op lands strictly BEFORE markDisposed
  // (counted → drained) or AFTER (rejected) — never in the gap between them.
  let disposed = false
  let fsInflight = 0
  let fsIdleResolvers: Array<() => void> = []
  function noteFsSettled(): void {
    if (fsInflight === 0 && fsIdleResolvers.length > 0) {
      const resolvers = fsIdleResolvers
      fsIdleResolvers = []
      for (const r of resolvers) r()
    }
  }
  function awaitFsIdle(timeoutMs: number): Promise<void> {
    if (fsInflight === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      fsIdleResolvers.push(done)
    })
  }
  function guardedFsOp<T>(fn: () => Promise<T>): Promise<T> {
    if (disposed) {
      return Promise.reject(
        new PlaneDisposedError("sandbox data plane has been torn down")
      )
    }
    fsInflight += 1
    return fn().finally(() => {
      fsInflight -= 1
      noteFsSettled()
    })
  }

  function withScope<T>(ctx: ConfinementCtx, fn: () => Promise<T>): Promise<T> {
    return backend.withGrantPrefixes(ctx.scope, fn)
  }

  const rawFs: ConfinedHostFs["fs"] = {
    async stat(path, ctx) {
      await ensureStarted()
      const canonical = canonicalVfsPath(path)
      return withScope(ctx, async () => {
        const info = await backend.safeStat(canonical)
        if (!info) return { path: canonical, exists: false }
        return {
          path: canonical,
          exists: true,
          kind: info.kind,
          size: info.size,
          mtimeMs: info.mtimeMs,
          isSymlink: info.isSymlink,
        }
      })
    },
    async list(path, ctx) {
      await ensureStarted()
      const canonical = canonicalVfsPath(path)
      return withScope(ctx, async () => {
        const entries = await backend.list(canonical)
        return entries.map((e) => ({
          name: e.name,
          path: e.path,
          kind: e.kind,
          size: e.size,
        }))
      })
    },
    async read(path, readOpts, ctx) {
      // Capability gate (Layer 2): !rangeRead forbids a supplied byte window
      // (start_byte/end_byte). max_bytes is a RESPONSE-SIZE cap, NOT a range
      // feature, so it is NOT gated here. Fail-closed at the TOP of the op.
      if (
        !caps.rangeRead &&
        (readOpts.startByte !== undefined || readOpts.endByte !== undefined)
      ) {
        throw new CapabilityUnsupportedError(
          "range read (start_byte/end_byte) is not supported by this sandbox"
        )
      }
      await ensureStarted()
      const canonical = canonicalVfsPath(path)
      // Whole-file read cap (per-op cap): bound the returned window to
      // maxReadBytes so a huge file can't OOM the API process.
      const cap = Math.min(
        readOpts.maxBytes ?? caps.maxReadBytes,
        caps.maxReadBytes
      )
      return withScope(ctx, async () => {
        const r = await backend.readBytes(canonical, {
          startByte: readOpts.startByte,
          endByte: readOpts.endByte,
          maxBytes: cap,
        })
        return {
          bytes: r.bytes,
          totalSize: r.totalSize,
          truncated: r.truncated,
        }
      })
    },
    async write(path, bytes, writeOpts, ctx) {
      assertWriteAccess(ctx)
      // Capability gate (Layer 2): !mkdir also forbids an implicit parent-dir
      // create (create_parents is a mkdir). Fail-closed at the TOP of the op.
      if (!caps.mkdir && writeOpts.createParents === true) {
        throw new CapabilityUnsupportedError(
          "create_parents requires the mkdir capability (unsupported by this sandbox)"
        )
      }
      await ensureStarted()
      const canonical = canonicalVfsPath(path)
      // Oversized-write reject BEFORE hashing/IO (per-op cap).
      if (bytes.length > caps.maxWriteBytes) {
        throw new PlaneCapError(
          `write_too_large: ${bytes.length} bytes exceeds cap ${caps.maxWriteBytes}`
        )
      }
      const strict = opts.descriptor.core.staleWriteGuard === "strict"
      // A caller-supplied expected_sha256 is an EXPLICIT precondition and must be
      // honored regardless of posture — the 'advisory' posture only relaxes the
      // FORCED self-CAS (the no-caller-sha guard strict imposes on every write),
      // never a caller's own optimistic-concurrency check.
      const callerSuppliedSha = writeOpts.expectedSha256 != null
      return withScope(ctx, () =>
        backend.withPathLock(canonical, async () => {
          const info = await backend.safeStat(canonical)
          const priorExists = !!info && info.kind === "file"
          // Fresh prior sha: computed ONCE under the path lock and reused for BOTH
          // the caller pre-check and the compare-and-swap guard. Needed whenever the
          // strict forced-CAS applies OR the caller supplied an expected_sha256 to
          // verify (the latter holds even under the 'advisory' posture).
          const priorSha =
            priorExists && (strict || callerSuppliedSha)
              ? (await backend.streamSha256(canonical)).sha256
              : null
          // Stale-write PRE-CHECK — ALWAYS honor a caller-supplied precondition,
          // regardless of posture. A caller's explicit expected_mtime_ms /
          // expected_sha256 is a lost-update signal and rejects on mismatch even
          // under 'advisory'; only the no-caller forced CAS below is posture-gated.
          // (Previously the whole pre-check was wrapped in `if (strict)`, so an
          // advisory descriptor silently dropped a caller's EXPLICIT precondition
          // alongside the forced CAS — fixed structurally here.)
          if (
            writeOpts.expectedMtimeMs != null &&
            (!priorExists || info!.mtimeMs !== writeOpts.expectedMtimeMs)
          ) {
            throw new StaleWriteError("pre_open", canonical)
          }
          if (
            writeOpts.expectedSha256 != null &&
            (!priorExists || priorSha !== writeOpts.expectedSha256)
          ) {
            throw new StaleWriteError("pre_open", canonical)
          }
          // CAS guard for the write itself: RETAIN the self-computed fresh prior
          // sha (never null when a prior file exists) so a concurrent writer that
          // mutates the file between this pre-check and the rename still loses-safe.
          // A brand-new file uses createOnly (must-not-exist) instead. Under strict
          // this forced self-CAS is unconditional; under 'advisory' it is dropped
          // UNLESS the caller supplied an expected_sha256 (then we still feed the
          // fresh prior sha so their explicit precondition stays TOCTOU-safe).
          const expectedShaForCAS =
            priorExists && (strict || callerSuppliedSha) ? priorSha : null
          const res = await backend.atomicWrite(canonical, bytes, {
            createOnly: !priorExists,
            createParents: writeOpts.createParents ?? false,
            expectedShaForCAS,
          })
          return {
            sha256: res.sha256,
            bytesWritten: res.bytesWritten,
            mtimeMs: res.mtimeMs,
          }
        })
      )
    },
    async mkdir(path, mkdirOpts, ctx) {
      // Capability gate (Layer 2): !mkdir fail-closes at the TOP of the op.
      if (!caps.mkdir) {
        throw new CapabilityUnsupportedError(
          "mkdir is not supported by this sandbox"
        )
      }
      assertWriteAccess(ctx)
      await ensureStarted()
      const canonical = canonicalVfsPath(path)
      return withScope(ctx, () =>
        backend.mkdir(canonical, { recursive: mkdirOpts.recursive ?? false })
      )
    },
    async move(src, dest, moveOpts, ctx) {
      // Capability gate (Layer 2): !move fail-closes at the TOP of the op.
      if (!caps.move) {
        throw new CapabilityUnsupportedError(
          "move is not supported by this sandbox"
        )
      }
      assertWriteAccess(ctx)
      await ensureStarted()
      const s = canonicalVfsPath(src)
      const d = canonicalVfsPath(dest)
      // SINGLE grant frame covering BOTH endpoints (F-C).
      return withScope(ctx, () =>
        backend.move(s, d, {
          expectedSourceSha: moveOpts.expectedSourceSha256 ?? null,
          overwrite: moveOpts.overwrite ?? false,
        })
      )
    },
    async remove(path, removeOpts, ctx) {
      // Capability gate (Layer 2): !remove fail-closes at the TOP of the op.
      if (!caps.remove) {
        throw new CapabilityUnsupportedError(
          "remove is not supported by this sandbox"
        )
      }
      assertWriteAccess(ctx)
      await ensureStarted()
      const canonical = canonicalVfsPath(path)
      return withScope(ctx, () =>
        backend.remove(canonical, { recursive: removeOpts.recursive ?? false })
      )
    },
    async search(input, ctx) {
      // Capability gate (Layer 2): !search fail-closes at the TOP of the op (the
      // one toggle actually false in prod when the plane has no ripgrep).
      if (!caps.search) {
        throw new CapabilityUnsupportedError(
          "search is not supported by this sandbox"
        )
      }
      await ensureStarted()
      // Search pushdown: explicit prefix roots. A scoped grant searches only its
      // prefixes; WHOLE_SCOPE fans out over the mount roots. (An empty scope can
      // never reach here — deriveConfinementScope already hard-denied it.)
      const allowedPrefixes =
        ctx.scope === WHOLE_SCOPE ? [...MOUNT_ROOTS] : [...ctx.scope]
      const out = await dispatchRipgrep({
        mode: input.mode,
        query: input.query,
        regex: input.regex ?? false,
        glob: input.glob,
        limit: input.limit ?? 100,
        offset: input.offset ?? 0,
        allowedPrefixes,
        hostRootPath: backend.hostRootPath,
        backend,
        cfg: { maxOffset: 10_000 },
        deps: opts.ripgrepPath ? { ripgrepPath: opts.ripgrepPath } : undefined,
      })
      return { hits: out.hits, truncated: out.truncated }
    },
  }

  // Every fs op flows through guardedFsOp: disposed-check (fail NEW ops closed) +
  // in-flight accounting (so dispose() can drain) in one synchronous span.
  const fs: ConfinedHostFs["fs"] = {
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
    search: (input, ctx) => guardedFsOp(() => rawFs.search(input, ctx)),
  }
  return {
    backend,
    ensureStarted,
    fs,
    markDisposed: () => {
      disposed = true
    },
    isDisposed: () => disposed,
    awaitFsIdle,
  }
}

// R3.7 (drain budget). Upper bound teardown waits for in-flight fs ops + aborted
// exec children to settle before committing. Host-side fs ops are sub-second; an
// aborted bwrap child dies on SIGTERM well within this. If a pathological op
// exceeds it, teardown proceeds anyway (no worse than the pre-drain behavior) —
// the OS / next-boot reconcile / docker label reaper are the backstops.
const PLANE_DRAIN_TIMEOUT_MS = 5_000

/**
 * In-process reference data plane for local:bare (§4.7.2). fs via
 * createLocalFsBackend + the vfs kernel (shared buildConfinedHostFs); exec via a
 * bwrap-jailed child. bwrap is MANDATORY — when it is absent, `exec` throws
 * (structural fail-closed: NEVER run a command unconfined on the API host). Every
 * child is tracked so dispose() can SIGTERM/SIGKILL exactly this plane's own
 * children (never a sibling runtime).
 */
export function createLocalBareDataPlane(
  opts: LocalBareDataPlaneOptions
): SandboxDataPlane {
  const { ensureStarted, fs, markDisposed, isDisposed, awaitFsIdle } =
    buildConfinedHostFs(opts)
  const caps = opts.descriptor.core
  const execControllers = new Set<AbortController>()
  let running = 0
  // R3.7 (exec drain). Resolvers fired when the last exec child settles, so
  // dispose() can await aborted children to actually EXIT before teardown commits
  // (an aborted-but-still-flushing child would otherwise tear a snapshotted file).
  let execIdleResolvers: Array<() => void> = []
  function noteExecSettled(): void {
    if (running === 0 && execIdleResolvers.length > 0) {
      const resolvers = execIdleResolvers
      execIdleResolvers = []
      for (const r of resolvers) r()
    }
  }
  function awaitExecIdle(timeoutMs: number): Promise<void> {
    if (running === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      execIdleResolvers.push(done)
    })
  }

  return {
    descriptor: opts.descriptor,
    ...fs,
    async exec(payload, _ctx) {
      // R3.7 (drain — the SAME one-synchronous-span rule as guardedFsOp): the
      // disposed-check + concurrency reservation + controller registration run with
      // NO await between them and BEFORE ensureStarted's async I/O. So an exec op is
      // either counted+registered (→ dispose() aborts it AND awaitExecIdle drains it)
      // or rejected — never able to slip past the disposed-check, park in a pending
      // ensureStarted() while dispose() samples running===0/empty controllers, then
      // resume and spawn an unaborted, uncounted child that races the commit snapshot.
      // The bwrap/isolation gate is synchronous and also fail-closes before the
      // reservation (a rejected op never reserves).
      if (isDisposed()) {
        throw new PlaneDisposedError("sandbox data plane has been torn down")
      }
      // bwrap MANDATORY (fail-closed): NEVER run a command unconfined on the API
      // host. isolation:null means no commandline exposure/grant was minted, but
      // we defend in depth here regardless of the claim path.
      if (opts.descriptor.isolation === null || !bwrapAvailable()) {
        throw new PlaneExecUnconfinedError(
          "exec refused: bwrap confinement is unavailable on the API host"
        )
      }
      // Exec concurrency cap (per-op cap).
      if (running >= caps.maxConcurrentExec) {
        throw new PlaneCapError(
          `exec_concurrency_exceeded: ${running}/${caps.maxConcurrentExec} in flight`
        )
      }
      running += 1
      const controller = new AbortController()
      execControllers.add(controller)
      try {
        await ensureStarted()
        const inner = buildInnerExecDescriptor(payload)
        const confined = wrapDescriptorWithBwrap(inner, {
          sandboxRoot: opts.sandboxRoot,
          cwd: payload.cwd || DEFAULT_SANDBOX_CWD,
          // Under Docker the loopback bring-up needs CAP_NET_ADMIN; local:bare on
          // the API host keeps the stronger kernel-level no-network default.
          shareNet: false,
        })
        // Curated minimal exec env — NEVER raw process.env. buildUtf8Env keeps
        // only SAFE_BASE, strips dangerous keys; we force a conservative PATH so a
        // bare exec_file program still resolves inside the /usr,/bin ro-binds.
        const curatedEnv = buildUtf8Env(process.env as Record<string, string>, {
          allowedEnv: [],
          platform: "linux",
        })
        curatedEnv["PATH"] =
          "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
        const res = await spawnTerminalProcess(confined, {
          // cwd is set INSIDE the jail via bwrap --chdir; the host-side cwd is
          // irrelevant (bwrap pivots), so leave it unset.
          baseEnv: curatedEnv,
          toolchainBinDirs: [],
          toolchainEnv: {},
          platform: "linux",
          osEnv: process.env as Record<string, string>,
          timeoutMs: payload.timeoutMs,
          signal: controller.signal,
        })
        return {
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
          truncated: Boolean(res.stdoutTruncated || res.stderrTruncated),
          killed: res.killed,
        }
      } finally {
        execControllers.delete(controller)
        running -= 1
        noteExecSettled()
      }
    },
    async dispose() {
      // R3.3 + R3.7 (drain, in order):
      // (1) flip the disposed-guard FIRST so NO new fs/exec op can start.
      markDisposed()
      // (2) DRAIN in-flight fs ops to natural completion — a mid-rename write must
      //     land on disk BEFORE teardown's commit snapshots the dir, else the
      //     acknowledged write is lost. (Bounded by the drain timeout.)
      await awaitFsIdle(PLANE_DRAIN_TIMEOUT_MS)
      // (3) abort THIS plane's own exec children (S4 — never a sibling runtime)…
      for (const c of execControllers) {
        try {
          c.abort()
        } catch {
          /* best-effort */
        }
      }
      // (4) …then AWAIT them to actually exit, so no aborted-but-flushing child
      //     tears a file the commit is about to snapshot.
      await awaitExecIdle(PLANE_DRAIN_TIMEOUT_MS)
      execControllers.clear()
    },
  }
}

// ─────────────────────────── docker:bare reference plane ─────────────────────

/** Default in-container exec timeout (before the T+10s API-side backstop). */
const DEFAULT_DOCKER_EXEC_TIMEOUT_MS = 60_000

export interface DockerBareDataPlaneOptions {
  /** Per-session sandbox FS root — the SAME host dirs the container mounts. */
  sandboxRoot: string
  descriptor: SandboxCapabilityDescriptor
  /** The hardened keepalive container id (the docker-exec: endpoint target). */
  containerId: string
  ripgrepPath?: string
  /** Test seam: the docker CLI spawner. */
  spawnImpl?: SpawnImpl
}

/**
 * Reference data plane for docker:bare (§4.7.3). fs is HOST-SIDE — the SAME
 * buildConfinedHostFs / vfs kernel / ConfinementCtx path as local:bare (the bytes
 * are host-local under STORAGE_DIR/sandboxes/<id>; the container merely
 * volume-subpath-mounts them). We NEVER `docker cp` / `tar -x` on sandbox output
 * (host-RCE) and NEVER grep in-container — host-side realpath confinement is both
 * simpler AND stronger. Only `exec` reaches into the container, via
 * `docker exec -w /<cwd> <cid> timeout -k 5 -s TERM <secs> <payload>` (runDockerCapture:
 * a failing command is a RESULT; a gone container is a typed resource_gone).
 */
export function createDockerBareDataPlane(
  opts: DockerBareDataPlaneOptions
): SandboxDataPlane {
  const { fs, markDisposed, isDisposed, awaitFsIdle } = buildConfinedHostFs({
    sandboxRoot: opts.sandboxRoot,
    descriptor: opts.descriptor,
    ripgrepPath: opts.ripgrepPath,
  })
  const caps = opts.descriptor.core
  const spawnImpl = opts.spawnImpl ?? nodeSpawn
  let running = 0

  return {
    descriptor: opts.descriptor,
    ...fs,
    async exec(payload, _ctx) {
      if (isDisposed()) {
        throw new PlaneDisposedError("sandbox data plane has been torn down")
      }
      // Exec concurrency cap (per-op cap).
      if (running >= caps.maxConcurrentExec) {
        throw new PlaneCapError(
          `exec_concurrency_exceeded: ${running}/${caps.maxConcurrentExec} in flight`
        )
      }
      running += 1
      try {
        const timeoutMs = payload.timeoutMs ?? DEFAULT_DOCKER_EXEC_TIMEOUT_MS
        const secs = Math.max(1, Math.ceil(timeoutMs / 1000))
        const cwd = payload.cwd || DEFAULT_SANDBOX_CWD
        // In-container payload. bash → `bash -c <cmd>`; exec_file → `<prog> <args>`.
        // No shell interpolation: argv is always an array (docker exec never sees
        // a shell string), so untrusted values can't inject.
        const inner =
          payload.executor === "bash"
            ? ["bash", "-c", payload.command ?? ""]
            : [payload.program ?? "", ...(payload.args ?? [])]
        // Two-tier timeout: in-container timeout(1) (TERM then KILL after 5s) +
        // the API-side backstop inside runDockerCapture (T+10s → SIGKILL CLI +
        // `docker kill <cid>`).
        const argv = [
          "exec",
          "-w",
          cwd,
          opts.containerId,
          "timeout",
          "-k",
          "5",
          "-s",
          "TERM",
          String(secs),
          ...inner,
        ]
        const res = await runDockerCapture(spawnImpl, argv, {
          timeoutMs,
          containerId: opts.containerId,
          maxStreamBytes: caps.maxReadBytes,
        })
        return {
          exitCode: res.code,
          stdout: res.stdout,
          stderr: res.stderr,
          truncated: res.truncated,
          // 124 = the in-container timeout(1) fired; treat as killed.
          killed: res.killed || res.code === 124,
        }
      } finally {
        running -= 1
      }
    },
    async dispose() {
      // R3.3 + R3.7: flip the disposed-guard so no NEW host-side fs op starts, then
      // DRAIN in-flight host-side fs ops before the adapter's kill() commits/rm's —
      // docker:bare fs is HOST-SIDE (same buildConfinedHostFs), so `docker stop`
      // does NOT stop it; only this drain does. In-container exec is drained
      // separately by the adapter kill()'s `docker stop -t 5` (and runDockerCapture's
      // T+10s backstop), so there is nothing exec-scoped to await here.
      markDisposed()
      await awaitFsIdle(PLANE_DRAIN_TIMEOUT_MS)
    },
  }
}

class PlaneCapError extends Error {
  readonly code = "invalid_request" as const
  constructor(message: string) {
    super(message)
    this.name = "PlaneCapError"
  }
}

class PlaneExecUnconfinedError extends Error {
  readonly code = "runtime_constraint" as const
  constructor(message: string) {
    super(message)
    this.name = "PlaneExecUnconfinedError"
  }
}

/**
 * Raised when a plane op is invoked but the sandbox's capability descriptor has
 * that op/feature toggled OFF (core.mkdir/move/remove/search false, or a byte-window
 * read under !core.rangeRead, or create_parents under !core.mkdir). A MISSING
 * capability — SAME taxonomy as PlaneExecUnconfinedError (runtime_constraint), NOT
 * invalid_request. Enforced fail-closed at the TOP of each affected plane op so a
 * direct/internal caller can't bypass the catalog-level omission (Layer 2 of 2 —
 * the catalog omits/strips the tool in core-catalog.ts bareFilesystemTools).
 */
class CapabilityUnsupportedError extends Error {
  readonly code = "runtime_constraint" as const
  constructor(message: string) {
    super(message)
    this.name = "CapabilityUnsupportedError"
  }
}

/**
 * R3.3 (disposed-guard). Raised when a plane op runs AFTER teardown disposed the
 * plane — a slow fs op that passed the bare-dispatch close-gate before teardown
 * began and is still executing when dispose() fires. Fail CLOSED with
 * runtime_constraint (same taxonomy as the bare-dispatch close-gate denial),
 * NEVER let the op touch a sandbox dir mid-removal.
 */
class PlaneDisposedError extends Error {
  readonly code = "runtime_constraint" as const
  constructor(message: string) {
    super(message)
    this.name = "PlaneDisposedError"
  }
}

/**
 * (R4 §3.5 / #7 M1 / F8) A caller-supplied stale-write precondition
 * (expected_sha256 / expected_source_sha256) could NOT be evaluated: off-box, the
 * prior/source file is larger than the read cap, so hashing it to verify the
 * precondition is unaffordable (reading a multi-GB file to hash would OOM the
 * shared API process). FAIL-CLOSED (runtime_constraint) rather than silently
 * proceeding WITHOUT the precondition — a dropped precondition is a silent
 * lost-update. The caller can retry with a smaller target or an expected_mtime_ms
 * precondition (which the stat already carries, no read needed).
 */
class PreconditionUncheckableError extends Error {
  readonly code = "runtime_constraint" as const
  constructor(message: string) {
    super(message)
    this.name = "PreconditionUncheckableError"
  }
}

export {
  PlaneCapError,
  PlaneExecUnconfinedError,
  CapabilityUnsupportedError,
  PlaneDisposedError,
  PreconditionUncheckableError,
}

function buildInnerExecDescriptor(
  payload: SandboxExecPayload
): SpawnDescriptor {
  if (payload.executor === "bash") {
    const bashPath = resolveBashPath()
    if (!bashPath) {
      throw new PlaneExecUnconfinedError("bash not found on the API host")
    }
    return {
      program: bashPath,
      args: ["-c", payload.command ?? ""],
      stdio: ["ignore", "pipe", "pipe"],
    }
  }
  // exec_file — program is a bare command name (validated by the classifier);
  // bwrap resolves it inside the jail via the curated PATH.
  return {
    program: payload.program ?? "",
    args: [...(payload.args ?? [])],
    stdio: ["ignore", "pipe", "pipe"],
  }
}

function resolveBashPath(): string | null {
  for (const p of ["/bin/bash", "/usr/bin/bash", "/bin/sh"]) {
    if (existsSync(p)) return p
  }
  return null
}

// ─────────────────────────── canonical CORE layer ────────────────────────────
// Written ONCE: arg validation + VFS→in-sandbox lowering + cwc-default + per-op
// caps live here; adapters (the plane) receive already-validated primitives.
// dispatchBareRuntimeTool calls this; it returns the same McpDispatchResult
// shape dispatchSyncTool does, so `completeRuntimeOperation` + downstream handling
// are byte-identical.

function textResult(
  body: unknown,
  meta?: Record<string, unknown>
): McpDispatchResult {
  return {
    ok: true,
    result: {
      content: [{ type: "text", text: JSON.stringify(body) }],
      ...(meta ? { _meta: meta } : {}),
    },
  }
}

function errResult(
  code: SynapseError["code"],
  message: string,
  details?: Record<string, unknown>
): McpDispatchResult {
  return {
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  }
}

function asString(x: unknown): string | undefined {
  return typeof x === "string" ? x : undefined
}
function asBool(x: unknown): boolean | undefined {
  return typeof x === "boolean" ? x : undefined
}
function asInt(x: unknown): number | undefined {
  return typeof x === "number" && Number.isInteger(x) ? x : undefined
}
/** Accepts a FRACTIONAL number (unlike asInt). fs_stat/fs_write RETURN the raw
 *  float mtimeMs, so any guard that round-trips it must accept the float. */
function asNumber(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined
}

/**
 * Parse the OPTIONAL caller-supplied `expected_mtime_ms` stale-write precondition
 * (P6). ABSENT ⇒ no precondition (null). PRESENT ⇒ must be a finite number — the
 * fractional mtimeMs a prior stat/write returned. asInt would DROP the float
 * (Number.isInteger(1699999999123.456) === false) → the mtime pre-check silently
 * SKIPS (fails OPEN). A present-but-unparseable value fails CLOSED (throws
 * PlaneCapError → invalid_request) rather than dropping the guard. Matches the
 * resident builtin, which reads expected_mtime_ms via asNumber and compares the
 * float directly.
 */
function parseExpectedMtimeMs(x: unknown): number | null {
  if (x === undefined || x === null) return null
  const n = asNumber(x)
  if (n === undefined) {
    throw new PlaneCapError("expected_mtime_ms must be a finite number")
  }
  return n
}

/**
 * Parse a caller's expected_sha256 stale-write precondition. Present-but-not-a-
 * string fails CLOSED (PlaneCapError → invalid_request) rather than silently
 * dropping the optimistic-concurrency guard — symmetric with parseExpectedMtimeMs.
 * (undefined/null = no precondition supplied.)
 */
function parseExpectedSha256(x: unknown): string | null {
  if (x === undefined || x === null) return null
  if (typeof x !== "string") {
    throw new PlaneCapError("expected_sha256 must be a string")
  }
  return x
}

/**
 * Parse an OPTIONAL non-negative-integer CORE numeric param (max_bytes /
 * start_byte / end_byte / limit / offset / timeout_ms). ABSENT ⇒ undefined
 * (passthrough — the handler then applies its own default). PRESENT ⇒ must be a
 * NON-NEGATIVE integer; a negative or non-integer value is REJECTED fail-closed
 * (throws PlaneCapError → invalid_request), NOT clamped — a negative byte-window /
 * limit / offset / timeout is a malformed request, never silently coerced. (`asInt`
 * accepted negatives; this is R3.P2a's param half.)
 */
function parseNonNegInt(x: unknown): number | undefined {
  if (x === undefined || x === null) return undefined
  const n = asInt(x)
  if (n === undefined || n < 0) {
    throw new PlaneCapError(
      `expected a non-negative integer, got ${JSON.stringify(x)}`
    )
  }
  return n
}

/** Map a thrown error from the plane/kernel to the McpDispatchResult error taxonomy. */
function mapPlaneError(err: unknown): McpDispatchResult {
  if (err instanceof EmptyScopeDeniedError) {
    return errResult("permission_denied", err.message)
  }
  if (err instanceof GrantAccessDeniedError) {
    return errResult("permission_denied", err.message)
  }
  if (err instanceof GrantPrefixDeniedError) {
    return errResult("permission_denied", err.message)
  }
  if (err instanceof CanonicalPathError) {
    return errResult("invalid_request", err.message)
  }
  if (err instanceof CrossMountError) {
    return errResult(
      "runtime_constraint",
      `cross_mount_not_supported: ${err.canonical}`
    )
  }
  if (err instanceof StaleWriteError) {
    return errResult("runtime_constraint", err.message, {
      stale_write: true,
      stale_write_phase: err.phase,
    })
  }
  if (err instanceof PreconditionUncheckableError) {
    // (#7 M1 / F8) The caller's optimistic-concurrency precondition could not be
    // evaluated off-box (target too large to hash within the read cap). Fail
    // closed so the write/move does NOT silently drop the precondition.
    return errResult("runtime_constraint", err.message, {
      precondition_uncheckable: true,
    })
  }
  if (err instanceof PlaneCapError) {
    return errResult("invalid_request", err.message)
  }
  if (err instanceof PlaneExecUnconfinedError) {
    return errResult("runtime_constraint", err.message)
  }
  if (err instanceof CapabilityUnsupportedError) {
    // A capability toggled off in the descriptor — a MISSING capability, mapped to
    // runtime_constraint (same taxonomy as PlaneExecUnconfinedError), NOT invalid_request.
    return errResult("runtime_constraint", err.message)
  }
  if (err instanceof PlaneDisposedError) {
    // R3.3: op raced teardown — the plane was disposed mid-flight. Fail closed.
    return errResult("runtime_constraint", err.message)
  }
  if (err instanceof SandboxResourceGoneError) {
    // The container was externally removed mid-session (B13), OR the off-box VM
    // vanished and the cube plane already mapped its CubeProxy 502/503/504 to this
    // uniform error (#12b). No dedicated SynapseError code exists, so surface
    // runtime_constraint + a `resource_gone` detail; the dispatch/teardown spine
    // flips sandboxes.state='failed' and runs failed-commit preservation off it.
    return errResult("runtime_constraint", err.message, { resource_gone: true })
  }
  const message = err instanceof Error ? err.message : String(err)
  return errResult("runtime_constraint", message)
}

/**
 * CORE dispatch: (builtinKind, toolName, args) + ConfinementCtx → plane call →
 * McpDispatchResult. The grant match + ConfinementCtx derivation already ran in
 * the fork; CORE only validates arg shapes, lowers, caps, and maps results.
 */
export async function coreInvokeBarePlane(input: {
  plane: SandboxDataPlane
  builtinKind: string | null
  toolName: string
  args: Record<string, unknown>
  ctx: ConfinementCtx
}): Promise<McpDispatchResult> {
  const { plane, toolName, args, ctx } = input
  try {
    switch (toolName) {
      case "fs_stat": {
        const path = requirePath(args["path"])
        const st = await plane.stat(path, ctx)
        return textResult(st, { kind: st.kind })
      }
      case "list_dir": {
        // P5b: an omitted list_dir path defaults to the sandbox cwd
        // (/conversation, a granted mount) — the SAME default the auth layer
        // projects (buildRequestedAction's defaultPathPrefix for a sandbox) — so
        // list_dir({}) lists /conversation instead of "/", which no mount-scoped
        // grant covers and which the vfs would HARD-DENY (GrantPrefixDeniedError)
        // after passing the matcher. The bare data plane is ALWAYS a sandbox
        // context, so this default is unconditional here. (Every other fs tool
        // requires an explicit path via requirePath and is unaffected.)
        const path = asString(args["path"]) ?? DEFAULT_SANDBOX_CWD
        const entries = await plane.list(path, ctx)
        return textResult({ path, entries }, { entry_count: entries.length })
      }
      case "fs_read": {
        const path = requirePath(args["path"])
        const encoding = args["encoding"] === "base64" ? "base64" : "utf-8"
        const r = await plane.read(
          path,
          {
            maxBytes: parseNonNegInt(args["max_bytes"]),
            startByte: parseNonNegInt(args["start_byte"]),
            endByte: parseNonNegInt(args["end_byte"]),
          },
          ctx
        )
        // Encoding round-trip fallback (mirrors the RESIDENT builtin, filesystem.ts
        // ~L1144). When the caller did NOT request base64, decode utf-8 and re-encode:
        // if the bytes do NOT survive the round-trip (non-UTF-8/binary), return BASE64
        // instead of force-decoding binary to U+FFFD replacement chars (silent
        // corruption). The CHOSEN encoding is reflected on BOTH the body's `encoding`
        // field AND the _meta — never left as the requested value.
        let content: string
        let chosenEncoding: "utf-8" | "base64" = encoding
        let encodingFallback = false
        if (encoding === "utf-8") {
          const decoded = Buffer.from(r.bytes).toString("utf8")
          if (
            Buffer.compare(
              Buffer.from(decoded, "utf8"),
              Buffer.from(r.bytes)
            ) === 0
          ) {
            content = decoded
          } else {
            content = Buffer.from(r.bytes).toString("base64")
            chosenEncoding = "base64"
            encodingFallback = true
          }
        } else {
          content = Buffer.from(r.bytes).toString("base64")
        }
        return textResult(
          {
            path,
            encoding: chosenEncoding,
            content,
            total_size: r.totalSize,
            truncated: r.truncated,
          },
          {
            encoding: chosenEncoding,
            total_size: r.totalSize,
            truncated: r.truncated,
            ...(encodingFallback ? { encoding_fallback: true } : {}),
          }
        )
      }
      case "fs_write": {
        const path = requirePath(args["path"])
        const content = asString(args["content"])
        if (content === undefined) {
          return errResult("invalid_request", "content is required")
        }
        const encoding = args["encoding"] === "base64" ? "base64" : "utf-8"
        let bytes: Uint8Array
        try {
          // STRICT decode: Buffer.from(x,'base64') silently drops non-alphabet
          // chars → truncated/garbage bytes written with no error (silent data
          // corruption). decodeWriteContent validates and throws on malformed b64.
          bytes = decodeWriteContent(content, encoding)
        } catch (err) {
          return errResult(
            "invalid_request",
            err instanceof Error ? err.message : String(err)
          )
        }
        const res = await plane.write(
          path,
          bytes,
          {
            createParents: asBool(args["create_parents"]) ?? false,
            expectedSha256: parseExpectedSha256(args["expected_sha256"]),
            // P6: accept the fractional mtime (asNumber, not asInt) so the
            // stale-write guard is honored instead of silently dropped; a
            // present-but-unparseable value fails closed (invalid_request).
            expectedMtimeMs: parseExpectedMtimeMs(args["expected_mtime_ms"]),
          },
          ctx
        )
        return textResult(
          {
            path,
            bytes_written: res.bytesWritten,
            sha256: res.sha256,
            mtime_ms: res.mtimeMs,
          },
          { bytes_written: res.bytesWritten }
        )
      }
      case "fs_edit": {
        return await coreEdit(plane, args, ctx)
      }
      case "fs_mkdir": {
        const path = requirePath(args["path"])
        const res = await plane.mkdir(
          path,
          { recursive: asBool(args["recursive"]) ?? false },
          ctx
        )
        return textResult(
          { path, created: res.created },
          { created: res.created }
        )
      }
      case "fs_move": {
        const source = requirePath(args["source"], "source")
        const destination = requirePath(args["destination"], "destination")
        const res = await plane.move(
          source,
          destination,
          {
            overwrite: asBool(args["overwrite"]) ?? false,
            expectedSourceSha256:
              asString(args["expected_source_sha256"]) ?? null,
          },
          ctx
        )
        return textResult(
          { source, destination, mtime_ms: res.mtimeMs },
          { moved: true }
        )
      }
      case "fs_remove": {
        const path = requirePath(args["path"])
        const res = await plane.remove(
          path,
          { recursive: asBool(args["recursive"]) ?? false },
          ctx
        )
        return textResult(
          { path, removed: res.removed },
          { removed: res.removed }
        )
      }
      case "fs_search": {
        const mode = args["mode"] === "path" ? "path" : "content"
        const query = asString(args["query"]) ?? ""
        const out = await plane.search(
          {
            mode,
            query,
            regex: asBool(args["regex"]) ?? false,
            glob: asString(args["glob"]),
            limit: parseNonNegInt(args["limit"]) ?? 100,
            offset: parseNonNegInt(args["offset"]) ?? 0,
          },
          ctx
        )
        return textResult(
          { mode, query, hits: out.hits, truncated: out.truncated },
          { hit_count: out.hits.length }
        )
      }
      case "bash":
      case "exec_file": {
        return await coreExec(plane, toolName, args, ctx)
      }
      default:
        return errResult(
          "invalid_request",
          `bare data plane does not handle tool ${toolName}`
        )
    }
  } catch (err) {
    return mapPlaneError(err)
  }
}

async function coreEdit(
  plane: SandboxDataPlane,
  args: Record<string, unknown>,
  ctx: ConfinementCtx
): Promise<McpDispatchResult> {
  const path = requirePath(args["path"])
  const rawEdits = args["edits"]
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    return errResult("invalid_request", "edits (non-empty array) is required")
  }
  // Caller optimistic-concurrency preconditions (P6-schema). The bare fs_edit
  // schema ADVERTISES expected_sha256/expected_mtime_ms, so they must be HONORED
  // — pre-checked against a fresh read/stat of the target and rejected on
  // mismatch — never silently dropped (a dropped precondition is a silent
  // lost-update). expected_mtime_ms fails CLOSED on an unparseable value
  // (parseExpectedMtimeMs throws PlaneCapError → invalid_request).
  const callerExpectedMtimeMs = parseExpectedMtimeMs(args["expected_mtime_ms"])
  const callerExpectedSha = parseExpectedSha256(args["expected_sha256"])
  // Read current (utf-8), apply old→new sequentially, write back with a CAS
  // expectation on the prior sha (mirrors the resident edit's stale-write guard).
  const cur = await plane.read(path, {}, ctx)
  if (cur.truncated) {
    return errResult("runtime_constraint", "edit_source_too_large")
  }
  // Caller sha precondition: cur.bytes IS the freshly-read current content, so
  // hashing it is exactly the fresh-hash pre-check fs_write does. A mismatch
  // means the file already differs from what the caller expected → stale_write,
  // rejected BEFORE any mutation.
  if (callerExpectedSha !== null) {
    const curSha = createHash("sha256")
      .update(Buffer.from(cur.bytes))
      .digest("hex")
    if (curSha !== callerExpectedSha) {
      throw new StaleWriteError("pre_open", path)
    }
  }
  // Reject a non-UTF-8 target instead of a lossy decode. Buffer.toString('utf-8')
  // replaces invalid byte sequences with U+FFFD, so an edit that "found" old_string
  // in the mangled text would write BACK corrupted bytes over the original binary
  // (silent data corruption). A fatal TextDecoder throws on the first invalid byte.
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(cur.bytes)
  } catch {
    return errResult("runtime_constraint", `edit_source_not_utf8: ${path}`)
  }
  for (const raw of rawEdits) {
    if (typeof raw !== "object" || raw === null) {
      return errResult("invalid_request", "each edit must be an object")
    }
    const e = raw as Record<string, unknown>
    const oldStr = asString(e["old_string"])
    const newStr = asString(e["new_string"])
    if (oldStr === undefined || newStr === undefined) {
      return errResult(
        "invalid_request",
        "edit requires old_string and new_string"
      )
    }
    if (oldStr.length === 0) {
      return errResult("invalid_request", "old_string must be non-empty")
    }
    if (!text.includes(oldStr)) {
      return errResult(
        "runtime_constraint",
        `edit old_string not found in ${path}`
      )
    }
    text =
      asBool(e["replace_all"]) === true
        ? text.split(oldStr).join(newStr)
        : text.replace(oldStr, newStr)
  }
  const priorStat = await plane.stat(path, ctx)
  const bytes = new Uint8Array(Buffer.from(text, "utf-8"))
  const res = await plane.write(
    path,
    bytes,
    {
      createParents: false,
      // Stale-write guard (read-modify-write CAS): expect the file to still hold the
      // EXACT content we read at the top of this edit. If a concurrent writer changed
      // it between our read and this write, the sha no longer matches and the write is
      // rejected — preventing a silent lost update. `undefined` here would DISABLE the
      // guard (the bug this replaces). null = must-not-exist (file was gone at stat).
      expectedSha256: priorStat.exists
        ? createHash("sha256").update(Buffer.from(cur.bytes)).digest("hex")
        : null,
      // Caller mtime precondition (P6-schema): honored ATOMICALLY inside the
      // write's path lock against a fresh stat — a stale mtime ⇒ StaleWriteError.
      // null when the caller supplied none (no-op).
      expectedMtimeMs: callerExpectedMtimeMs,
    },
    ctx
  )
  return textResult(
    { path, bytes_written: res.bytesWritten, sha256: res.sha256 },
    { bytes_written: res.bytesWritten }
  )
}

async function coreExec(
  plane: SandboxDataPlane,
  toolName: "bash" | "exec_file",
  args: Record<string, unknown>,
  ctx: ConfinementCtx
): Promise<McpDispatchResult> {
  // cwd default applied AFTER matching (matching already ran on the virtual path).
  const cwd = asString(args["working_directory"]) || DEFAULT_SANDBOX_CWD
  const timeoutMs = parseNonNegInt(args["timeout_ms"])
  const payload: SandboxExecPayload =
    toolName === "bash"
      ? {
          executor: "bash",
          command: asString(args["command"]) ?? "",
          cwd,
          timeoutMs,
        }
      : {
          executor: "exec_file",
          program: asString(args["program"]) ?? "",
          args: Array.isArray(args["args"])
            ? (args["args"] as unknown[]).filter(
                (v): v is string => typeof v === "string"
              )
            : [],
          cwd,
          timeoutMs,
        }
  const res = await plane.exec(payload, ctx)
  return {
    ok: true,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            exit_code: res.exitCode,
            stdout: res.stdout,
            stderr: res.stderr,
            truncated: res.truncated,
            killed: res.killed,
          }),
        },
      ],
      // A non-zero exit or a killed command is a FAILED command — flag it so the
      // agent loop / auto-retry can tell it failed (the resident commandline builtin
      // sets this identically, commandline.ts ~L562). Without it every command,
      // including a crash, looked like a success to downstream handling.
      isError: res.exitCode !== 0 || res.killed,
      _meta: { exit_code: res.exitCode, killed: res.killed },
    },
  }
}

function requirePath(value: unknown, name = "path"): string {
  const s = asString(value)
  if (!s) throw new CanonicalPathError("invalid_path", `${name} is required`)
  return s
}

/**
 * Strict content decode for fs_write (mirrors the resident builtin's
 * decodeWriteContent). Node's `Buffer.from(x, 'base64')` is LENIENT: it silently
 * strips any character outside the base64 alphabet and truncates at the first `=`,
 * so a corrupt payload decodes to shorter/garbage bytes with NO error and is
 * written verbatim — silent data corruption. Validate the alphabet, padding, and
 * length BEFORE decoding and throw on malformed input. utf-8 strings are always
 * valid JS strings, so they pass straight through. Whitespace inside base64 is
 * tolerated (stripped) to match the resident surface. The per-op size cap is
 * enforced downstream in the plane's write() (maxWriteBytes), not here.
 */
function decodeWriteContent(
  content: string,
  encoding: "utf-8" | "base64"
): Uint8Array {
  if (encoding === "utf-8") {
    return new Uint8Array(Buffer.from(content, "utf8"))
  }
  const cleaned = content.replace(/\s+/g, "")
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    throw new Error("invalid_base64: alphabet/padding check failed")
  }
  if (cleaned.length % 4 !== 0) {
    throw new Error("invalid_base64: clean length is not a multiple of 4")
  }
  return new Uint8Array(Buffer.from(cleaned, "base64"))
}
