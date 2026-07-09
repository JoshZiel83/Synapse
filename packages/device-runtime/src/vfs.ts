// VFS — Virtual File System projection inside the device runtime. Per spec
// §6 Notes, VFS is NOT a capability_kind — it is a projection layered on top
// of filesystem / browser / cua exposures. v3 fs hardening adds a strict
// canonicalize gate, atomic write via tmp+rename, per-path mutex, streaming
// hash, realpath grant recheck, and reserved internal namespace.

import { constants as fsConstants, promises as fsp } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { AsyncLocalStorage } from "node:async_hooks"
import { dirname, relative, resolve, sep } from "node:path"
import {
  filesystemPolicyAllows,
  type Timestamp,
  type FilesystemPolicyShape,
} from "@synapse/shared"
import { dateToIsoInstant, nowIsoInstant } from "@synapse/shared/datetime"

export type VfsNodeKind = "directory" | "file" | "symlink" | "other"

export interface VfsEntry {
  name: string
  path: string
  kind: VfsNodeKind
  size?: number
  writable?: boolean
  mimeType?: string
  modTime?: string
}

export interface VfsReadResult {
  data: Uint8Array
  mimeType: string
  writable: boolean
}

export interface VfsWriteResult {
  data: Uint8Array
  mimeType: string
}

export interface VfsExposure {
  capability: "filesystem" | "browser" | "cua"
  stableKey: string
  name: string
  metadata?: Record<string, unknown>
}

export interface VfsSessionState {
  capability: VfsExposure["capability"]
  exposureStableKey: string
  sessionId: string
  runtimeSessionId: string
  selectedPageId?: number
  createdAt: Timestamp
}

export interface VfsBackend {
  start(): Promise<void>
  list(path: string): Promise<VfsEntry[]>
  stat(path: string): Promise<VfsEntry | null>
  read(path: string): Promise<VfsReadResult>
  write(path: string, data: Uint8Array): Promise<VfsWriteResult>
}

export interface VfsServiceOptions {
  backend: VfsBackend
}

// ─────────────────────────── reserved namespace ──────────────────────────────

export const INTERNAL_NAMESPACE = "/.synapse-internal"
const INTERNAL_NAMESPACE_PREFIX = "/.synapse-internal/"
export const INTERNAL_DIRNAME = ".synapse-internal"

const DOS_RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
])

export class CanonicalPathError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = "CanonicalPathError"
  }
}

export function canonicalVfsPath(input: string): string {
  if (typeof input !== "string") {
    throw new CanonicalPathError("invalid_path", "path must be a string")
  }
  if (input !== input.trim()) {
    throw new CanonicalPathError(
      "invalid_path",
      "leading/trailing whitespace not allowed"
    )
  }
  if (input.includes("\\")) {
    throw new CanonicalPathError(
      "invalid_path",
      "backslash not allowed (POSIX-only VFS)"
    )
  }
  if (/^[A-Za-z]:/.test(input)) {
    throw new CanonicalPathError(
      "invalid_path",
      "drive-letter prefix not allowed"
    )
  }
  if (input.includes(":")) {
    throw new CanonicalPathError(
      "invalid_path",
      "colon not allowed (ADS marker)"
    )
  }
  if (input === INTERNAL_NAMESPACE || input === `${INTERNAL_NAMESPACE}/`) {
    throw new CanonicalPathError("invalid_path", "reserved internal namespace")
  }
  const rawSegments = input.split("/").filter((s) => s.length > 0)
  for (const seg of rawSegments) {
    if (seg === "." || seg === "..") continue
    if (seg.endsWith(".") || seg.endsWith(" ")) {
      throw new CanonicalPathError(
        "invalid_path",
        `segment ends in '.' or ' ' (Windows-strip exploit): ${JSON.stringify(seg)}`
      )
    }
    const baseUpper = seg.split(".")[0]!.toUpperCase()
    if (DOS_RESERVED.has(baseUpper)) {
      throw new CanonicalPathError(
        "invalid_path",
        `segment is a DOS reserved name: ${JSON.stringify(seg)}`
      )
    }
  }
  const stack: string[] = []
  for (const seg of rawSegments) {
    if (seg === ".") continue
    if (seg === "..") {
      if (stack.length > 0) stack.pop()
      continue
    }
    stack.push(seg)
  }
  const canonical = `/${stack.join("/")}`
  if (
    canonical === INTERNAL_NAMESPACE ||
    canonical.startsWith(INTERNAL_NAMESPACE_PREFIX)
  ) {
    throw new CanonicalPathError("invalid_path", "reserved internal namespace")
  }
  return canonical
}

export function pathUnderPrefix(path: string, prefix: string): boolean {
  if (prefix === "/") return true
  if (path === prefix) return true
  return path.startsWith(`${prefix}/`)
}

export function collapsePrefixes(prefixes: readonly string[]): string[] {
  const seen = Array.from(new Set(prefixes)).sort()
  const out: string[] = []
  for (const p of seen) {
    if (out.some((kept) => pathUnderPrefix(p, kept))) continue
    out.push(p)
  }
  return out
}

// ─────────────────────────── grant-scope sentinels (S3B / F-C) ───────────────

