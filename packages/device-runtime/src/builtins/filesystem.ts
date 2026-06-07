// Filesystem builtin (§4.5 / spec §10). v3 fs hardening: 11 new tools on top
// of the existing list_dir. Each tool runs grant_specs check via shared
// filesystemPolicyAllows + canonicalVfsPath; mutating tools follow the
// strict critical-section ordering with stream-hash CAS, snapshot RPC,
// atomic tmp+rename, and final pre-rename CAS.

import { existsSync } from "node:fs"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import type { CatalogProvider, CatalogToolInvocationResult } from "../types.js"
import type {
  DeviceCatalogExposure,
  DeviceCatalogTool,
  OperationEnvelope,
  RuntimeAuthorizationGrantSpec,
} from "@synapse/device-protocol"
import {
  assertHelperWorkDirOutsideRoot,
  canonicalVfsPath,
  CanonicalPathError,
  collapsePrefixes,
  createLocalFsBackend,
  CrossMountError,
  GrantPrefixDeniedError,
  InternalTokenError,
  pathUnderPrefix,
  StaleWriteError,
  type ExtendedLocalBackend,
} from "../vfs.js"
import { toolErrorResult } from "../mcp-host.js"
import { filesystemPolicyAllows } from "@synapse/shared"
import {
  createFsHelperClient,
  FsHelperRpcError,
  FsHelperTimeoutError,
  FsHelperUnavailableError,
  getHelperStderrTail,
  type FsHelperClient,
} from "./fs-helper-client.js"
import {
  dispatchRipgrep,
  detectRipgrep,
  type RipgrepDeps,
} from "./ripgrep-runner.js"

const PROVIDER_KEY = "builtin.filesystem"

export interface FilesystemBuiltinOptions {
  rootPath?: string
  helperPath?: string
  helperWorkDir?: string
  tikaEndpoint?: string
  enableRead?: boolean
  enableWrite?: boolean
  enableDelete?: boolean
  enableHistory?: boolean
  enableLiveSearch?: boolean
  enableIndex?: boolean
  enableRichText?: boolean
  allowUnversionedWrite?: boolean
  maxReadBytes?: number
  maxWriteBytes?: number
  maxEditFileBytes?: number
  maxHashBytes?: number
  maxSnapshotBytes?: number
  maxExtractBytes?: number
  maxHistoryListLimit?: number
  maxSearchLimit?: number
  maxOffset?: number
  maxDiffSourceBytes?: number
  maxDiffOutputBytes?: number
  maxHistoryBytes?: number
  maxVersionsPerPath?: number
  keepRecentVersionsPerPath?: number
  helperRpcTimeoutMs?: number
  indexIgnore?: string
  ripgrepPath?: string
  trashImpl?: (paths: string[]) => Promise<void>
  skipWorkDirAssertion?: boolean
  helperClientImpl?: FsHelperClient
  ripgrepDeps?: RipgrepDeps
  displayName?: string
}

const DEFAULTS = {
  maxReadBytes: 10 * 1024 * 1024,
  maxWriteBytes: 50 * 1024 * 1024,
  maxEditFileBytes: 50 * 1024 * 1024,
  maxHashBytes: 10 * 1024 * 1024,
  maxSnapshotBytes: 500 * 1024 * 1024,
  maxExtractBytes: 50 * 1024 * 1024,
  maxHistoryListLimit: 200,
  maxSearchLimit: 200,
  maxOffset: 10_000,
  maxDiffSourceBytes: 5 * 1024 * 1024,
  maxDiffOutputBytes: 1 * 1024 * 1024,
  maxHistoryBytes: 5 * 1024 * 1024 * 1024,
  maxVersionsPerPath: 100,
  keepRecentVersionsPerPath: 5,
  helperRpcTimeoutMs: 30_000,
  indexIgnore: ".git,node_modules,.synapse-internal",
}

const INLINE_RESTORE_THRESHOLD = 8 * 1024 * 1024

type CfgWithDefaults = ReturnType<typeof withDefaults>

function withDefaults(opts: FilesystemBuiltinOptions) {
  return {
    rootPath: opts.rootPath ?? "",
    helperPath: opts.helperPath ?? "",
    helperWorkDir: opts.helperWorkDir ?? "",
    tikaEndpoint: opts.tikaEndpoint ?? "",
    enableRead: opts.enableRead ?? true,
    enableWrite: opts.enableWrite ?? false,
    enableDelete: opts.enableDelete ?? false,
    enableHistory: opts.enableHistory ?? true,
    enableLiveSearch: opts.enableLiveSearch ?? true,
    enableIndex: opts.enableIndex ?? true,
    enableRichText: opts.enableRichText ?? Boolean(opts.tikaEndpoint),
    allowUnversionedWrite: opts.allowUnversionedWrite ?? false,
    maxReadBytes: opts.maxReadBytes ?? DEFAULTS.maxReadBytes,
    maxWriteBytes: opts.maxWriteBytes ?? DEFAULTS.maxWriteBytes,
    maxEditFileBytes: opts.maxEditFileBytes ?? DEFAULTS.maxEditFileBytes,
    maxHashBytes: opts.maxHashBytes ?? DEFAULTS.maxHashBytes,
    maxSnapshotBytes: opts.maxSnapshotBytes ?? DEFAULTS.maxSnapshotBytes,
    maxExtractBytes: opts.maxExtractBytes ?? DEFAULTS.maxExtractBytes,
    maxHistoryListLimit:
      opts.maxHistoryListLimit ?? DEFAULTS.maxHistoryListLimit,
    maxSearchLimit: opts.maxSearchLimit ?? DEFAULTS.maxSearchLimit,
    maxOffset: opts.maxOffset ?? DEFAULTS.maxOffset,
    maxDiffSourceBytes: opts.maxDiffSourceBytes ?? DEFAULTS.maxDiffSourceBytes,
    maxDiffOutputBytes: opts.maxDiffOutputBytes ?? DEFAULTS.maxDiffOutputBytes,
    maxHistoryBytes: opts.maxHistoryBytes ?? DEFAULTS.maxHistoryBytes,
    maxVersionsPerPath: opts.maxVersionsPerPath ?? DEFAULTS.maxVersionsPerPath,
    keepRecentVersionsPerPath:
      opts.keepRecentVersionsPerPath ?? DEFAULTS.keepRecentVersionsPerPath,
    helperRpcTimeoutMs: opts.helperRpcTimeoutMs ?? DEFAULTS.helperRpcTimeoutMs,
    indexIgnore: opts.indexIgnore ?? DEFAULTS.indexIgnore,
    ripgrepPath: opts.ripgrepPath ?? "",
    skipWorkDirAssertion: opts.skipWorkDirAssertion ?? false,
    displayName: opts.displayName ?? "Filesystem",
  }
}

// ─────────────────────────── tool registry ───────────────────────────────────

interface AvailabilityMatrix {
  liveAvailable: boolean
  indexAvailable: boolean
  historyAvailable: boolean
}

interface ToolDescriptor {
  name: string
  stable_key: string
  description: string
  input_schema: Record<string, unknown>
  visible: (cfg: CfgWithDefaults, a: AvailabilityMatrix) => boolean
}

