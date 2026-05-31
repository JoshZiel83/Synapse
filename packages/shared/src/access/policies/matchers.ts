// Canonical matcher helpers shared between the API (grant evaluation +
// envelope construction) and the device runtime (per-tool authorization
// enforcement). Without a single source of truth the two sides drift —
// e.g. the server matcher rejects compound shell operators in a prefix
// grant while the device-side prefix used to accept them.
//
// Bundle-safe: no node: imports so this module compiles into the web
// service-worker bundle without polyfills.

import type { BrowserOperation } from "@synapse/device-protocol/browser-tools"

/**
 * Resolve + normalize a POSIX path. Handles leading slash, "..", ".",
 * doubled slashes, trailing slashes. Returns null for empty / non-string
 * inputs so callers can fail closed.
 *
 * We implement this inline rather than using node:path because @synapse/shared
 * is bundled for both node (api + device-runtime) and browser (web SW).
 */
export function normalizePathPrefix(value: unknown): string | null {
  if (typeof value !== "string") return null
  const raw = value.trim()
  if (raw.length === 0) return null
  const isAbsolute = raw.startsWith("/")
  const segments = raw.split("/").filter((s) => s.length > 0 && s !== ".")
  const stack: string[] = []
  for (const segment of segments) {
    if (segment === "..") {
      if (stack.length > 0) stack.pop()
      // when absolute, popping past root is a no-op (POSIX semantics);
      // when relative, dropping all leading ..s would make pathWithinPrefix
      // checks fail closed against an absolute prefix.
      continue
    }
    stack.push(segment)
  }
  const joined = stack.join("/")
  if (isAbsolute) return "/" + joined
  return joined.length === 0 ? "." : joined
}

/** Returns true iff `target` equals `prefix` or is a child of `prefix/`. */
export function pathWithinPrefix(target: string, prefix: string): boolean {
  const sep = prefix.endsWith("/") ? "" : "/"
  return target === prefix || target.startsWith(`${prefix}${sep}`)
}

/** Trim + reject empty. */
export function normalizeCommandText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Compound shell operators that break prefix matching. */
export function hasCompoundShellOperators(command: string): boolean {
  return (
    command.includes("&&") ||
    command.includes("||") ||
    command.includes(";") ||
    command.includes("|") ||
    command.includes("\n")
  )
}

/** Token-boundary aware prefix match: `git` does NOT match `git-credential`. */
export function commandPrefixMatches(prefix: string, command: string): boolean {
  if (command === prefix) return true
  if (!command.startsWith(prefix)) return false
  const next = command.charAt(prefix.length)
  return next === " " || next === "\t" || next === "\n"
}

export interface FilesystemPolicyShape {
  access: "read" | "write"
  pathPrefixes: string[]
}

/** Resolved + normalized version of a filesystem policy from the grant. */
export interface NormalizedFilesystemPolicy {
  access: "read" | "write"
  pathPrefixes: string[]
}

export function normalizeFilesystemPolicy(
  policy: FilesystemPolicyShape
): NormalizedFilesystemPolicy {
  return {
    access: policy.access,
    pathPrefixes: Array.from(
      new Set(
        policy.pathPrefixes
          .map((value) => normalizePathPrefix(value))
          .filter((v): v is string => Boolean(v))
      )
    ).sort(),
  }
}

/**
 * Authoritative filesystem authorization decision. The needed access
 * defaults to 'read'; 'write' implies 'read'. The target path is
 * resolved + normalized BEFORE prefix matching, so `/safe/../secret`
 * collapses to `/secret` and fails against a `/safe` grant.
 */
export function filesystemPolicyAllows(
  policy: FilesystemPolicyShape,
  needed: "read" | "write",
  path: string
): boolean {
  if (needed === "write" && policy.access !== "write") return false
  const normalizedTarget = normalizePathPrefix(path)
  if (!normalizedTarget) return false
  const normalizedPolicy = normalizeFilesystemPolicy(policy)
  if (normalizedPolicy.pathPrefixes.length === 0) return false
  return normalizedPolicy.pathPrefixes.some((prefix) =>
    pathWithinPrefix(normalizedTarget, prefix)
  )
}