/**
 * Grant-scope sentinel: request a whole-sandbox-ROOT grant. Passed to
 * withGrantPrefixes in place of a prefix array. Under it the realpath *prefix*
 * recheck is skipped, but the root-boundary escape check in safeResolve is
 * STILL enforced (root-jail). This is the ONLY legitimate way to opt into
 * whole-scope — an EMPTY prefix array is a structural deny-all, never
 * allow-all. Used by the degraded-descriptor branch (confinedFs:'unsupported')
 * and any caller holding a genuine whole-sandbox grant.
 */
export const WHOLE_SCOPE: unique symbol = Symbol("vfs.WHOLE_SCOPE")
export type WholeScope = typeof WHOLE_SCOPE

/**
 * Internal grant-store marker for an EXPLICIT empty prefix set. Every
 * safeResolve executed under it throws GrantPrefixDeniedError (structural
 * deny-all). This closes the pre-S3B fail-open: `withGrantPrefixes([])` used
 * to store `null`, which DISABLED the realpath recheck entirely (allow-all
 * anywhere under the sandbox root). Not exported — callers express intent with
 * a non-empty array (scoped), WHOLE_SCOPE (root-jail), or an empty array (deny).
 */
const GRANT_DENY_ALL: unique symbol = Symbol("vfs.GRANT_DENY_ALL")

/**
 * The four distinct grant states carried by the per-call AsyncLocalStorage:
 *   - non-empty readonly array → realpath prefix recheck against these prefixes
 *   - WHOLE_SCOPE              → recheck skipped, root boundary still enforced
 *   - GRANT_DENY_ALL          → every resolve denied (explicit empty set)
 *   - null                    → no grant frame established (store-unset /
 *                               construction fallback absent) — internal /
 *                               one-shot ops, recheck skipped (unchanged)
 */
type GrantScopeState =
  | readonly string[]
  | typeof WHOLE_SCOPE
  | typeof GRANT_DENY_ALL
  | null

// ─────────────────────────── VfsService ──────────────────────────────────────

export class VfsService {
  private exposures = new Map<string, VfsExposure>()
  private sessions = new Map<string, VfsSessionState>()
  private sessionSeq = 0

  constructor(private readonly opts: VfsServiceOptions) {}

  async start(): Promise<void> {
    await this.opts.backend.start()
  }

  registerExposure(exposure: VfsExposure): void {
    this.exposures.set(exposure.stableKey, exposure)
  }

  listExposures(): VfsExposure[] {
    return Array.from(this.exposures.values())
  }

  openSession(input: {
    capability: VfsExposure["capability"]
    exposureStableKey: string
    runtimeSessionId: string
  }): VfsSessionState {
    this.sessionSeq += 1
    const state: VfsSessionState = {
      capability: input.capability,
      exposureStableKey: input.exposureStableKey,
      sessionId: `vfs-${this.sessionSeq}`,
      runtimeSessionId: input.runtimeSessionId,
      createdAt: nowIsoInstant(),
    }
    this.sessions.set(state.sessionId, state)
    return state
  }

  closeSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  list(path: string): Promise<VfsEntry[]> {
    return this.opts.backend.list(path)
  }
  stat(path: string): Promise<VfsEntry | null> {
    return this.opts.backend.stat(path)
  }
  read(path: string): Promise<VfsReadResult> {
    return this.opts.backend.read(path)
  }
  write(path: string, data: Uint8Array): Promise<VfsWriteResult> {
    return this.opts.backend.write(path, data)
  }
}

// ─────────────────────────── extended backend ────────────────────────────────

const O_NOFOLLOW_FLAG: number =
  (fsConstants as unknown as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

export interface SafeStatInfo {
  size: number
  mtimeMs: number
  mode: number
  kind: VfsNodeKind
  isSymlink: boolean
}

export class GrantPrefixDeniedError extends Error {
  constructor(public canonical: string) {
    super(`realpath of ${canonical} is outside granted prefixes`)
    this.name = "GrantPrefixDeniedError"
  }
}

export class CrossMountError extends Error {
  constructor(public canonical: string) {
    super(`atomic write across mount boundary: ${canonical}`)
    this.name = "CrossMountError"
  }
}

export type StaleWritePhase =
  | "pre_open"
  | "pre_create"
  | "pre_rename"
  | "pre_delete"

export class StaleWriteError extends Error {
  constructor(
    public phase: StaleWritePhase,
    public canonical: string
  ) {
    super(`stale_write_detected: ${phase} on ${canonical}`)
    this.name = "StaleWriteError"
  }
}

export class InternalTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InternalTokenError"
  }
}

const TMP_TOKEN_RE = /^tmp-[0-9a-f]{32}$/
const RESTORE_TOKEN_RE = /^restore-[0-9a-f]{32}$/

export function generateTmpToken(): string {
  return `tmp-${randomBytes(16).toString("hex")}`
}

export function generateRestoreToken(): string {
  return `restore-${randomBytes(16).toString("hex")}`
}