const TOOLS: ToolDescriptor[] = [
  {
    name: "list_dir",
    stable_key: "filesystem/list",
    description:
      "List entries under a directory inside the device VFS root. The /.synapse-internal subtree is filtered out.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
    },
    visible: (c) => c.enableRead,
  },
  {
    name: "fs_stat",
    stable_key: "filesystem/stat",
    description:
      "Stat a path. include_sha256=true streams a bounded sha256 hash; files larger than maxHashBytes return sha256:null with sha256_skipped='file_too_large'.",
    input_schema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        include_sha256: { type: "boolean" },
      },
    },
    visible: (c) => c.enableRead,
  },
  {
    name: "fs_read",
    stable_key: "filesystem/read",
    description:
      "Read a file. utf-8 default with base64 fallback. line_range is 1-based inclusive. sha256 is returned only when total file size <= maxReadBytes.",
    input_schema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        encoding: { type: "string", enum: ["utf-8", "base64"] },
        start_byte: { type: "integer" },
        end_byte: { type: "integer" },
        max_bytes: { type: "integer" },
        line_range: {
          type: "array",
          items: { type: "integer" },
          minItems: 2,
          maxItems: 2,
        },
      },
    },
    visible: (c) => c.enableRead,
  },
  {
    name: "fs_write",
    stable_key: "filesystem/write",
    description:
      "Write a file atomically via tmp+rename. Stream-hash CAS verify -> snapshot -> tmp write -> final pre-rename CAS -> rename.",
    input_schema: {
      type: "object",
      required: ["path", "content", "encoding"],
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string", enum: ["utf-8", "base64"] },
        expected_mtime_ms: { type: "integer" },
        expected_sha256: { type: "string" },
        create_parents: { type: "boolean" },
      },
    },
    visible: (c, a) =>
      c.enableWrite && (a.historyAvailable || c.allowUnversionedWrite),
  },
  {
    name: "fs_edit",
    stable_key: "filesystem/edit",
    description:
      "Edit a UTF-8 text file by old_string -> new_string replacements. Byte-length projected size check; empty old_string rejected.",
    input_schema: {
      type: "object",
      required: ["path", "edits"],
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            required: ["old_string", "new_string"],
            properties: {
              old_string: { type: "string" },
              new_string: { type: "string" },
              replace_all: { type: "boolean" },
            },
          },
        },
        expected_mtime_ms: { type: "integer" },
        expected_sha256: { type: "string" },
      },
    },
    visible: (c, a) =>
      c.enableWrite &&
      c.enableRead &&
      (a.historyAvailable || c.allowUnversionedWrite),
  },
  {
    name: "fs_delete",
    stable_key: "filesystem/delete",
    description:
      "Delete a regular file. mode=trash uses OS trash with history snapshot; mode=permanent skips trash. Directory delete is v2.",
    input_schema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        mode: { type: "string", enum: ["trash", "permanent"] },
      },
    },
    visible: (c, a) =>
      c.enableDelete && (a.historyAvailable || c.allowUnversionedWrite),
  },
  {
    name: "fs_history_list",
    stable_key: "filesystem/history/list",
    description:
      "List history versions for a path, or pushed-down by grant prefixes when path is omitted.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "integer" },
        offset: { type: "integer" },
      },
    },
    visible: (c, a) => c.enableRead && a.historyAvailable,
  },
  {
    name: "fs_history_diff",
    stable_key: "filesystem/history/diff",
    description:
      "Diff two history versions of the same path. Cross-path version rejected.",
    input_schema: {
      type: "object",
      required: ["path", "version_a", "version_b"],
      properties: {
        path: { type: "string" },
        version_a: { type: "integer" },
        version_b: { type: "integer" },
      },
    },
    visible: (c, a) => c.enableRead && a.historyAvailable,
  },
  {
    name: "fs_history_restore",
    stable_key: "filesystem/history/restore",
    description:
      "Restore a path to a historical version. Strict 4-phase: get metadata -> delete-mode gate -> snapshot current -> restore execution.",
    input_schema: {
      type: "object",
      required: ["path", "version"],
      properties: {
        path: { type: "string" },
        version: { type: "integer" },
      },
    },
    visible: (c, a) => c.enableWrite && a.historyAvailable,
  },
  {
    name: "fs_search",
    stable_key: "filesystem/search",
    description:
      "Search the VFS. mode=content uses ripgrep (live) or SQLite FTS5 with bm25 (indexed). mode=path uses ripgrep --files (live) or nucleo fuzzy (indexed). indexed=true with regex/glob is rejected.",
    input_schema: {
      type: "object",
      required: ["mode", "query"],
      properties: {
        mode: { type: "string", enum: ["content", "path"] },
        query: { type: "string" },
        regex: { type: "boolean" },
        glob: { type: "string" },
        limit: { type: "integer" },
        offset: { type: "integer" },
        indexed: { type: "boolean" },
      },
    },
    visible: (c, a) => c.enableRead && (a.liveAvailable || a.indexAvailable),
  },
  {
    name: "fs_index_status",
    stable_key: "filesystem/index/status",
    description:
      "Report subtree-scoped index stats. No global storage metrics.",
    input_schema: {
      type: "object",
      properties: { subtree: { type: "string" } },
    },
    visible: (c, a) => c.enableRead && a.indexAvailable,
  },
  {
    name: "fs_index_rebuild",
    stable_key: "filesystem/index/rebuild",
    description:
      "Rebuild the index for a subtree. Only the requested subtree's docs are tombstoned + re-upserted.",
    input_schema: {
      type: "object",
      properties: { subtree: { type: "string" } },
    },
    visible: (c, a) => c.enableRead && a.indexAvailable,
  },
  {
    name: "fs_index_task_status",
    stable_key: "filesystem/index/task_status",
    description:
      "Look up a rebuild task by the id returned from fs_index_rebuild. The caller must hold a read grant covering the task's subtree.",
    input_schema: {
      type: "object",
      required: ["task_id"],
      properties: { task_id: { type: "string" } },
    },
    visible: (c, a) => c.enableRead && a.indexAvailable,
  },
]

const TOOL_BY_NAME = new Map<string, ToolDescriptor>(
  TOOLS.map((t) => [t.name, t])
)

function visibleTools(cfg: CfgWithDefaults, a: AvailabilityMatrix) {
  return TOOLS.filter((t) => t.visible(cfg, a))
}

function toCatalogTool(t: ToolDescriptor): DeviceCatalogTool {
  return {
    stable_key: t.stable_key,
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }
}

// ─────────────────────────── grant + arg helpers ─────────────────────────────

interface FsGrant {
  access: "read" | "write"
  pathPrefixes: string[]
}

function getFsGrants(envelope?: OperationEnvelope): FsGrant[] {
  const specs = envelope?.runtime_authorization?.grant_specs ?? []
  const out: FsGrant[] = []
  for (const g of specs) {
    if (g.capability !== "filesystem" || !g.filesystem) continue
    out.push({
      access: g.filesystem.access,
      pathPrefixes: g.filesystem.path_prefixes,
    })
  }
  return out
}

function checkFsGrant(
  grants: FsGrant[],
  needed: "read" | "write",
  canonicalPath: string
): boolean {
  return grants.some((g) =>
    filesystemPolicyAllows(
      { access: g.access, pathPrefixes: g.pathPrefixes },
      needed,
      canonicalPath
    )
  )
}

function canonicalGrantPrefixes(
  grants: FsGrant[],
  needed: "read" | "write"
): string[] {
  const out: string[] = []
  for (const g of grants) {
    if (needed === "write" && g.access !== "write") continue
    for (const p of g.pathPrefixes) {
      try {
        out.push(canonicalVfsPath(p))
      } catch {
        // skip invalid prefix in grant
      }
    }
  }
  return collapsePrefixes(out)
}

function asString(x: unknown): string | undefined {
  return typeof x === "string" ? x : undefined
}
function asNumber(x: unknown): number | undefined {
  return typeof x === "number" ? x : undefined
}
function asBool(x: unknown): boolean | undefined {
  return typeof x === "boolean" ? x : undefined
}

function validateOffset(value: unknown, max: number): number {
  if (value === undefined) return 0
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > max
  ) {
    throw new ToolFailure(
      "invalid_request",
      `offset_out_of_range: must be integer in [0, ${max}]`
    )
  }
  return value
}

function validateLimit(
  value: unknown,
  defaultLimit: number,
  max: number
): number {
  if (value === undefined) return defaultLimit
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > max
  ) {
    throw new ToolFailure(
      "invalid_request",
      `limit_out_of_range: must be positive integer <= ${max}`
    )
  }
  return value
}

/**
 * Validate a byte-offset argument: non-negative integer, finite, ≤ max.
 * Undefined returns undefined (caller chooses the default). Centralized
 * so fs_read can't pass NaN / -1 / 1.5 down to Buffer.alloc and surface
 * as a confusing internal "Invalid array length" error.
 */
function validateByteOffset(
  value: unknown,
  name: string,
  max: number
): number | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > max
  ) {
    throw new ToolFailure(
      "invalid_request",
      `${name}_out_of_range: must be integer in [0, ${max}]`
    )
  }
  return value
}

/**
 * Validate a positive byte-count argument (max_bytes-like): finite,
 * integer, > 0, ≤ max. Mirrors validateByteOffset's strictness so
 * fs_read fails closed with a clear message instead of constructing a
 * pathological Buffer.
 */
function validatePositiveByteCount(
  value: unknown,
  name: string,
  max: number
): number | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > max
  ) {
    throw new ToolFailure(
      "invalid_request",
      `${name}_out_of_range: must be positive integer in (0, ${max}]`
    )
  }
  return value
}

class ToolFailure extends Error {
  constructor(
    public code: "invalid_request" | "permission_denied" | "runtime_constraint",
    message: string,
    public meta?: Record<string, unknown>
  ) {
    super(message)
    this.name = "ToolFailure"
  }
}

