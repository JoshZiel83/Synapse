// Canonical matcher helpers shared between the API (grant evaluation +
// envelope construction) and the device runtime (per-tool authorization
// enforcement). Without a single source of truth the two sides drift —
// e.g. the server matcher rejects compound shell operators in a prefix
// grant while the device-side prefix used to accept them.
//
// Bundle-safe: no node: imports so this module compiles into the web
// service-worker bundle without polyfills.

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

export interface CommandlinePolicyShape {
  executor: "bash"
  commandMatchType: "exact" | "prefix" | "tool"
  commandText?: string
  workingDirectory?: string
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
}

/**
 * Authoritative browser authorization decision. `write` covers `read`; the
 * scope match is exact-equality on origin / host / registrable_domain
 * depending on `scopeType`. Callers that don't have a target URL (planning
 * phase) can omit `targetUrl` and we just check the action permission.
 */
export function browserPolicyAllows(
  policy: BrowserPolicyShape,
  args: {
    needed: "read" | "write"
    origin?: string
    host?: string
    registrableDomain?: string
  }
): boolean {
  if (args.needed === "write" && policy.action !== "write") return false
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

/**
 * Authoritative commandline authorization decision. Mirrors the server
 * matcher so device-side enforcement can't drift. Resolves the working
 * directory before checking containment and rejects compound shell
 * operators (`a && b`) under prefix matches.
 */
export function commandlinePolicyAllows(
  policy: CommandlinePolicyShape,
  args: {
    command: string
    workingDirectory?: string
  }
): boolean {
  if (policy.executor !== "bash") return false
  const command = normalizeCommandText(args.command)
  if (!command) return false
  if (policy.workingDirectory) {
    const normalizedPolicyDir = normalizePathPrefix(policy.workingDirectory)
    if (!normalizedPolicyDir) return false
    const normalizedCallDir = normalizePathPrefix(args.workingDirectory)
    if (!normalizedCallDir) return false
    if (!pathWithinPrefix(normalizedCallDir, normalizedPolicyDir)) return false
  }
  const grantedText = normalizeCommandText(policy.commandText)
  switch (policy.commandMatchType) {
    case "exact":
      return Boolean(grantedText && grantedText === command)
    case "prefix":
      if (!grantedText) return false
      // Server matcher rejects compound shell operators in prefix grants
      // to prevent `ls -la && cat /etc/passwd` from sneaking past an
      // `ls` prefix policy. Device-side must do the same.
      if (hasCompoundShellOperators(command)) return false
      return commandPrefixMatches(grantedText, command)
    case "tool": {
      if (!grantedText) return false
      const head = command.trim().split(/\s+/)[0] ?? ""
      return head === grantedText
    }
    default:
      return false
  }
}