export interface ExtendedLocalBackend extends VfsBackend {
  safeResolve(canonical: string): Promise<string>
  safeStat(canonical: string): Promise<SafeStatInfo | null>
  streamSha256(
    canonical: string,
    opts?: { maxBytes?: number }
  ): Promise<{ sha256: string | null; size: number; truncated: boolean }>
  readBytes(
    canonical: string,
    opts?: { startByte?: number; endByte?: number; maxBytes?: number }
  ): Promise<{
    bytes: Uint8Array
    totalSize: number
    truncated: boolean
    mtimeMs: number
  }>
  atomicWrite(
    canonical: string,
    bytes: Uint8Array,
    opts: {
      createOnly?: boolean
      createParents?: boolean
      expectedShaForCAS?: string | null
    }
  ): Promise<{ sha256: string; mtimeMs: number; bytesWritten: number }>
  deleteFile(
    canonical: string,
    opts: { expectedShaForCAS?: string }
  ): Promise<void>
  /**
   * Create a directory (S3). safeResolve confines the target to the active
   * grant scope + root boundary before creating. `recursive` creates missing
   * ancestors — every ancestor of a within-grant path is itself within the
   * grant subtree/root, so recursion cannot escape.
   */
  mkdir(
    canonical: string,
    opts: { recursive?: boolean }
  ): Promise<{ created: boolean }>
  /**
   * Rename/move (S3). safeResolve is run on BOTH endpoints so a single grant
   * frame (F-C) authorizes src AND dest — never a split frame that could
   * authorize dest under a src-only prefix. Cross-mount rename → CrossMountError.
   */
  move(
    src: string,
    dest: string,
    opts: { expectedSourceSha?: string | null; overwrite?: boolean }
  ): Promise<{ mtimeMs: number }>
  /**
   * Remove a file or directory (S3). safeResolve confines the target; `recursive`
   * removes a subtree but stays inside the grant subtree because safeResolve
   * already denied any path outside it. `force:false` so a missing target errors.
   */
  remove(
    canonical: string,
    opts: { recursive?: boolean }
  ): Promise<{ removed: boolean }>
  renameInternalTmpInto(opts: {
    kind: "tmp" | "restore"
    token: string
    destCanonical: string
    expectedShaForCAS?: string | null
    expectedSourceSha?: string | null
  }): Promise<{ sha256: string; mtimeMs: number; bytesWritten: number }>
  resolveInternalPath(kind: "tmp" | "restore", token: string): string
  withPathLock<T>(canonical: string, fn: () => Promise<T>): Promise<T>
  /**
   * Establish a grant frame for the duration of `fn` (S3B / F-C):
   *   - non-empty array → realpath recheck confines resolves to these prefixes
   *   - WHOLE_SCOPE     → root-jail (recheck skipped; root boundary enforced)
   *   - EMPTY array     → structural deny-all (every resolve throws)
   * There is no allow-all: an empty set can NEVER widen access.
   */
  withGrantPrefixes<T>(
    prefixes: readonly string[] | WholeScope,
    fn: () => Promise<T>
  ): Promise<T>
  realpathToCanonical(hostPath: string): string | null
  readonly hostRootPath: string
  readonly hostRootWithSep: string
}

export interface LocalFsBackendOptions {
  rootPath: string
  /**
   * When provided + non-empty, every safeResolve does a realpath grant recheck
   * against these canonical prefixes. Set via withGrantPrefixes() per-call by
   * the filesystem builtin; absence disables the recheck (used by tests and
   * by callers that enforce auth at a higher layer).
   */
  initialGrantPrefixes?: readonly string[]
}

interface InternalState {
  pathLocks: Map<string, Promise<void>>
  // Concurrent tool calls must NOT share grant prefixes — AsyncLocalStorage
  // gives each invocation its own context, preventing a wide-grant call
  // from leaking permissions into a concurrent narrow-grant call.
  grantPrefixStore: AsyncLocalStorage<GrantScopeState>
  // Fallback for direct backend consumers that set prefixes at construction
  // time (no per-call wrapping). Tests use this.
  fallbackGrantPrefixes: readonly string[] | null
}