function mapErrorToResult(err: unknown): CatalogToolInvocationResult {
  if (err instanceof ToolFailure) {
    return toolErrorResult({
      code: err.code,
      message: err.message,
      details: err.meta,
    })
  }
  if (err instanceof CanonicalPathError) {
    return toolErrorResult({
      code: "invalid_request",
      message: err.message,
    })
  }
  if (err instanceof GrantPrefixDeniedError) {
    return toolErrorResult({
      code: "permission_denied",
      message: err.message,
    })
  }
  if (err instanceof StaleWriteError) {
    return toolErrorResult({
      code: "runtime_constraint",
      message: `stale_write_detected: ${err.phase} on ${err.canonical}`,
      details: { stale_write: true, stale_write_phase: err.phase },
    })
  }
  if (err instanceof CrossMountError) {
    return toolErrorResult({
      code: "runtime_constraint",
      message: `cross_mount_not_supported: ${err.canonical}`,
    })
  }
  if (err instanceof InternalTokenError) {
    return toolErrorResult({
      code: "invalid_request",
      message: err.message,
    })
  }
  if (err instanceof FsHelperTimeoutError) {
    return toolErrorResult({
      code: "runtime_constraint",
      message: `helper_timeout: ${err.method}`,
    })
  }
  if (err instanceof FsHelperUnavailableError) {
    return toolErrorResult({
      code: "runtime_constraint",
      message: err.message,
    })
  }
  if (err instanceof FsHelperRpcError) {
    if (err.rpcCode === -32004) {
      // cross-path / not_found
      return toolErrorResult({
        code: "runtime_constraint",
        message: `helper_not_found: ${err.rpcMessage}`,
      })
    }
    if (err.rpcCode === -32005) {
      return toolErrorResult({
        code: "runtime_constraint",
        message: `history_quota_exceeded: ${err.rpcMessage}`,
      })
    }
    if (err.rpcCode === -32602) {
      return toolErrorResult({
        code: "invalid_request",
        message: err.rpcMessage,
      })
    }
    return toolErrorResult({
      code: "runtime_constraint",
      message: `helper_rpc_error: ${err.rpcMessage}`,
    })
  }
  const msg = err instanceof Error ? err.message : String(err)
  return toolErrorResult({
    code: "runtime_constraint",
    message: msg,
  })
}

// ─────────────────────────── provider factory ────────────────────────────────

export function createFilesystemBuiltin(
  opts: FilesystemBuiltinOptions = {}
): CatalogProvider {
  const cfg = withDefaults(opts)
  const liveAvailable =
    cfg.enableLiveSearch &&
    Boolean(
      cfg.ripgrepPath
        ? existsSync(cfg.ripgrepPath)
        : detectRipgrep(opts.ripgrepDeps)
    )
  const helperAvailable =
    Boolean(cfg.helperPath && existsSync(cfg.helperPath)) &&
    Boolean(cfg.helperWorkDir)
  const indexAvailable = helperAvailable && cfg.enableIndex
  const historyAvailable = helperAvailable && cfg.enableHistory

  let backend: ExtendedLocalBackend | null = null
  let helperClient: FsHelperClient | null = opts.helperClientImpl ?? null
  let started = false

  async function ensureBackend(): Promise<ExtendedLocalBackend | null> {
    if (!cfg.rootPath) return null
    if (!backend) backend = createLocalFsBackend({ rootPath: cfg.rootPath })
    if (!started) {
      if (helperAvailable && cfg.helperWorkDir && !cfg.skipWorkDirAssertion) {
        await assertHelperWorkDirOutsideRoot(cfg.rootPath, cfg.helperWorkDir)
      }
      await backend.start()
      started = true
    }
    return backend
  }

  function ensureHelper(): FsHelperClient | null {
    if (helperClient) return helperClient
    if (
      !helperAvailable ||
      !cfg.helperPath ||
      !cfg.helperWorkDir ||
      !cfg.rootPath
    ) {
      return null
    }
    helperClient = createFsHelperClient({
      helperPath: cfg.helperPath,
      rootPath: cfg.rootPath,
      workDir: cfg.helperWorkDir,
      tikaEndpoint: cfg.tikaEndpoint || undefined,
      indexIgnore: cfg.indexIgnore,
      maxSnapshotBytes: cfg.maxSnapshotBytes,
      maxExtractBytes: cfg.maxExtractBytes,
      maxDiffSourceBytes: cfg.maxDiffSourceBytes,
      maxDiffOutputBytes: cfg.maxDiffOutputBytes,
      maxSearchLimit: cfg.maxSearchLimit,
      maxHistoryListLimit: cfg.maxHistoryListLimit,
      maxOffset: cfg.maxOffset,
      maxHistoryBytes: cfg.maxHistoryBytes,
      maxVersionsPerPath: cfg.maxVersionsPerPath,
      keepRecentVersions: cfg.keepRecentVersionsPerPath,
      defaultRpcTimeoutMs: cfg.helperRpcTimeoutMs,
    })
    return helperClient
  }

  return {
    providerKey: PROVIDER_KEY,
    async describeExposures(): Promise<DeviceCatalogExposure[]> {
      const avail: AvailabilityMatrix = {
        liveAvailable,
        indexAvailable,
        historyAvailable,
      }
      const tools = visibleTools(cfg, avail)
      return [
        {
          stable_key: "builtin/filesystem",
          display_name: cfg.displayName,
          transport: "builtin",
          builtin_kind: "filesystem",
          metadata: {
            rootPath: cfg.rootPath || null,
            schemaVersion: 2,
            features: {
              read: cfg.enableRead,
              write: cfg.enableWrite,
              delete: cfg.enableDelete,
              history: historyAvailable,
              liveSearch: liveAvailable,
              indexedSearch: indexAvailable,
              richText: cfg.enableRichText && Boolean(cfg.tikaEndpoint),
              unversionedWrite: cfg.allowUnversionedWrite,
            },
          },
          tools: tools.map(toCatalogTool),
        },
      ]
    },
    async invokeTool(input): Promise<CatalogToolInvocationResult> {
      const tool = TOOL_BY_NAME.get(input.toolName)
      if (!tool) {
        return toolErrorResult({
          code: "invalid_request",
          message: `filesystem builtin does not handle ${input.toolName}`,
        })
      }
      const avail: AvailabilityMatrix = {
        liveAvailable,
        indexAvailable,
        historyAvailable,
      }
      if (!tool.visible(cfg, avail)) {
        return toolErrorResult({
          code: "permission_denied",
          message: `filesystem.${tool.name} is disabled by runtime config`,
        })
      }
      const be = await ensureBackend()
      if (!be) {
        return toolErrorResult({
          code: "runtime_constraint",
          message: "filesystem builtin has no rootPath configured",
        })
      }
      try {
        const result = await dispatch(tool, input, {
          cfg,
          backend: be,
          helper: ensureHelper(),
          avail,
          trashImpl: opts.trashImpl,
          ripgrepDeps: opts.ripgrepDeps,
        })
        return result
      } catch (err) {
        return mapErrorToResult(err)
      }
    },
    async dispose() {
      if (helperClient && !opts.helperClientImpl) {
        await helperClient.stop().catch(() => {})
        helperClient = null
      }
    },
  }
}

// ─────────────────────────── per-tool dispatch ───────────────────────────────

interface DispatchCtx {
  cfg: CfgWithDefaults
  backend: ExtendedLocalBackend
  helper: FsHelperClient | null
  avail: AvailabilityMatrix
  trashImpl?: (paths: string[]) => Promise<void>
  ripgrepDeps?: RipgrepDeps
}

async function dispatch(
  tool: ToolDescriptor,
  input: {
    toolName: string
    args: Record<string, unknown>
    envelope?: OperationEnvelope
  },
  ctx: DispatchCtx
): Promise<CatalogToolInvocationResult> {
  switch (tool.name) {
    case "list_dir":
      return handleListDir(input.args, input.envelope, ctx)
    case "fs_stat":
      return handleFsStat(input.args, input.envelope, ctx)
    case "fs_read":
      return handleFsRead(input.args, input.envelope, ctx)
    case "fs_write":
      return handleFsWrite(input.args, input.envelope, ctx)
    case "fs_edit":
      return handleFsEdit(input.args, input.envelope, ctx)
    case "fs_delete":
      return handleFsDelete(input.args, input.envelope, ctx)
    case "fs_history_list":
      return handleHistoryList(input.args, input.envelope, ctx)
    case "fs_history_diff":
      return handleHistoryDiff(input.args, input.envelope, ctx)
    case "fs_history_restore":
      return handleHistoryRestore(input.args, input.envelope, ctx)
    case "fs_search":
      return handleSearch(input.args, input.envelope, ctx)
    case "fs_index_status":
      return handleIndexStatus(input.args, input.envelope, ctx)
    case "fs_index_rebuild":
      return handleIndexRebuild(input.args, input.envelope, ctx)
    case "fs_index_task_status":
      return handleIndexTaskStatus(input.args, input.envelope, ctx)
  }
  throw new ToolFailure("invalid_request", `unrouted tool: ${tool.name}`)
}

