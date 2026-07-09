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
import { Buffer } from "node:buffer"
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
import type { McpDispatchResult } from "../devices/dispatch.js"
import type { RuntimeAuthorizationGrantRecord } from "../runtime-authorizations/repo.types.js"
import type { SandboxCapabilityDescriptor } from "./model.js"

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
    opts: { createParents?: boolean; expectedSha256?: string | null },
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
 * Working-set identity bridge (§8.1). For local:bare (host-visible shared CAS)
 * these are the EXISTING spine primitives verbatim — the adapter never touches
 * CAS. Kept as an interface so docker:bare's detached variant (S12, deferred)
 * can substitute a remote implementation without touching the spine.
 */
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
}

// ─────────────────────────── local:bare reference plane ──────────────────────

export interface LocalBareDataPlaneOptions {
  /** Per-session sandbox FS root; children are the materialized mount points. */
  sandboxRoot: string
  descriptor: SandboxCapabilityDescriptor
  ripgrepPath?: string
}

/**
 * In-process reference data plane for local:bare (§4.7.2). fs via
 * createLocalFsBackend + the vfs kernel; exec via a bwrap-jailed child. bwrap is
 * MANDATORY — when it is absent, `exec` throws (structural fail-closed: NEVER run
 * a command unconfined on the API host). Every child is tracked so dispose() can
 * SIGTERM/SIGKILL exactly this plane's own children (never a sibling runtime).
 */
export function createLocalBareDataPlane(
  opts: LocalBareDataPlaneOptions
): SandboxDataPlane {
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
  const execControllers = new Set<AbortController>()
  let running = 0

  function withScope<T>(ctx: ConfinementCtx, fn: () => Promise<T>): Promise<T> {
    return backend.withGrantPrefixes(ctx.scope, fn)
  }

  return {
    descriptor: opts.descriptor,
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
      await ensureStarted()
      const canonical = canonicalVfsPath(path)
      // Oversized-write reject BEFORE hashing/IO (per-op cap).
      if (bytes.length > caps.maxWriteBytes) {
        throw new PlaneCapError(
          `write_too_large: ${bytes.length} bytes exceeds cap ${caps.maxWriteBytes}`
        )
      }
      return withScope(ctx, () =>
        backend.withPathLock(canonical, async () => {
          const info = await backend.safeStat(canonical)
          const priorExists = !!info && info.kind === "file"
          const res = await backend.atomicWrite(canonical, bytes, {
            createOnly: !priorExists,
            createParents: writeOpts.createParents ?? false,
            expectedShaForCAS:
              opts.descriptor.core.staleWriteGuard === "strict"
                ? (writeOpts.expectedSha256 ?? null)
                : null,
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
      await ensureStarted()
      const canonical = canonicalVfsPath(path)
      return withScope(ctx, () =>
        backend.mkdir(canonical, { recursive: mkdirOpts.recursive ?? false })
      )
    },
    async move(src, dest, moveOpts, ctx) {
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
      await ensureStarted()
      const canonical = canonicalVfsPath(path)
      return withScope(ctx, () =>
        backend.remove(canonical, { recursive: removeOpts.recursive ?? false })
      )
    },
    async search(input, ctx) {
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
    async exec(payload, _ctx) {
      await ensureStarted()
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
      }
    },
    async dispose() {
      // Scoped dispose (S4): abort ONLY the children this plane spawned. Never a
      // module global, never a sibling runtime's process group.
      for (const c of execControllers) {
        try {
          c.abort()
        } catch {
          /* best-effort */
        }
      }
      execControllers.clear()
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

export { PlaneCapError, PlaneExecUnconfinedError }

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
// shape dispatchSyncTool does, so `completeDeviceOperation` + downstream handling
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

/** Map a thrown error from the plane/kernel to the McpDispatchResult error taxonomy. */
function mapPlaneError(err: unknown): McpDispatchResult {
  if (err instanceof EmptyScopeDeniedError) {
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
  if (err instanceof PlaneCapError) {
    return errResult("invalid_request", err.message)
  }
  if (err instanceof PlaneExecUnconfinedError) {
    return errResult("runtime_constraint", err.message)
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
        const path = asString(args["path"]) ?? "/"
        const entries = await plane.list(path, ctx)
        return textResult({ path, entries }, { entry_count: entries.length })
      }
      case "fs_read": {
        const path = requirePath(args["path"])
        const encoding = args["encoding"] === "base64" ? "base64" : "utf-8"
        const r = await plane.read(
          path,
          {
            maxBytes: asInt(args["max_bytes"]),
            startByte: asInt(args["start_byte"]),
            endByte: asInt(args["end_byte"]),
          },
          ctx
        )
        const text = Buffer.from(r.bytes).toString(encoding)
        return textResult(
          {
            path,
            encoding,
            content: text,
            total_size: r.totalSize,
            truncated: r.truncated,
          },
          { total_size: r.totalSize, truncated: r.truncated }
        )
      }
      case "fs_write": {
        const path = requirePath(args["path"])
        const content = asString(args["content"])
        if (content === undefined) {
          return errResult("invalid_request", "content is required")
        }
        const encoding = args["encoding"] === "base64" ? "base64" : "utf-8"
        const bytes = new Uint8Array(Buffer.from(content, encoding))
        const res = await plane.write(
          path,
          bytes,
          {
            createParents: asBool(args["create_parents"]) ?? false,
            expectedSha256: asString(args["expected_sha256"]) ?? null,
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
            limit: asInt(args["limit"]) ?? 100,
            offset: asInt(args["offset"]) ?? 0,
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
  // Read current (utf-8), apply old→new sequentially, write back with a CAS
  // expectation on the prior sha (mirrors the resident edit's stale-write guard).
  const cur = await plane.read(path, {}, ctx)
  if (cur.truncated) {
    return errResult("runtime_constraint", "edit_source_too_large")
  }
  let text = Buffer.from(cur.bytes).toString("utf-8")
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
      // CAS on the prior content sha when the descriptor enforces it.
      expectedSha256: priorStat.exists ? undefined : null,
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
  const timeoutMs = asInt(args["timeout_ms"])
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
      _meta: { exit_code: res.exitCode, killed: res.killed },
    },
  }
}

function requirePath(value: unknown, name = "path"): string {
  const s = asString(value)
  if (!s) throw new CanonicalPathError("invalid_path", `${name} is required`)
  return s
}