export function createLocalFsBackend(
  opts: LocalFsBackendOptions
): ExtendedLocalBackend {
  const hostRootPath = resolve(opts.rootPath)
  const hostRootWithSep = hostRootPath.endsWith(sep)
    ? hostRootPath
    : hostRootPath + sep
  const internalDirAbs = resolve(hostRootPath, INTERNAL_DIRNAME)
  const internalTmpAbs = resolve(internalDirAbs, "tmp")
  const internalRestoreAbs = resolve(internalDirAbs, "restore")

  const state: InternalState = {
    pathLocks: new Map(),
    grantPrefixStore: new AsyncLocalStorage<GrantScopeState>(),
    fallbackGrantPrefixes:
      opts.initialGrantPrefixes && opts.initialGrantPrefixes.length > 0
        ? [...opts.initialGrantPrefixes]
        : null,
  }

  function currentGrantPrefixes(): GrantScopeState {
    // AsyncLocalStorage carries the per-call value; fall back to the
    // construction-time prefixes (tests) when no call frame is active.
    const fromStore = state.grantPrefixStore.getStore()
    if (fromStore !== undefined) return fromStore
    return state.fallbackGrantPrefixes
  }

  function realpathToCanonical(hostPath: string): string | null {
    if (hostPath === hostRootPath) return "/"
    if (!hostPath.startsWith(hostRootWithSep)) return null
    const rel = relative(hostRootPath, hostPath)
    if (rel.startsWith("..")) return null
    return `/${rel.split(sep).join("/")}`
  }

  // Walk back ancestors of a non-existent target until we find one that exists,
  // realpath that existing ancestor, then re-append EVERY missing segment down
  // to the target — including `cursor`'s own segment at the boundary. (Fix:
  // the pre-S3 version dropped the boundary segment, so it returned the nearest
  // existing ancestor instead of the full target realpath. That was harmless
  // for a 1-deep-missing write — the parent is still under the grant — but a
  // ≥2-deep-missing target, e.g. a recursive mkdir /work/a/b under a `/work`
  // grant, reconstructed to `/a/b` and was falsely denied. The missing tail
  // cannot introduce a symlink because it does not exist yet, so appending it
  // is a precise, not-widening approximation for the realpath grant recheck.)
  async function realpathOfPossiblyMissing(candidate: string): Promise<string> {
    try {
      return await fsp.realpath(candidate)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== "ENOENT") throw err
    }
    let cursor = candidate
    const tail: string[] = []
    // Climb until we hit an existing ancestor (root always exists).
    while (true) {
      const parent = dirname(cursor)
      if (parent === cursor) {
        // Reached `/`; shouldn't happen for paths inside hostRootPath.
        return candidate
      }
      try {
        const realParent = await fsp.realpath(parent)
        // `cursor` is the (missing) child of the found existing `parent`; its
        // own segment must be included alongside the deeper climbed segments.
        tail.push(cursor.slice(parent.length + 1))
        tail.reverse()
        return resolve(realParent, ...tail)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== "ENOENT") throw err
        tail.push(cursor.slice(parent.length + 1))
        cursor = parent
      }
    }
  }

  async function safeResolve(canonical: string): Promise<string> {
    if (typeof canonical !== "string" || !canonical.startsWith("/")) {
      throw new CanonicalPathError(
        "invalid_path",
        "safeResolve requires a canonical VFS path"
      )
    }
    // Internal namespace paths must not pass through here — they use
    // resolveInternalPath. The canonical gate already prevents user-input
    // from reaching this branch, but direct callers (tests) could.
    if (
      canonical === INTERNAL_NAMESPACE ||
      canonical.startsWith(INTERNAL_NAMESPACE_PREFIX)
    ) {
      throw new CanonicalPathError(
        "invalid_path",
        "safeResolve called on reserved namespace"
      )
    }
    const candidate = resolve(hostRootPath, canonical.slice(1))
    const real = await realpathOfPossiblyMissing(candidate)
    if (real !== hostRootPath && !real.startsWith(hostRootWithSep)) {
      throw new CanonicalPathError(
        "invalid_path",
        `path escapes root via realpath: ${canonical}`
      )
    }
    // Realpath grant recheck (closes /allowed/link -> /secret bypass).
    // The active grant state comes from AsyncLocalStorage so concurrent tool
    // calls each see their own scope, not a shared mutable field.
    //
    // S3B / F-C — four distinct states, checked in order so an empty set can
    // NEVER widen access:
    //   GRANT_DENY_ALL → explicit empty prefix set ⇒ deny every resolve.
    //   WHOLE_SCOPE    → root-jail: prefix recheck skipped, but the root
    //                    boundary escape check above already ran.
    //   array          → confine realpath to one of these prefixes.
    //   null           → no grant frame (internal / one-shot) ⇒ recheck skipped
    //                    (unchanged pre-S3B behavior for legitimate internal ops).
    const grants = currentGrantPrefixes()
    if (grants === GRANT_DENY_ALL) {
      throw new GrantPrefixDeniedError(canonical)
    }
    if (grants !== WHOLE_SCOPE && grants) {
      const realCanonical = realpathToCanonical(real)
      if (realCanonical === null) {
        throw new GrantPrefixDeniedError(canonical)
      }
      const ok = grants.some((p) => pathUnderPrefix(realCanonical, p))
      if (!ok) throw new GrantPrefixDeniedError(canonical)
    }
    // lstat: reject special files. Symlinks at the final component are
    // allowed by this stage (they were already realpath'd above and the
    // grant recheck reflects the target); read/write use O_NOFOLLOW which
    // refuses to follow a final-component symlink at open time, so an
    // attacker-planted post-resolve symlink swap is caught by the OS, not
    // here. Tests cover both legitimate use and the residual disclosure.
    try {
      const st = await fsp.lstat(candidate)
      if (
        st.isCharacterDevice() ||
        st.isBlockDevice() ||
        st.isFIFO() ||
        st.isSocket()
      ) {
        throw new CanonicalPathError(
          "invalid_path",
          `target is a special file (char/block/fifo/socket)`
        )
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== "ENOENT") throw err
      // not-yet-existent target is fine (writes create it).
    }
    return candidate
  }

  async function safeStat(canonical: string): Promise<SafeStatInfo | null> {
    let candidate: string
    try {
      candidate = await safeResolve(canonical)
    } catch {
      return null
    }
    try {
      const st = await fsp.lstat(candidate)
      let kind: VfsNodeKind
      if (st.isSymbolicLink()) kind = "symlink"
      else if (st.isDirectory()) kind = "directory"
      else if (st.isFile()) kind = "file"
      else kind = "other"
      return {
        size: st.size,
        mtimeMs: st.mtimeMs,
        mode: st.mode,
        kind,
        isSymlink: st.isSymbolicLink(),
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") return null
      throw err
    }
  }

  async function openNoFollow(
    canonical: string,
    flags: number
  ): Promise<fsp.FileHandle> {
    const host = await safeResolve(canonical)
    return fsp.open(host, flags | O_NOFOLLOW_FLAG)
  }

  async function streamSha256(
    canonical: string,
    sopts?: { maxBytes?: number }
  ): Promise<{ sha256: string | null; size: number; truncated: boolean }> {
    const host = await safeResolve(canonical)
    const stat = await fsp.lstat(host)
    if (!stat.isFile()) {
      throw new Error(`streamSha256: not a regular file: ${canonical}`)
    }
    if (sopts?.maxBytes !== undefined && stat.size > sopts.maxBytes) {
      return { sha256: null, size: stat.size, truncated: true }
    }
    // O_NOFOLLOW closes the lstat-vs-open swap window. createReadStream
    // would silently follow a final-component symlink planted between the
    // safeResolve check and here, and the resulting hash would name the
    // symlink target's content — which is exactly how a snapshot could
    // record sensitive content under an unprivileged path.
    const fh = await fsp.open(host, fsConstants.O_RDONLY | O_NOFOLLOW_FLAG)
    try {
      const hash = createHash("sha256")
      const stream = fh.createReadStream({
        autoClose: false,
        highWaterMark: 64 * 1024,
      })
      let bytes = 0
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        hash.update(chunk)
        bytes += chunk.length
      }
      return { sha256: hash.digest("hex"), size: bytes, truncated: false }
    } finally {
      await fh.close().catch(() => {})
    }
  }

  async function readBytes(
    canonical: string,
    sopts?: { startByte?: number; endByte?: number; maxBytes?: number }
  ): Promise<{
    bytes: Uint8Array
    totalSize: number
    truncated: boolean
    mtimeMs: number
  }> {
    const fh = await openNoFollow(canonical, fsConstants.O_RDONLY)
    try {
      const st = await fh.stat()
      const totalSize = st.size
      const mtimeMs = st.mtimeMs
      const start = sopts?.startByte ?? 0
      let end = sopts?.endByte ?? totalSize
      if (start < 0 || start > totalSize) {
        throw new Error(`readBytes: start_byte out of range`)
      }
      if (end < start) {
        throw new Error(`readBytes: end_byte < start_byte`)
      }
      if (end > totalSize) end = totalSize
      const windowSize = end - start
      const cap = sopts?.maxBytes ?? windowSize
      const readSize = Math.min(windowSize, cap)
      const truncated = readSize < windowSize
      const buf = Buffer.alloc(readSize)
      if (readSize > 0) {
        await fh.read({ buffer: buf, position: start, length: readSize })
      }
      return {
        bytes: new Uint8Array(buf),
        totalSize,
        truncated,
        mtimeMs,
      }
    } finally {
      await fh.close().catch(() => {})
    }
  }

  function resolveInternalPath(kind: "tmp" | "restore", token: string): string {
    if (kind !== "tmp" && kind !== "restore") {
      throw new InternalTokenError(`invalid internal kind: ${kind}`)
    }
    const re = kind === "tmp" ? TMP_TOKEN_RE : RESTORE_TOKEN_RE
    if (!re.test(token)) {
      throw new InternalTokenError(
        `invalid ${kind} token format: ${JSON.stringify(token)}`
      )
    }
    const baseDir = kind === "tmp" ? internalTmpAbs : internalRestoreAbs
    return resolve(baseDir, token)
  }

  async function withPathLock<T>(
    canonical: string,
    fn: () => Promise<T>
  ): Promise<T> {
    while (state.pathLocks.has(canonical)) {
      try {
        await state.pathLocks.get(canonical)
      } catch {
        /* swallow — the lock-holder's error is theirs, not ours */
      }
    }
    let resolve!: () => void
    const lock = new Promise<void>((r) => (resolve = r))
    state.pathLocks.set(canonical, lock)
    try {
      return await fn()
    } finally {
      state.pathLocks.delete(canonical)
      resolve()
    }
  }

  async function withGrantPrefixes<T>(
    prefixes: readonly string[] | WholeScope,
    fn: () => Promise<T>
  ): Promise<T> {
    // S3B / F-C: the empty array no longer collapses to null (allow-all).
    //   WHOLE_SCOPE → root-jail sentinel
    //   non-empty   → frozen prefix array (realpath recheck)
    //   empty       → GRANT_DENY_ALL (structural deny — every resolve throws)
    let scoped: GrantScopeState
    if (prefixes === WHOLE_SCOPE) {
      scoped = WHOLE_SCOPE
    } else if (prefixes.length === 0) {
      scoped = GRANT_DENY_ALL
    } else {
      scoped = Object.freeze([...prefixes])
    }
    return await state.grantPrefixStore.run(scoped, fn)
  }

  async function atomicWrite(
    canonical: string,
    bytes: Uint8Array,
    aopts: {
      createOnly?: boolean
      createParents?: boolean
      expectedShaForCAS?: string | null
    }
  ): Promise<{ sha256: string; mtimeMs: number; bytesWritten: number }> {
    const destHost = await safeResolve(canonical)
    const parent = dirname(destHost)
    if (aopts.createParents) {
      await fsp.mkdir(parent, { recursive: true })
      // re-resolve parent now that it exists (and any intermediate dirs)
      await safeResolve(canonical)
    }
    // create-only initial check: destination must be absent.
    if (aopts.createOnly) {
      try {
        await fsp.lstat(destHost)
        throw new StaleWriteError("pre_create", canonical)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== "ENOENT") throw err
      }
    }
    const token = generateTmpToken()
    const tmpHost = resolveInternalPath("tmp", token)
    // O_CREAT|O_EXCL|0600 — refuse to clobber any planted tmp.
    const tmpFh = await fsp.open(
      tmpHost,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600
    )
    try {
      let sha: string
      let bytesWritten: number
      try {
        await tmpFh.writeFile(bytes)
        const hash = createHash("sha256")
        hash.update(bytes)
        sha = hash.digest("hex")
        bytesWritten = bytes.length
        await tmpFh.sync()
      } finally {
        await tmpFh.close().catch(() => {})
      }
      // Re-resolve parent immediately before rename — if parent was swapped
      // to point outside root mid-flight, abort.
      const parentReresolved = dirname(await safeResolve(canonical))
      if (parentReresolved !== parent) {
        await fsp.unlink(tmpHost).catch(() => {})
        throw new CanonicalPathError(
          "invalid_path",
          `parent dir changed during write: ${canonical}`
        )
      }
      // Final pre-rename CAS:
      //   - createOnly: destination still absent
      //   - expectedShaForCAS != null: destination still has that sha
      if (aopts.createOnly) {
        try {
          await fsp.lstat(destHost)
          await fsp.unlink(tmpHost).catch(() => {})
          throw new StaleWriteError("pre_create", canonical)
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code !== "ENOENT") {
            await fsp.unlink(tmpHost).catch(() => {})
            throw err
          }
        }
      } else if (aopts.expectedShaForCAS != null) {
        let current: { sha256: string | null; size: number; truncated: boolean }
        try {
          current = await streamSha256(canonical)
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === "ENOENT") {
            // file vanished between snapshot and rename — treat as stale
            await fsp.unlink(tmpHost).catch(() => {})
            throw new StaleWriteError("pre_rename", canonical)
          }
          await fsp.unlink(tmpHost).catch(() => {})
          throw err
        }
        if (current.sha256 !== aopts.expectedShaForCAS) {
          await fsp.unlink(tmpHost).catch(() => {})
          throw new StaleWriteError("pre_rename", canonical)
        }
      }
      try {
        await fsp.rename(tmpHost, destHost)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        await fsp.unlink(tmpHost).catch(() => {})
        if (code === "EXDEV") throw new CrossMountError(canonical)
        throw err
      }
      const st = await fsp.stat(destHost)
      return { sha256: sha, mtimeMs: st.mtimeMs, bytesWritten }
    } catch (err) {
      // ensure tmp is cleaned on any failure
      await fsp.unlink(tmpHost).catch(() => {})
      throw err
    }
  }

  async function deleteFile(
    canonical: string,
    dopts: { expectedShaForCAS?: string }
  ): Promise<void> {
    const destHost = await safeResolve(canonical)
    // Final pre-delete CAS: re-hash and compare.
    if (dopts.expectedShaForCAS != null) {
      let current: { sha256: string | null; size: number; truncated: boolean }
      try {
        current = await streamSha256(canonical)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === "ENOENT") {
          throw new StaleWriteError("pre_delete", canonical)
        }
        throw err
      }
      if (current.sha256 !== dopts.expectedShaForCAS) {
        throw new StaleWriteError("pre_delete", canonical)
      }
    }
    await fsp.unlink(destHost)
  }

  async function mkdir(
    canonical: string,
    mopts: { recursive?: boolean }
  ): Promise<{ created: boolean }> {
    // safeResolve enforces the active grant scope + root boundary. The reserved
    // internal namespace is already denied by the canonical gate / safeResolve.
    const destHost = await safeResolve(canonical)
    try {
      const made = await fsp.mkdir(destHost, {
        recursive: mopts.recursive ?? false,
      })
      // fsp.mkdir returns the first-created path (recursive) or undefined.
      return { created: made !== undefined }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "EEXIST") return { created: false }
      throw err
    }
  }

  async function move(
    src: string,
    dest: string,
    mopts: { expectedSourceSha?: string | null; overwrite?: boolean }
  ): Promise<{ mtimeMs: number }> {
    // Resolve BOTH endpoints under the SAME (caller-established) grant frame —
    // F-C: dest can never be authorized under a src-only prefix, because a
    // split grant frame is impossible here. safeResolve rejects .synapse-internal
    // (canonical gate) and any path escaping root / the active prefixes.
    const srcHost = await safeResolve(src)
    return await withPathLock(dest, async () => {
      const destHost = await safeResolve(dest)
      // Verify the source content if a CAS expectation was supplied.
      if (mopts.expectedSourceSha != null) {
        const srcSt = await fsp.lstat(srcHost)
        if (!srcSt.isFile()) {
          throw new Error(`move: expected_source_sha requires a regular file`)
        }
        const actual = await streamSha256Host(srcHost)
        if (actual !== mopts.expectedSourceSha) {
          throw new StaleWriteError("pre_rename", src)
        }
      }
      if (!mopts.overwrite) {
        try {
          await fsp.lstat(destHost)
          throw new StaleWriteError("pre_create", dest)
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code !== "ENOENT") throw err
        }
      }
      try {
        await fsp.rename(srcHost, destHost)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === "EXDEV") throw new CrossMountError(dest)
        throw err
      }
      const st = await fsp.lstat(destHost)
      return { mtimeMs: st.mtimeMs }
    })
  }

  async function remove(
    canonical: string,
    ropts: { recursive?: boolean }
  ): Promise<{ removed: boolean }> {
    // safeResolve confines the target; recursion stays within the grant subtree
    // because safeResolve already denied any out-of-scope path. force:false so a
    // missing target surfaces ENOENT (callers decide idempotency).
    const destHost = await safeResolve(canonical)
    await fsp.rm(destHost, {
      recursive: ropts.recursive ?? false,
      force: false,
    })
    return { removed: true }
  }

  async function renameInternalTmpInto(ropts: {
    kind: "tmp" | "restore"
    token: string
    destCanonical: string
    expectedShaForCAS?: string | null
    /**
     * When set, the staged source file's sha256 must equal this value or
     * the rename is aborted (the staged tmp is unlinked). Used by
     * `fs_history_restore` to verify the helper-staged blob matches the
     * historical sha — closes the "tampered staging" attack window where
     * something modified /.synapse-internal/restore/<token> between
     * sidecar staging and TS rename.
     */
    expectedSourceSha?: string | null
  }): Promise<{ sha256: string; mtimeMs: number; bytesWritten: number }> {
    const srcHost = resolveInternalPath(ropts.kind, ropts.token)
    let srcSt: import("node:fs").Stats
    try {
      srcSt = await fsp.lstat(srcHost)
    } catch (err) {
      throw new InternalTokenError(`internal tmp missing: ${srcHost}`)
    }
    if (!srcSt.isFile() || srcSt.isSymbolicLink()) {
      await fsp.unlink(srcHost).catch(() => {})
      throw new InternalTokenError(
        `internal tmp is not a regular file: ${srcHost}`
      )
    }
    // Compute src hash via O_NOFOLLOW fd. createReadStream would follow a
    // final-component symlink — even though we lstat'd above, the swap
    // window between lstat and open is closed only by O_NOFOLLOW.
    const srcSha = await streamSha256Host(srcHost)
    if (ropts.expectedSourceSha != null && srcSha !== ropts.expectedSourceSha) {
      await fsp.unlink(srcHost).catch(() => {})
      throw new InternalTokenError(
        `restore_blob_corrupt: staged ${srcHost} sha ${srcSha} != expected ${ropts.expectedSourceSha}`
      )
    }
    const destHost = await safeResolve(ropts.destCanonical)
    if (ropts.expectedShaForCAS != null) {
      let current: { sha256: string | null; size: number; truncated: boolean }
      try {
        current = await streamSha256(ropts.destCanonical)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== "ENOENT") {
          await fsp.unlink(srcHost).catch(() => {})
          throw err
        }
        current = { sha256: null, size: 0, truncated: false }
      }
      if (current.sha256 !== ropts.expectedShaForCAS) {
        await fsp.unlink(srcHost).catch(() => {})
        throw new StaleWriteError("pre_rename", ropts.destCanonical)
      }
    }
    try {
      await fsp.rename(srcHost, destHost)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      await fsp.unlink(srcHost).catch(() => {})
      if (code === "EXDEV") throw new CrossMountError(ropts.destCanonical)
      throw err
    }
    const st = await fsp.stat(destHost)
    return { sha256: srcSha, mtimeMs: st.mtimeMs, bytesWritten: srcSt.size }
  }

  /**
   * Stream-hash a host path using an O_NOFOLLOW fd. Used by internal-tmp
   * code paths and by streamSha256 (canonical), both of which must NOT
   * follow a final-component symlink.
   */
  async function streamSha256Host(hostPath: string): Promise<string> {
    const fh = await fsp.open(hostPath, fsConstants.O_RDONLY | O_NOFOLLOW_FLAG)
    try {
      const hash = createHash("sha256")
      const stream = fh.createReadStream({
        autoClose: false,
        highWaterMark: 64 * 1024,
      })
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        hash.update(chunk)
      }
      return hash.digest("hex")
    } finally {
      await fh.close().catch(() => {})
    }
  }

  // ─────────────────────────── legacy minimal surface ────────────────────────
  // The pre-v3 callers (vfs.test, runtime fallback paths) used a simpler API.
  // Preserve it on top of the extended helpers above.

  async function listLegacy(path: string): Promise<VfsEntry[]> {
    const canonical = canonicalVfsPath(path)
    const target = await safeResolve(canonical)
    const entries = await fsp.readdir(target, { withFileTypes: true })
    const out: VfsEntry[] = []
    for (const e of entries) {
      // Filter the reserved namespace entry at root listing.
      if (canonical === "/" && e.name === INTERNAL_DIRNAME) continue
      const childCanonical =
        canonical === "/" ? `/${e.name}` : `${canonical}/${e.name}`
      try {
        // lstat — NOT stat — so symlinks don't leak target existence /
        // mtime through their resolved target. A `/public/link →
        // /secret/file` symlink under a `/public` read grant must not
        // expose `secret/file`'s metadata; nor should broken links be
        // silently filtered (their existence is itself a side channel).
        const st = await fsp.lstat(resolve(target, e.name))
        const isSymlink = st.isSymbolicLink()
        // Surface symlinks explicitly so the caller knows the entry is a
        // link, not a regular file/dir. e.isDirectory() is only consulted
        // for non-symlinks, preserving the original short-circuit order.
        let kind: VfsNodeKind
        if (isSymlink) kind = "symlink"
        else if (e.isDirectory()) kind = "directory"
        else kind = "file"
        out.push({
          name: e.name,
          path: childCanonical,
          // mtime comes from the link itself; size is left undefined for
          // links (the file size of a symlink isn't a useful number to
          // expose).
          kind,
          size: !isSymlink && e.isFile() ? st.size : undefined,
          writable: true,
          modTime: dateToIsoInstant(st.mtime),
        })
      } catch {
        /* skip on per-entry stat failure */
      }
    }
    return out
  }

  async function statLegacy(path: string): Promise<VfsEntry | null> {
    let canonical: string
    try {
      canonical = canonicalVfsPath(path)
    } catch {
      return null
    }
    const info = await safeStat(canonical)
    if (!info) return null
    return {
      name:
        canonical === "/"
          ? ""
          : canonical.slice(canonical.lastIndexOf("/") + 1),
      path: canonical,
      kind: info.kind,
      size: info.kind === "file" ? info.size : undefined,
      writable: true,
      modTime: dateToIsoInstant(new Date(info.mtimeMs)),
    }
  }

  async function readLegacy(path: string): Promise<VfsReadResult> {
    const canonical = canonicalVfsPath(path)
    const r = await readBytes(canonical)
    return {
      data: r.bytes,
      mimeType: "application/octet-stream",
      writable: true,
    }
  }

  async function writeLegacy(
    path: string,
    data: Uint8Array
  ): Promise<VfsWriteResult> {
    const canonical = canonicalVfsPath(path)
    // Legacy callers don't have a CAS expectation; create-or-overwrite.
    await atomicWrite(canonical, data, { createParents: false })
    return { data, mimeType: "application/octet-stream" }
  }

  return {
    hostRootPath,
    hostRootWithSep,
    async start() {
      await fsp.mkdir(hostRootPath, { recursive: true })
      // Internal namespace integrity:
      //   - /.synapse-internal and its tmp/restore children MUST be real
      //     directories (not symlinks). A pre-existing
      //     `.synapse-internal -> /public/internal` would let staging
      //     files be aliased out through a list/read-visible path.
      //   - After mkdir, lstat each and reject symlinks; verify realpath
      //     equals the constructed host path (no in-root alias either).
      await fsp.mkdir(internalDirAbs, { recursive: true })
      await fsp.mkdir(internalTmpAbs, { recursive: true })
      await fsp.mkdir(internalRestoreAbs, { recursive: true })
      for (const dir of [internalDirAbs, internalTmpAbs, internalRestoreAbs]) {
        const lst = await fsp.lstat(dir)
        if (lst.isSymbolicLink()) {
          throw new Error(
            `vfs startup: ${dir} is a symlink; the reserved internal namespace must be a real directory`
          )
        }
        if (!lst.isDirectory()) {
          throw new Error(
            `vfs startup: ${dir} is not a directory (kind=${lst.mode.toString(8)})`
          )
        }
        const real = await fsp.realpath(dir)
        if (real !== dir) {
          // Either an intermediate-component symlink, or the dir itself
          // resolves elsewhere even though lstat says directory. Reject —
          // we want the internal namespace addressable by exactly one
          // host path.
          throw new Error(
            `vfs startup: ${dir} resolves to ${real}; reserved namespace must not alias another path (even inside root)`
          )
        }
      }
    },
    list: listLegacy,
    stat: statLegacy,
    read: readLegacy,
    write: writeLegacy,
    safeResolve,
    safeStat,
    streamSha256,
    readBytes,
    atomicWrite,
    deleteFile,
    mkdir,
    move,
    remove,
    renameInternalTmpInto,
    resolveInternalPath,
    withPathLock,
    withGrantPrefixes,
    realpathToCanonical,
  }
}