// ─────────────────────────── read tools ──────────────────────────────────────

async function handleListDir(
  args: Record<string, unknown>,
  envelope: OperationEnvelope | undefined,
  ctx: DispatchCtx
): Promise<CatalogToolInvocationResult> {
  const rawPath = asString(args["path"]) ?? "/"
  const canonical = canonicalVfsPath(rawPath)
  const grants = getFsGrants(envelope)
  if (envelope && !checkFsGrant(grants, "read", canonical)) {
    throw new ToolFailure(
      "permission_denied",
      `list_dir(${canonical}) not covered by any filesystem grant`
    )
  }
  const readPrefixes = canonicalGrantPrefixes(grants, "read")
  const entries = await ctx.backend.withGrantPrefixes(readPrefixes, () =>
    ctx.backend.list(canonical)
  )
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ path: canonical, entries }, null, 2),
      },
    ],
    _meta: { entry_count: entries.length },
  }
}

async function handleFsStat(
  args: Record<string, unknown>,
  envelope: OperationEnvelope | undefined,
  ctx: DispatchCtx
): Promise<CatalogToolInvocationResult> {
  const pathArg = asString(args["path"])
  if (!pathArg) throw new ToolFailure("invalid_request", "path is required")
  const canonical = canonicalVfsPath(pathArg)
  const grants = getFsGrants(envelope)
  if (envelope && !checkFsGrant(grants, "read", canonical)) {
    throw new ToolFailure(
      "permission_denied",
      `fs_stat(${canonical}) not covered by any filesystem grant`
    )
  }
  const readPrefixes = canonicalGrantPrefixes(grants, "read")
  return await ctx.backend.withGrantPrefixes(readPrefixes, async () => {
    const info = await ctx.backend.safeStat(canonical)
    if (!info) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ path: canonical, exists: false }),
          },
        ],
      }
    }
    const includeSha = asBool(args["include_sha256"]) ?? false
    let sha256: string | null = null
    let shaSkipped: string | null = null
    if (includeSha && info.kind === "file") {
      if (info.size > ctx.cfg.maxHashBytes) {
        shaSkipped = "file_too_large"
      } else {
        const h = await ctx.backend.streamSha256(canonical)
        sha256 = h.sha256
      }
    }
    const body: Record<string, unknown> = {
      path: canonical,
      exists: true,
      kind: info.kind,
      size: info.size,
      mtime_ms: info.mtimeMs,
      mode_octal: (info.mode & 0o7777).toString(8),
      is_symlink: info.isSymlink,
    }
    if (includeSha) {
      body["sha256"] = sha256
      if (shaSkipped) body["sha256_skipped"] = shaSkipped
    }
    return {
      content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
      _meta: { kind: info.kind, size: info.size },
    }
  })
}

async function handleFsRead(
  args: Record<string, unknown>,
  envelope: OperationEnvelope | undefined,
  ctx: DispatchCtx
): Promise<CatalogToolInvocationResult> {
  const pathArg = asString(args["path"])
  if (!pathArg) throw new ToolFailure("invalid_request", "path is required")
  const canonical = canonicalVfsPath(pathArg)
  const grants = getFsGrants(envelope)
  if (envelope && !checkFsGrant(grants, "read", canonical)) {
    throw new ToolFailure(
      "permission_denied",
      `fs_read(${canonical}) not covered by any filesystem grant`
    )
  }
  const encoding = asString(args["encoding"]) === "base64" ? "base64" : "utf-8"
  // Strict numeric validation BEFORE we hand off to readBytes — bare
  // asNumber would let NaN / -1 / 1.5 slip through and surface as
  // "Invalid array length" / "out of range" deeper in Buffer.alloc.
  //
  // start_byte / end_byte are file-offset positions, NOT
  // bytes-to-return. Their upper bound is the file size (enforced
  // downstream in vfs.readBytes — `start > totalSize` rejects), NOT
  // ctx.cfg.maxReadBytes; otherwise a 100MB file couldn't be read past
  // the 5MB safety cap. Use Number.MAX_SAFE_INTEGER so we still reject
  // NaN / negative / non-integer but don't artificially refuse honest
  // offsets into large files.
  const startByte = validateByteOffset(
    args["start_byte"],
    "start_byte",
    Number.MAX_SAFE_INTEGER
  )
  const endByte = validateByteOffset(
    args["end_byte"],
    "end_byte",
    Number.MAX_SAFE_INTEGER
  )
  const lineRange = args["line_range"] as unknown
  // max_bytes IS bounded by maxReadBytes — it's the "how much to return"
  // cap, not the position. Read sites further cap to ctx.cfg.maxReadBytes
  // anyway, but rejecting up front gives the caller a clearer error.
  const maxBytesArg = validatePositiveByteCount(
    args["max_bytes"],
    "max_bytes",
    ctx.cfg.maxReadBytes
  )
  if (
    lineRange !== undefined &&
    (startByte !== undefined || endByte !== undefined)
  ) {
    throw new ToolFailure(
      "invalid_request",
      "line_range is mutually exclusive with start_byte/end_byte"
    )
  }
  const maxBytes = Math.min(
    maxBytesArg ?? ctx.cfg.maxReadBytes,
    ctx.cfg.maxReadBytes
  )
  const readPrefixes = canonicalGrantPrefixes(grants, "read")
  return await ctx.backend.withGrantPrefixes(readPrefixes, async () => {
    const r = await ctx.backend.readBytes(canonical, {
      startByte,
      endByte,
      maxBytes:
        startByte !== undefined || endByte !== undefined ? maxBytes : maxBytes,
    })
    let bytes = r.bytes
    let truncated = r.truncated
    if (Array.isArray(lineRange) && lineRange.length === 2) {
      const [start1, end1] = lineRange as [number, number]
      if (
        !Number.isInteger(start1) ||
        !Number.isInteger(end1) ||
        start1 < 1 ||
        end1 < start1
      ) {
        throw new ToolFailure(
          "invalid_request",
          "line_range must be 1-based inclusive [start, end] with end >= start >= 1"
        )
      }
      // For line_range, slice by line on the read bytes (best-effort UTF-8).
      const text = bytes.length === 0 ? "" : Buffer.from(bytes).toString("utf8")
      const lines = text.split(/\r?\n/)
      const sliced = lines.slice(start1 - 1, end1).join("\n")
      bytes = Buffer.from(sliced, "utf8")
      truncated = end1 > lines.length ? false : truncated
    }
    // sha256 only when full file fits in maxReadBytes
    let sha256: string | null = null
    let shaSkipped: string | null = null
    if (r.totalSize > ctx.cfg.maxReadBytes) {
      shaSkipped = "file_too_large"
    } else {
      const h = await ctx.backend.streamSha256(canonical)
      sha256 = h.sha256
    }
    // Encoding: utf-8 default, fall back to base64 if decode fails roundtrip.
    let content: string
    let chosenEncoding: "utf-8" | "base64" = encoding
    let encodingFallback = false
    if (encoding === "utf-8") {
      const decoded = Buffer.from(bytes).toString("utf8")
      const reenc = Buffer.from(decoded, "utf8")
      if (Buffer.compare(reenc, Buffer.from(bytes)) === 0) {
        content = decoded
      } else {
        content = Buffer.from(bytes).toString("base64")
        chosenEncoding = "base64"
        encodingFallback = true
      }
    } else {
      content = Buffer.from(bytes).toString("base64")
    }
    const body: Record<string, unknown> = {
      path: canonical,
      content,
      encoding: chosenEncoding,
      bytes_read: bytes.length,
      total_bytes: r.totalSize,
      truncated,
      sha256,
      mtime_ms: r.mtimeMs,
      mime_guess: "application/octet-stream",
    }
    if (shaSkipped) body["sha256_skipped"] = shaSkipped
    const meta: Record<string, unknown> = {
      bytes_read: bytes.length,
      truncated,
    }
    if (encodingFallback) meta["encoding_fallback"] = true
    return {
      content: [{ type: "text", text: JSON.stringify(body) }],
      _meta: meta,
    }
  })
}

// ─────────────────────────── write tools ─────────────────────────────────────