export interface CommandlineShellPolicyShape {
  executor: "bash" | "powershell"
  commandMatchType: "exact" | "prefix" | "tool"
  commandText?: string
  workingDirectory?: string
  allowBundledToolchain?: boolean
  allowedEnv?: string[]
}

export interface CommandlineExecFilePolicyShape {
  executor: "exec_file"
  commandMatchType: "argv_exact" | "argv_prefix" | "argv_exact_preapproved"
  program: string
  argvPrefix?: string[]
  workingDirectory?: string
  allowBundledToolchain?: boolean
  allowedEnv?: string[]
}

export interface CommandlineSandboxPolicyShape {
  executor: "sandbox"
  // Optional narrower cap within the sandbox (a sub-mount). Absent = the whole
  // sandbox (all mount points).
  workingDirectory?: string
  allowedEnv?: string[]
}

export type CommandlinePolicyShape =
  | CommandlineShellPolicyShape
  | CommandlineExecFilePolicyShape
  | CommandlineSandboxPolicyShape

export type NormalizedCommandlinePolicy = CommandlinePolicyShape

export type CommandlineMatchRequest =
  | {
      kind: "shell"
      executor: "bash" | "powershell"
      command: string
      workingDirectory?: string
      platform?: "win32" | "linux" | "darwin"
    }
  | {
      kind: "exec_file"
      program: string
      argv: readonly string[]
      workingDirectory?: string
      platform?: "win32" | "linux" | "darwin"
      /**
       * The caller's stated need for bundled fallback (i.e. the API set
       * `allowBundledToolchain: true` on the requested action). A grant
       * only COVERS this request if its own `allowBundledToolchain` is
       * also true. Without this check, an older `allowBundledToolchain=
       * undefined/false` grant would silently mask a new bundled-required
       * dispatch, the API would skip the new authorization request, and
       * the device would reject the call at execution time — the
       * "approved-but-unrunnable" hole the user called out.
       */
      requiresBundled?: boolean
    }

export interface CuaPolicyShape {
  access: "read" | "write"
}

/**
 * Authoritative CUA authorization decision. `write` covers `read` so a
 * principal with cua:write grants can also read-only enumerate displays
 * without forcing a second authorization.
 */
export function cuaPolicyAllows(
  policy: CuaPolicyShape,
  needed: "read" | "write"
): boolean {
  if (needed === "write") return policy.access === "write"
  return policy.access === "read" || policy.access === "write"
}

export interface BrowserPolicyShape {
  action: "read" | "write"
  scopeType: "origin" | "host" | "domain"
  origin?: string
  host?: string
  registrableDomain?: string
  /**
   * v3.1 fail-closed: when callers pass `args.neededOperations`, every needed
   * op MUST appear in `policy.operations`. A grant whose `operations` is
   * missing/null/empty does NOT cover any operation-requesting call —
   * legacy compatibility was explicitly waived (dev environment, no
   * production data). See plan §clarification A.
   */
  operations?: BrowserOperation[]
}

/**
 * Authoritative browser authorization decision. `write` covers `read`; the
 * scope match is exact-equality on origin / host / registrable_domain
 * depending on `scopeType`. Callers that don't have a target URL (planning
 * phase) can omit `targetUrl` and we just check the action permission.
 *
 * `neededOperations` (v3.1): when supplied as a non-empty array, EVERY needed
 * op must appear in `policy.operations`. Missing/empty `policy.operations`
 * fails closed. Tests in browser.json fixture #3 lock this in.
 */
export function browserPolicyAllows(
  policy: BrowserPolicyShape,
  args: {
    needed: "read" | "write"
    origin?: string
    host?: string
    registrableDomain?: string
    neededOperations?: BrowserOperation[]
  }
): boolean {
  if (args.needed === "write" && policy.action !== "write") return false
  if (args.neededOperations && args.neededOperations.length > 0) {
    if (!Array.isArray(policy.operations) || policy.operations.length === 0) {
      return false
    }
    const granted = new Set<BrowserOperation>(policy.operations)
    for (const op of args.neededOperations) {
      if (!granted.has(op)) return false
    }
  }
  switch (policy.scopeType) {
    case "origin":
      return Boolean(
        policy.origin && args.origin && policy.origin === args.origin
      )
    case "host":
      return Boolean(policy.host && args.host && policy.host === args.host)
    case "domain":
      return Boolean(
        policy.registrableDomain &&
        args.registrableDomain &&
        policy.registrableDomain === args.registrableDomain
      )
    default:
      return false
  }
}