export function createVfsService(opts: VfsServiceOptions): VfsService {
  return new VfsService(opts)
}

// ─────────────────────────── helperWorkDir safety ────────────────────────────

/**
 * Startup invariant: helperWorkDir MUST NOT be under rootPath. Called by
 * createFilesystemBuiltin during start(). mkdir -p both directories first so
 * realpath has something to operate on, then enforce
 * `real(helperWorkDir) === real(rootPath) || startsWith(real(rootPath) + sep)`
 * as the rejection condition.
 */
export async function assertHelperWorkDirOutsideRoot(
  rootPath: string,
  helperWorkDir: string
): Promise<void> {
  await fsp.mkdir(rootPath, { recursive: true })
  await fsp.mkdir(helperWorkDir, { recursive: true })
  const realRoot = await fsp.realpath(rootPath)
  const realWork = await fsp.realpath(helperWorkDir)
  const rootSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep
  if (realWork === realRoot || realWork.startsWith(rootSep)) {
    throw new Error(
      `helperWorkDir (${realWork}) must not live under rootPath (${realRoot}); ` +
        `history.sqlite + FTS5 index would leak through list/read/search`
    )
  }
}

// Used externally by FilesystemPolicyShape consumers. (Hoisted re-export
// so the builtin can grant-check without re-importing from shared.)
export type { FilesystemPolicyShape }
export { filesystemPolicyAllows }