function decodeWriteContent(
  content: string,
  encoding: "utf-8" | "base64",
  maxWriteBytes: number
): Uint8Array {
  if (encoding === "utf-8") {
    const upper = Buffer.byteLength(content, "utf8")
    if (upper > maxWriteBytes) {
      throw new ToolFailure(
        "invalid_request",
        `write_too_large: utf-8 content is ${upper} bytes (cap ${maxWriteBytes})`
      )
    }
    return new Uint8Array(Buffer.from(content, "utf8"))
  }
  // base64: exact-decoded-length pre-check
  const cleaned = content.replace(/[\s]+/g, "")
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    throw new ToolFailure(
      "invalid_request",
      "invalid_base64: alphabet/padding check failed"
    )
  }
  if (cleaned.length % 4 !== 0) {
    throw new ToolFailure(
      "invalid_request",
      "invalid_base64: clean length is not a multiple of 4"
    )
  }
  let padding = 0
  if (cleaned.endsWith("==")) padding = 2
  else if (cleaned.endsWith("=")) padding = 1
  const decodedLen = (cleaned.length / 4) * 3 - padding
  if (decodedLen > maxWriteBytes) {
    throw new ToolFailure(
      "invalid_request",
      `write_too_large: base64 decodes to ${decodedLen} bytes (cap ${maxWriteBytes})`
    )
  }
  const buf = Buffer.from(cleaned, "base64")
  if (buf.length > maxWriteBytes) {
    throw new ToolFailure(
      "invalid_request",
      `write_too_large: post-decode ${buf.length} bytes (cap ${maxWriteBytes})`
    )
  }
  return new Uint8Array(buf)
}

async function snapshotPriorIfPossible(
  canonical: string,
  op: "pre_write" | "pre_edit" | "pre_restore",
  ctx: DispatchCtx
): Promise<{
  priorExists: boolean
  sha: string | null
  size: number
  mtimeMs: number | null
}> {
  const info = await ctx.backend.safeStat(canonical)
  let priorExists = false
  let sha: string | null = null
  let size = 0
  let mtimeMs: number | null = null
  if (info && info.kind === "file") {
    priorExists = true
    size = info.size
    mtimeMs = info.mtimeMs
    if (size > ctx.cfg.maxSnapshotBytes) {
      throw new ToolFailure(
        "runtime_constraint",
        `snapshot_too_large: prior file ${size} bytes (cap ${ctx.cfg.maxSnapshotBytes})`
      )
    }
    const h = await ctx.backend.streamSha256(canonical)
    sha = h.sha256
  }
  if (ctx.helper && ctx.helper.isAvailable()) {
    await ctx.helper.historySnapshot({
      path: canonical,
      prior_exists: priorExists,
      expected_sha256: sha,
      prior_size: size,
      prior_mtime_ms: mtimeMs,
      op,
    })
  } else if (!ctx.cfg.allowUnversionedWrite) {
    throw new ToolFailure(
      "runtime_constraint",
      "history_unavailable: cannot mutate without history when allowUnversionedWrite is false"
    )
  }
  return { priorExists, sha, size, mtimeMs }
}

async function handleFsWrite(
  args: Record<string, unknown>,
  envelope: OperationEnvelope | undefined,
  ctx: DispatchCtx
): Promise<CatalogToolInvocationResult> {
  const pathArg = asString(args["path"])
  if (!pathArg) throw new ToolFailure("invalid_request", "path is required")
  const canonical = canonicalVfsPath(pathArg)
  const content = asString(args["content"])
  if (content === undefined) {
    throw new ToolFailure("invalid_request", "content is required")
  }
  const encoding = asString(args["encoding"]) === "base64" ? "base64" : "utf-8"
  const grants = getFsGrants(envelope)
  if (envelope && !checkFsGrant(grants, "write", canonical)) {
    throw new ToolFailure(
      "permission_denied",
      `fs_write(${canonical}) not covered by any filesystem write grant`
    )
  }
  const expectedMtime = asNumber(args["expected_mtime_ms"])
  const expectedSha = asString(args["expected_sha256"])
  const createParents = asBool(args["create_parents"]) ?? false
  // Decode + size cap BEFORE any IO.
  const bytes = decodeWriteContent(content, encoding, ctx.cfg.maxWriteBytes)
  const writePrefixes = canonicalGrantPrefixes(grants, "write")
  return await ctx.backend.withGrantPrefixes(writePrefixes, () =>
    ctx.backend.withPathLock(canonical, async () => {
      // CAS verify against current state.
      const info = await ctx.backend.safeStat(canonical)
      const priorExists = !!info && info.kind === "file"
      let priorSha: string | null = null
      if (priorExists) {
        const h = await ctx.backend.streamSha256(canonical)
        priorSha = h.sha256
      }
      if (expectedSha !== undefined && expectedSha !== priorSha) {
        throw new ToolFailure(
          "runtime_constraint",
          `stale_write_detected: expected_sha256 mismatch`,
          { stale_write: true }
        )
      }
      if (
        expectedMtime !== undefined &&
        (info?.mtimeMs ?? null) !== expectedMtime
      ) {
        throw new ToolFailure(
          "runtime_constraint",
          `stale_write_detected: expected_mtime_ms mismatch`,
          { stale_write: true }
        )
      }
      // Snapshot prior state if helper available.
      if (priorExists && priorSha && priorSha.length > 0) {
        if (ctx.helper && ctx.helper.isAvailable()) {
          if ((info?.size ?? 0) > ctx.cfg.maxSnapshotBytes) {
            throw new ToolFailure(
              "runtime_constraint",
              `snapshot_too_large: prior file ${info?.size ?? 0} bytes`
            )
          }
          await ctx.helper.historySnapshot({
            path: canonical,
            prior_exists: true,
            expected_sha256: priorSha,
            prior_size: info!.size,
            prior_mtime_ms: info!.mtimeMs,
            op: "pre_write",
          })
        } else if (!ctx.cfg.allowUnversionedWrite) {
          throw new ToolFailure(
            "runtime_constraint",
            "history_unavailable: cannot mutate without history"
          )
        }
      } else if (!priorExists) {
        // create new — still call snapshot with prior_exists=false so restore
        // can roll back to "deleted" state. Enforce the same
        // history-required-by-default rule as the overwrite branch above.
        if (ctx.helper && ctx.helper.isAvailable()) {
          await ctx.helper.historySnapshot({
            path: canonical,
            prior_exists: false,
            expected_sha256: null,
            prior_size: 0,
            prior_mtime_ms: null,
            op: "pre_write",
          })
        } else if (!ctx.cfg.allowUnversionedWrite) {
          throw new ToolFailure(
            "runtime_constraint",
            "history_unavailable: cannot create new file without history"
          )
        }
      }
      const result = await ctx.backend.atomicWrite(canonical, bytes, {
        createOnly: !priorExists,
        createParents,
        expectedShaForCAS: priorExists ? priorSha : null,
      })
      if (ctx.helper && ctx.helper.isAvailable() && ctx.avail.indexAvailable) {
        await ctx.helper.indexUpsert({ path: canonical }).catch(() => {})
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              path: canonical,
              bytes_written: result.bytesWritten,
              sha256: result.sha256,
              mtime_ms: result.mtimeMs,
            }),
          },
        ],
        _meta: { bytes_written: result.bytesWritten },
      }
    })
  )
}