// ─────────────────────────── argv exec_file helpers ─────────────────────────

import { normalizeProgramName } from "./commandline-normalize.js"

/**
 * Maintainer-curated allow-list of side-effect-free invocations. The label
 * "preapproved" instead of "readonly" is deliberate: these commands MAY
 * still read repo config or environment, so we make no security claim
 * beyond "they're high-volume, low-risk, and worth a one-click approval".
 * Git intentionally absent — repo config / external diff / fsmonitor are
 * effectively executable surfaces.
 */
const ARGV_EXACT_PREAPPROVED: ReadonlyArray<{
  program: string
  argvEquals: readonly string[]
}> = [
  { program: "node", argvEquals: ["--version"] },
  { program: "node", argvEquals: ["-v"] },
  { program: "python", argvEquals: ["--version"] },
]

function argvEqualsExact(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function argvHasPrefix(
  prefix: readonly string[],
  argv: readonly string[]
): boolean {
  if (prefix.length === 0) return false
  if (prefix.length > argv.length) return false
  for (let i = 0; i < prefix.length; i++)
    if (prefix[i] !== argv[i]) return false
  return true
}

function workingDirCheckPasses(
  policyDir: string | undefined,
  callDir: string | undefined
): boolean {
  if (!policyDir) return true
  const normalizedPolicyDir = normalizePathPrefix(policyDir)
  if (!normalizedPolicyDir) return false
  const normalizedCallDir = normalizePathPrefix(callDir)
  if (!normalizedCallDir) return false
  return pathWithinPrefix(normalizedCallDir, normalizedPolicyDir)
}

/**
 * Authoritative commandline authorization decision. Mirrors the server
 * matcher so device-side enforcement can't drift. Returns the NORMALIZED
 * policy on match (so device callers can read allowBundledToolchain /
 * allowedEnv directly) or null on miss. Caller (device builtin / server
 * projection) wraps null into a structured permission_denied.
 */
export function commandlinePolicyAllows(
  policy: CommandlinePolicyShape,
  request: CommandlineMatchRequest
): NormalizedCommandlinePolicy | null {
  // Sandbox grant: isolation IS the boundary. It covers ANY command (shell or
  // exec_file) provided the working directory resolves within the sandbox mount
  // points. No command/argv matching — that's the whole point of the variant.
  // (The bwrap confinement that makes this safe is enforced at spawn time.)
  if (policy.executor === "sandbox") {
    return sandboxPolicyAllows(policy, request)
  }

  // Cross-branch: request kind must align with policy executor.
  if (request.kind === "shell") {
    if (policy.executor !== "bash" && policy.executor !== "powershell") {
      return null
    }
    if (policy.executor !== request.executor) return null
  } else {
    if (policy.executor !== "exec_file") return null
  }

  // Windows: matcher denies any cwd grant/request until path normalization
  // supports backslash / drive letters / UNC.
  if (request.platform === "win32") {
    if (policy.workingDirectory || request.workingDirectory) {
      return null
    }
  }

  if (request.kind === "shell") {
    const shellPolicy = policy as CommandlineShellPolicyShape
    // PowerShell v1 only supports exact (compound-operator heuristics +
    // token boundary semantics are Bash-shaped; PowerShell parser is a
    // follow-up).
    if (
      shellPolicy.executor === "powershell" &&
      shellPolicy.commandMatchType !== "exact"
    ) {
      return null
    }
    if (
      !workingDirCheckPasses(
        shellPolicy.workingDirectory,
        request.workingDirectory
      )
    ) {
      return null
    }
    const command = normalizeCommandText(request.command)
    if (!command) return null
    const grantedText = normalizeCommandText(shellPolicy.commandText)
    switch (shellPolicy.commandMatchType) {
      case "exact":
        return grantedText && grantedText === command ? shellPolicy : null
      case "prefix":
        if (!grantedText) return null
        if (hasCompoundShellOperators(command)) return null
        return commandPrefixMatches(grantedText, command) ? shellPolicy : null
      case "tool": {
        if (!grantedText) return null
        const head = command.trim().split(/\s+/)[0] ?? ""
        return head === grantedText ? shellPolicy : null
      }
      default:
        return null
    }
  }

  // exec_file branch
  const execFilePolicy = policy as CommandlineExecFilePolicyShape
  if (
    !workingDirCheckPasses(
      execFilePolicy.workingDirectory,
      request.workingDirectory
    )
  ) {
    return null
  }
  // If the caller requires bundled fallback (API set allowBundledToolchain
  // on the request because the program needs it on this device), only a
  // grant that ALSO has allowBundledToolchain=true covers. Otherwise a
  // pre-existing "no bundle" grant would silently satisfy the match and
  // the device would reject at execution.
  if (
    request.kind === "exec_file" &&
    request.requiresBundled === true &&
    execFilePolicy.allowBundledToolchain !== true
  ) {
    return null
  }
  const policyProgram = normalizeProgramName(execFilePolicy.program)
  const requestProgram = normalizeProgramName(request.program)
  if (execFilePolicy.commandMatchType === "argv_exact_preapproved") {
    for (const entry of ARGV_EXACT_PREAPPROVED) {
      const entryProgramNorm = normalizeProgramName(entry.program)
      if (entryProgramNorm !== requestProgram) continue
      if (!argvEqualsExact(entry.argvEquals, request.argv)) continue
      return execFilePolicy
    }
    return null
  }
  // argv_exact / argv_prefix both require .program match.
  if (policyProgram !== requestProgram) return null
  switch (execFilePolicy.commandMatchType) {
    case "argv_exact":
      if (!execFilePolicy.argvPrefix) return null
      return argvEqualsExact(execFilePolicy.argvPrefix, request.argv)
        ? execFilePolicy
        : null
    case "argv_prefix":
      if (!execFilePolicy.argvPrefix) return null
      // Empty argvPrefix would authorize any args for this program.
      if (execFilePolicy.argvPrefix.length === 0) return null
      return argvHasPrefix(execFilePolicy.argvPrefix, request.argv)
        ? execFilePolicy
        : null
    default:
      return null
  }
}

// The fixed mount points a sandbox device-runtime exposes. Inlined here (rather
// than imported from constants/enums) to keep this matcher bundle-safe and
// dependency-free; must stay in sync with SANDBOX_MOUNT_POINTS in
// constants/enums.ts (the API/projection copy).
const SANDBOX_MATCHER_MOUNT_POINTS = [
  "/conversation",
  "/actor",
  "/actor-conversation",
] as const

/**
 * Sandbox commandline authorization: a sandbox grant covers any command whose
 * working directory resolves within the sandbox mount points (and within the
 * grant's optional narrower workingDirectory cap, if set). Command text / argv
 * are intentionally ignored — bwrap confinement, not a command whitelist, is
 * the security boundary.
 *
 * A request with NO working directory is denied: we cannot prove a command runs
 * inside the jail without knowing its cwd, and a sandbox command always has one
 * (provisioning sets cwd=/conversation by default).
 */
function sandboxPolicyAllows(
  policy: CommandlineSandboxPolicyShape,
  request: CommandlineMatchRequest
): NormalizedCommandlinePolicy | null {
  // Sandbox is Linux/bwrap-only; a win32 request can never be inside a jail.
  if (request.platform === "win32") return null

  const callDir = normalizePathPrefix(request.workingDirectory)
  if (!callDir) return null

  // Must be within at least one mount point.
  const withinAMount = SANDBOX_MATCHER_MOUNT_POINTS.some((mount) =>
    pathWithinPrefix(callDir, mount)
  )
  if (!withinAMount) return null

  // Honor the grant's optional narrower cap (a sub-mount).
  if (policy.workingDirectory) {
    const cap = normalizePathPrefix(policy.workingDirectory)
    if (!cap) return null
    if (!pathWithinPrefix(callDir, cap)) return null
  }

  return policy
}