async function handleFsEdit(
  args: Record<string, unknown>,
  envelope: OperationEnvelope | undefined,
  ctx: DispatchCtx
): Promise<CatalogToolInvocationResult> {
  const pathArg = asString(args["path"])
  if (!pathArg) throw new ToolFailure("invalid_request", "path is required")
  const canonical = canonicalVfsPath(pathArg)
  const editsRaw = args["edits"]
  if (!Array.isArray(editsRaw) || editsRaw.length === 0) {
    throw new ToolFailure("invalid_request", "edits must be a non-empty array")
  }
  const edits = editsRaw as Array<{
    old_string?: unknown
    new_string?: unknown
    replace_all?: unknown
  }>
  for (const e of edits) {
    if (typeof e.old_string !== "string" || typeof e.new_string !== "string") {
      throw new ToolFailure(
        "invalid_request",
        "each edit needs string old_string and new_string"
      )
    }
    if (e.old_string === "") {
      throw new ToolFailure(
        "invalid_request",
        "edit_old_string_empty: old_string must not be empty"
      )
    }
  }
  const grants = getFsGrants(envelope)
  if (envelope && !checkFsGrant(grants, "write", canonical)) {
    throw new ToolFailure(
      "permission_denied",
      `fs_edit(${canonical}) not covered by any filesystem write grant`
    )
  }
  const expectedMtime = asNumber(args["expected_mtime_ms"])
  const expectedSha = asString(args["expected_sha256"])
  const writePrefixes = canonicalGrantPrefixes(grants, "write")
  return await ctx.backend.withGrantPrefixes(writePrefixes, () =>
    ctx.backend.withPathLock(canonical, async () => {
      const info = await ctx.backend.safeStat(canonical)
      if (!info || info.kind !== "file") {
        throw new ToolFailure(
          "runtime_constraint",
          `fs_edit: ${canonical} is not a regular file`
        )
      }
      if (info.size > ctx.cfg.maxEditFileBytes) {
        throw new ToolFailure(
          "invalid_request",
          `edit_source_too_large: ${info.size} bytes (cap ${ctx.cfg.maxEditFileBytes})`
        )
      }
      const r = await ctx.backend.readBytes(canonical, {
        maxBytes: ctx.cfg.maxEditFileBytes,
      })
      const original = Buffer.from(r.bytes)
      // UTF-8 byte-for-byte roundtrip + NUL reject
      const decoded = original.toString("utf8")
      const reenc = Buffer.from(decoded, "utf8")
      if (Buffer.compare(reenc, original) !== 0 || decoded.includes("\0")) {
        throw new ToolFailure(
          "invalid_request",
          "edit_not_utf8: file is not valid UTF-8 text (or contains NUL)"
        )
      }
      const h = await ctx.backend.streamSha256(canonical)
      const priorSha = h.sha256
      if (expectedSha !== undefined && expectedSha !== priorSha) {
        throw new ToolFailure(
          "runtime_constraint",
          "stale_write_detected: expected_sha256 mismatch",
          { stale_write: true }
        )
      }
      if (expectedMtime !== undefined && info.mtimeMs !== expectedMtime) {
        throw new ToolFailure(
          "runtime_constraint",
          "stale_write_detected: expected_mtime_ms mismatch",
          { stale_write: true }
        )
      }
      let buffer = decoded
      let bufferBytes = Buffer.byteLength(buffer, "utf8")
      let editsApplied = 0
      for (const e of edits) {
        const oldS = e.old_string as string
        const newS = e.new_string as string
        const replaceAll = e.replace_all === true
        const oldBytes = Buffer.byteLength(oldS, "utf8")
        const newBytes = Buffer.byteLength(newS, "utf8")
        // Count occurrences (string-level) for both single + replace_all.
        let count = 0
        let idx = 0
        while (true) {
          const found = buffer.indexOf(oldS, idx)
          if (found < 0) break
          count += 1
          idx = found + oldS.length
        }
        if (count === 0) {
          throw new ToolFailure(
            "runtime_constraint",
            `fs_edit: old_string not found in buffer for edit ${editsApplied + 1}`
          )
        }
        if (!replaceAll && count > 1) {
          throw new ToolFailure(
            "runtime_constraint",
            `fs_edit: old_string appears ${count} times; pass replace_all:true to allow`
          )
        }
        const occurrences = replaceAll ? count : 1
        const projected = bufferBytes + occurrences * (newBytes - oldBytes)
        if (projected > ctx.cfg.maxEditFileBytes) {
          throw new ToolFailure(
            "invalid_request",
            `edit_result_too_large: projected ${projected} bytes (cap ${ctx.cfg.maxEditFileBytes})`
          )
        }
        buffer = replaceAll
          ? buffer.split(oldS).join(newS)
          : buffer.replace(oldS, newS)
        bufferBytes = Buffer.byteLength(buffer, "utf8")
        editsApplied += 1
      }
      if (bufferBytes > ctx.cfg.maxEditFileBytes) {
        throw new ToolFailure(
          "invalid_request",
          `edit_result_too_large: post-write ${bufferBytes} bytes`
        )
      }
      // Snapshot prior + atomicWrite.
      if (info.size > ctx.cfg.maxSnapshotBytes) {
        throw new ToolFailure(
          "runtime_constraint",
          `snapshot_too_large: ${info.size} bytes`
        )
      }
      if (ctx.helper && ctx.helper.isAvailable()) {
        await ctx.helper.historySnapshot({
          path: canonical,
          prior_exists: true,
          expected_sha256: priorSha,
          prior_size: info.size,
          prior_mtime_ms: info.mtimeMs,
          op: "pre_edit",
        })
      } else if (!ctx.cfg.allowUnversionedWrite) {
        throw new ToolFailure(
          "runtime_constraint",
          "history_unavailable: cannot mutate without history"
        )
      }
      const finalBytes = new Uint8Array(Buffer.from(buffer, "utf8"))
      const result = await ctx.backend.atomicWrite(canonical, finalBytes, {
        createOnly: false,
        createParents: false,
        expectedShaForCAS: priorSha,
      })
      if (ctx.helper && ctx.helper.isAvailable() && ctx.avail.indexAvailable) {
        await ctx.helper.indexUpsert({ path: canonical }).catch(() => {})
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              path: canonical,
              bytes_written: result.bytesWritten,
              sha256: result.sha256,
              mtime_ms: result.mtimeMs,
              edits_applied: editsApplied,
            }),
          },
        ],
        // _meta carries the structured result the presentation layer reads
        // (ResultRef meta.*). Mirror the summary-relevant fields from the body
        // so a friendly result summary ("已写入 N 字节, M 处生效") can render.
        _meta: {
          edits_applied: editsApplied,
          bytes_written: result.bytesWritten,
          sha256: result.sha256,
        },
      }
    })
  )
}

async function defaultTrash(paths: string[]): Promise<void> {
  // Lazy-load the trash module so it isn't a hard dependency at startup —
  // if it's not installed and the operator never calls fs_delete mode=trash,
  // we never reach it. trash uses dynamic platform tools (osascript on macOS,
  // gio/kioclient5 on Linux, recycle-bin DLL on Windows).
  const mod = await import("trash" as string).catch(() => null)
  if (!mod) {
    throw new Error("trash module not installed")
  }
  const fn =
    (mod as unknown as { default?: (p: string[]) => Promise<void> }).default ??
    (mod as unknown as (p: string[]) => Promise<void>)
  await fn(paths)
}

async function handleFsDelete(
  args: Record<string, unknown>,
  envelope: OperationEnvelope | undefined,
  ctx: DispatchCtx
): Promise<CatalogToolInvocationResult> {
  const pathArg = asString(args["path"])
  if (!pathArg) throw new ToolFailure("invalid_request", "path is required")
  const canonical = canonicalVfsPath(pathArg)
  const mode = asString(args["mode"]) === "permanent" ? "permanent" : "trash"
  const grants = getFsGrants(envelope)
  if (envelope && !checkFsGrant(grants, "write", canonical)) {
    throw new ToolFailure(
      "permission_denied",
      `fs_delete(${canonical}) not covered by any filesystem write grant`
    )
  }
  if (mode === "permanent" && !ctx.avail.historyAvailable) {
    throw new ToolFailure(
      "invalid_request",
      "permanent_delete_requires_history: enable --fs-enable-history or use mode=trash"
    )
  }
  const writePrefixes = canonicalGrantPrefixes(grants, "write")
  return await ctx.backend.withGrantPrefixes(writePrefixes, () =>
    ctx.backend.withPathLock(canonical, async () => {
      const info = await ctx.backend.safeStat(canonical)
      if (!info) {
        throw new ToolFailure(
          "runtime_constraint",
          `fs_delete: ${canonical} does not exist`
        )
      }
      if (info.kind !== "file") {
        throw new ToolFailure(
          "runtime_constraint",
          `not_a_file: ${canonical} kind=${info.kind}`
        )
      }
      if (info.size > ctx.cfg.maxSnapshotBytes) {
        throw new ToolFailure(
          "runtime_constraint",
          `snapshot_too_large: ${info.size} bytes`
        )
      }
      const h = await ctx.backend.streamSha256(canonical)
      const priorSha = h.sha256
      // Snapshot before delete.
      if (ctx.helper && ctx.helper.isAvailable()) {
        await ctx.helper.historySnapshotDelete({
          path: canonical,
          prior_exists: true,
          expected_sha256: priorSha,
          prior_size: info.size,
          prior_mtime_ms: info.mtimeMs,
        })
      } else if (!ctx.cfg.allowUnversionedWrite) {
        throw new ToolFailure(
          "runtime_constraint",
          "history_unavailable: cannot delete without history"
        )
      }
      // Try the requested mode + fallback logic.
      const hostPath = await ctx.backend.safeResolve(canonical)
      let trashMode: "trash" | "history_only" | "os_only" = "trash"
      if (mode === "permanent") {
        await ctx.backend.deleteFile(canonical, {
          expectedShaForCAS: priorSha ?? undefined,
        })
        trashMode = "history_only"
      } else {
        // Final pre-trash CAS: re-hash the file right before invoking the
        // OS trash and reject if external content changed since snapshot.
        // Without this, trash silently moves the modified file and we
        // claim history covers it when in fact the snapshot is stale.
        if (priorSha != null) {
          const recheck = await ctx.backend.streamSha256(canonical)
          if (recheck.sha256 !== priorSha) {
            throw new ToolFailure(
              "runtime_constraint",
              `stale_write_detected: pre_delete on ${canonical}`,
              { stale_write: true, stale_write_phase: "pre_delete" }
            )
          }
        }
        const trashFn = ctx.trashImpl ?? defaultTrash
        try {
          await trashFn([hostPath])
          // OS trash succeeded.
          trashMode = ctx.avail.historyAvailable ? "trash" : "os_only"
        } catch (err) {
          if (!ctx.avail.historyAvailable) {
            throw new ToolFailure(
              "runtime_constraint",
              `trash_unavailable: OS trash failed and history disabled: ${(err as Error).message}`
            )
          }
          // Fall back to fs.rm — snapshot already exists. deleteFile also
          // runs the CAS, but we already verified above; double-checking
          // is cheap and protects against any modification during the
          // failed trash attempt.
          await ctx.backend.deleteFile(canonical, {
            expectedShaForCAS: priorSha ?? undefined,
          })
          trashMode = "history_only"
        }
      }
      if (ctx.helper && ctx.helper.isAvailable() && ctx.avail.indexAvailable) {
        await ctx.helper.indexRemove({ path: canonical }).catch(() => {})
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ path: canonical, deleted: true, mode }),
          },
        ],
        _meta: { trash_mode: trashMode },
      }
    })
  )
}

// ─────────────────────────── history tools ───────────────────────────────────

async function handleHistoryList(
  args: Record<string, unknown>,
  envelope: OperationEnvelope | undefined,
  ctx: DispatchCtx
): Promise<CatalogToolInvocationResult> {
  if (!ctx.helper) {
    throw new ToolFailure(
      "runtime_constraint",
      "history_unavailable: helper not configured"
    )
  }
  const grants = getFsGrants(envelope)
  const limit = validateLimit(args["limit"], 50, ctx.cfg.maxHistoryListLimit)
  const offset = validateOffset(args["offset"], ctx.cfg.maxOffset)
  const pathArg = asString(args["path"])
  let path: string | undefined
  let allowedPrefixes: string[] | undefined
  if (pathArg) {
    path = canonicalVfsPath(pathArg)
    if (envelope && !checkFsGrant(grants, "read", path)) {
      throw new ToolFailure(
        "permission_denied",
        `fs_history_list(${path}) not covered by any filesystem grant`
      )
    }
  } else {
    // Pushdown: only return entries under any of the caller's read prefixes.
    allowedPrefixes = canonicalGrantPrefixes(grants, "read")
    if (envelope && allowedPrefixes.length === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ entries: [] }) }],
      }
    }
  }
  const result = await ctx.helper.historyList({
    path,
    allowed_path_prefixes: allowedPrefixes,
    limit,
    offset,
  })
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ entries: result.entries }, null, 2),
      },
    ],
    _meta: { entry_count: result.entries.length },
  }
}

async function handleHistoryDiff(
  args: Record<string, unknown>,
  envelope: OperationEnvelope | undefined,
  ctx: DispatchCtx
): Promise<CatalogToolInvocationResult> {
  if (!ctx.helper) {
    throw new ToolFailure("runtime_constraint", "history_unavailable")
  }
  const pathArg = asString(args["path"])
  if (!pathArg) throw new ToolFailure("invalid_request", "path is required")
  const canonical = canonicalVfsPath(pathArg)
  const va = asNumber(args["version_a"])
  const vb = asNumber(args["version_b"])
  if (va === undefined || vb === undefined) {
    throw new ToolFailure("invalid_request", "version_a and version_b required")
  }
  const grants = getFsGrants(envelope)
  if (envelope && !checkFsGrant(grants, "read", canonical)) {
    throw new ToolFailure(
      "permission_denied",
      `fs_history_diff(${canonical}) not covered by any filesystem grant`
    )
  }
  const result = await ctx.helper.historyDiff({
    path: canonical,
    version_a: va,
    version_b: vb,
  })
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
  }
}

async function handleHistoryRestore(
  args: Record<string, unknown>,
  envelope: OperationEnvelope | undefined,
  ctx: DispatchCtx
): Promise<CatalogToolInvocationResult> {
  if (!ctx.helper) {
    throw new ToolFailure("runtime_constraint", "history_unavailable")
  }
  const pathArg = asString(args["path"])
  if (!pathArg) throw new ToolFailure("invalid_request", "path is required")
  const canonical = canonicalVfsPath(pathArg)
  const version = asNumber(args["version"])
  if (version === undefined) {
    throw new ToolFailure("invalid_request", "version is required")
  }
  const grants = getFsGrants(envelope)
  if (envelope && !checkFsGrant(grants, "write", canonical)) {
    throw new ToolFailure(
      "permission_denied",
      `fs_history_restore(${canonical}) not covered by any filesystem write grant`
    )
  }
  // Phase 1: metadata preflight.
  const meta = await ctx.helper.historyGet({ path: canonical, version })
  // Phase 2: delete-mode gate — if restore would delete, require enableDelete.
  if (!meta.prior_exists && !ctx.cfg.enableDelete) {
    throw new ToolFailure(
      "permission_denied",
      `restore_delete_requires_enable_delete: version ${version} is prior_exists=false`
    )
  }
  const writePrefixes = canonicalGrantPrefixes(grants, "write")
  return await ctx.backend.withGrantPrefixes(writePrefixes, () =>
    ctx.backend.withPathLock(canonical, async () => {
      // Phase 3: snapshot current target (so restore is itself reversible).
      const cur = await ctx.backend.safeStat(canonical)
      const curPriorExists = !!cur && cur.kind === "file"
      let curSha: string | null = null
      if (curPriorExists) {
        const h = await ctx.backend.streamSha256(canonical)
        curSha = h.sha256
        if ((cur?.size ?? 0) > ctx.cfg.maxSnapshotBytes) {
          throw new ToolFailure(
            "runtime_constraint",
            `snapshot_too_large: current ${cur?.size ?? 0} bytes`
          )
        }
      }
      await ctx.helper!.historySnapshot({
        path: canonical,
        prior_exists: curPriorExists,
        expected_sha256: curSha,
        prior_size: cur?.size ?? 0,
        prior_mtime_ms: cur?.mtimeMs ?? null,
        op: "pre_restore",
      })
      // Phase 4: restore execution.
      // Use the metadata fetched in phase 1 (meta.sha256) as the
      // authoritative historical hash. The sidecar's restore response
      // also returns sha256 for inline mode, but we never trust runtime
      // helper output unverified — we hash the bytes ourselves before
      // writing.
      const expectedHistSha = meta.sha256
      const restoreResult = await ctx.helper!.historyRestore({
        path: canonical,
        version,
      })
      let restored: boolean
      if (restoreResult.mode === "delete") {
        if (curPriorExists) {
          await ctx.backend.deleteFile(canonical, {
            expectedShaForCAS: curSha ?? undefined,
          })
        }
        restored = false
      } else if (restoreResult.mode === "inline") {
        const b64 = restoreResult.content_b64 ?? ""
        const buf = Buffer.from(b64, "base64")
        // Verify the decoded bytes hash to the historical sha. Closes the
        // "corrupted blob silently restored" attack: a tampered blob in
        // the work-dir would otherwise be written into user-visible space
        // and the user'd attribute it to the historical version.
        if (expectedHistSha) {
          const h = createHash("sha256")
          h.update(buf)
          const got = h.digest("hex")
          if (got !== expectedHistSha) {
            throw new ToolFailure(
              "runtime_constraint",
              `restore_blob_corrupt: inline content sha mismatch (got ${got}, expected ${expectedHistSha})`
            )
          }
        }
        await ctx.backend.atomicWrite(canonical, new Uint8Array(buf), {
          createOnly: !curPriorExists,
          createParents: false,
          expectedShaForCAS: curPriorExists ? curSha : null,
        })
        restored = true
      } else if (restoreResult.mode === "tmp_token") {
        const token = restoreResult.tmp_token
        if (!token) {
          throw new ToolFailure(
            "runtime_constraint",
            "helper returned tmp_token mode without a token"
          )
        }
        await ctx.backend.renameInternalTmpInto({
          kind: "restore",
          token,
          destCanonical: canonical,
          expectedShaForCAS: curPriorExists ? curSha : null,
          // renameInternalTmpInto re-hashes the staged file and rejects
          // if it doesn't match — closes the "tampered staging file"
          // attack window.
          expectedSourceSha: expectedHistSha ?? null,
        })
        restored = true
      } else {
        throw new ToolFailure(
          "runtime_constraint",
          `helper returned unknown restore mode: ${restoreResult.mode}`
        )
      }
      if (ctx.helper && ctx.avail.indexAvailable) {
        if (restored) {
          await ctx.helper.indexUpsert({ path: canonical }).catch(() => {})
        } else {
          await ctx.helper.indexRemove({ path: canonical }).catch(() => {})
        }
      }
      // User-facing return strips content / fingerprint / mode.
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ path: canonical, version, restored }),
          },
        ],
      }
    })
  )
}

// ─────────────────────────── search + index tools ────────────────────────────

async function handleSearch(
  args: Record<string, unknown>,
  envelope: OperationEnvelope | undefined,
  ctx: DispatchCtx
): Promise<CatalogToolInvocationResult> {
  const mode = asString(args["mode"])
  if (mode !== "content" && mode !== "path") {
    throw new ToolFailure("invalid_request", "mode must be 'content' or 'path'")
  }
  const query = asString(args["query"])
  if (!query) throw new ToolFailure("invalid_request", "query is required")
  const regex = asBool(args["regex"]) ?? false
  const glob = asString(args["glob"])
  const limit = validateLimit(args["limit"], 50, ctx.cfg.maxSearchLimit)
  const offset = validateOffset(args["offset"], ctx.cfg.maxOffset)
  // Dynamic default for `indexed`.
  let indexed = asBool(args["indexed"])
  if (indexed === undefined) {
    if (mode === "content") {
      indexed = ctx.avail.liveAvailable ? false : ctx.avail.indexAvailable
    } else {
      indexed = ctx.avail.indexAvailable ? true : false
    }
  }
  const grants = getFsGrants(envelope)
  const allowedPrefixes = canonicalGrantPrefixes(grants, "read")
  if (envelope && allowedPrefixes.length === 0) {
    return {
      content: [{ type: "text", text: JSON.stringify({ hits: [] }) }],
    }
  }
  if (indexed) {
    if (regex || glob) {
      throw new ToolFailure(
        "invalid_request",
        `${regex ? "regex" : "glob"}_requires_live_search: use indexed:false for ${regex ? "regex" : "glob"} queries`
      )
    }
    if (!ctx.helper || !ctx.avail.indexAvailable) {
      throw new ToolFailure("runtime_constraint", "index_disabled")
    }
    const helper = ctx.helper
    if (mode === "content") {
      const r = await helper.searchContent({
        query,
        regex,
        limit,
        offset,
        allowed_path_prefixes: allowedPrefixes,
      })
      // Backstop post-filter (defense in depth).
      const hits = r.hits.filter((h) =>
        allowedPrefixes.some((p) => pathUnderPrefix(h.path, p))
      )
      return {
        content: [{ type: "text", text: JSON.stringify({ hits }) }],
        _meta: { hit_count: hits.length, indexed: true },
      }
    }
    const r = await helper.searchPath({
      query,
      limit,
      offset,
      allowed_path_prefixes: allowedPrefixes,
    })
    const hits = r.hits.filter((h) =>
      allowedPrefixes.some((p) => pathUnderPrefix(h.path, p))
    )
    return {
      content: [{ type: "text", text: JSON.stringify({ hits }) }],
      _meta: { hit_count: hits.length, indexed: true },
    }
  }
  // Live mode — TS ripgrep.
  if (!ctx.avail.liveAvailable) {
    throw new ToolFailure("runtime_constraint", "ripgrep_not_found")
  }
  const out = await dispatchRipgrep({
    mode,
    query,
    regex,
    glob,
    limit,
    offset,
    allowedPrefixes,
    hostRootPath: ctx.backend.hostRootPath,
    backend: ctx.backend,
    cfg: ctx.cfg,
    deps: ctx.ripgrepDeps,
  })
  return {
    content: [{ type: "text", text: JSON.stringify({ hits: out.hits }) }],
    _meta: {
      hit_count: out.hits.length,
      indexed: false,
      truncated: out.truncated,
    },
  }
}

async function handleIndexStatus(
  args: Record<string, unknown>,
  envelope: OperationEnvelope | undefined,
  ctx: DispatchCtx
): Promise<CatalogToolInvocationResult> {
  if (!ctx.helper) {
    throw new ToolFailure("runtime_constraint", "index_disabled")
  }
  const subtree = asString(args["subtree"]) ?? "/"
  const canonical = canonicalVfsPath(subtree)
  const grants = getFsGrants(envelope)
  if (envelope && !checkFsGrant(grants, "read", canonical)) {
    throw new ToolFailure(
      "permission_denied",
      `fs_index_status(${canonical}) not covered by any filesystem grant`
    )
  }
  const r = await ctx.helper.indexStatus({ subtree: canonical })
  // Strip any storage field defensively even though the contract forbids it.
  const rest: Record<string, unknown> = {
    ...(r as unknown as Record<string, unknown>),
  }
  delete rest.storage
  // Re-authorize rebuild_task.subtree against the caller's grants. The
  // sidecar surfaces ancestor tasks (e.g. a /-wide rebuild observed
  // from a /public status query) which would leak rebuild activity +
  // task_id to a narrow-grant caller. Drop the field if the caller
  // can't read the task's subtree.
  const rebuildTask = rest.rebuild_task as { subtree?: string } | undefined
  if (envelope && rebuildTask?.subtree) {
    let taskCanon: string | null = null
    try {
      taskCanon = canonicalVfsPath(rebuildTask.subtree)
    } catch {
      // Sidecar shouldn't ship a malformed subtree, but if so fail
      // closed and drop the field.
    }
    if (taskCanon === null || !checkFsGrant(grants, "read", taskCanon)) {
      delete rest.rebuild_task
    }
  }
  return {
    content: [{ type: "text", text: JSON.stringify(rest) }],
  }
}

async function handleIndexRebuild(
  args: Record<string, unknown>,
  envelope: OperationEnvelope | undefined,
  ctx: DispatchCtx
): Promise<CatalogToolInvocationResult> {
  if (!ctx.helper) {
    throw new ToolFailure("runtime_constraint", "index_disabled")
  }
  const subtree = asString(args["subtree"]) ?? "/"
  const canonical = canonicalVfsPath(subtree)
  const grants = getFsGrants(envelope)
  if (envelope && !checkFsGrant(grants, "read", canonical)) {
    throw new ToolFailure(
      "permission_denied",
      `fs_index_rebuild(${canonical}) not covered by any filesystem grant`
    )
  }
  // ignore_patterns is NEVER user-supplied; drop it if a caller sends it.
  const r = await ctx.helper.indexRebuild({ subtree: canonical })
  return {
    content: [{ type: "text", text: JSON.stringify(r) }],
  }
}

async function handleIndexTaskStatus(
  args: Record<string, unknown>,
  envelope: OperationEnvelope | undefined,
  ctx: DispatchCtx
): Promise<CatalogToolInvocationResult> {
  if (!ctx.helper) {
    throw new ToolFailure("runtime_constraint", "index_disabled")
  }
  const taskId = asString(args["task_id"])
  if (!taskId) {
    throw new ToolFailure("invalid_request", "task_id is required")
  }
  // Fetch first; the task's subtree decides authorization. Both
  // "task does not exist" and "task exists but caller can't read its
  // subtree" must surface the SAME error so a caller can't tell the
  // difference by probing — otherwise the exists-vs-denied distinction
  // is a side channel that would let an attacker learn task_ids belong
  // to higher-privileged subtrees. (Random task_id alone isn't enough;
  // if an attacker ever observes a leaked id elsewhere, the existence
  // signal must still not be available.)
  const denyError = new ToolFailure(
    "runtime_constraint",
    `task_not_found_or_denied: ${taskId}`
  )
  let result: Awaited<
    ReturnType<NonNullable<typeof ctx.helper>["indexTaskStatus"]>
  >
  try {
    result = await ctx.helper.indexTaskStatus({ task_id: taskId })
  } catch (err) {
    if (err instanceof FsHelperRpcError && err.rpcCode === -32004) {
      throw denyError
    }
    throw err
  }
  if (envelope) {
    let taskCanonical: string | null = null
    try {
      taskCanonical = canonicalVfsPath(result.subtree)
    } catch {
      // Sidecar should never return a malformed subtree, but if it
      // does, fail closed.
    }
    if (
      taskCanonical === null ||
      !checkFsGrant(getFsGrants(envelope), "read", taskCanonical)
    ) {
      // Same error as not_found — no exists-vs-denied side channel.
      throw denyError
    }
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
  }
}
