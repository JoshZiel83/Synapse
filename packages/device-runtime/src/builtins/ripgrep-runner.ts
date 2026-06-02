// TS-side live search wrapper around ripgrep. Used by fs_search when
// indexed=false. Mirrors the plan's pipeline:
//   hostPath -> root-relative POSIX (manual, NOT canonicalVfsPath which
//   would reject /.synapse-internal/*) -> drop outside root -> drop
//   /.synapse-internal exact + descendants -> path_under_prefix(canonicalHit,
//   allowedPrefixes) -> dedupe -> count toward offset+limit -> slice.

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { delimiter, join, relative, sep } from "node:path"
import picomatch from "picomatch"
import { INTERNAL_NAMESPACE, pathUnderPrefix } from "../vfs.js"
import type { ExtendedLocalBackend } from "../vfs.js"

export interface RipgrepDeps {
  spawnImpl?: typeof spawn
  ripgrepPath?: string
}

export interface RipgrepDispatchInput {
  mode: "content" | "path"
  query: string
  regex: boolean
  glob?: string
  limit: number
  offset: number
  allowedPrefixes: string[]
  hostRootPath: string
  backend: ExtendedLocalBackend
  cfg: {
    maxOffset: number
  }
  deps?: RipgrepDeps
}

export interface RipgrepHit {
  path: string
  score?: number
  snippet?: string
  line_no?: number
  byte_offset?: number
}

export interface RipgrepDispatchOutput {
  hits: RipgrepHit[]
  truncated: boolean
}

const SEARCH_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024
const INTERNAL_PREFIX = INTERNAL_NAMESPACE + "/"

export function detectRipgrep(deps?: RipgrepDeps): string | null {
  if (deps?.ripgrepPath && existsSync(deps.ripgrepPath)) {
    return deps.ripgrepPath
  }
  const pathEnv = process.env.PATH ?? ""
  const ext = process.platform === "win32" ? [".exe"] : [""]
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const e of ext) {
      const c = join(dir, "rg" + e)
      if (existsSync(c)) return c
    }
  }
  return null
}

function hostToCanonical(
  hostPath: string,
  hostRootPath: string,
  hostRootWithSep: string
): string | null {
  if (hostPath === hostRootPath) return "/"
  if (!hostPath.startsWith(hostRootWithSep)) return null
  const rel = relative(hostRootPath, hostPath)
  if (rel.startsWith("..")) return null
  return "/" + rel.split(sep).join("/")
}

function isInternal(canonical: string): boolean {
  return (
    canonical === INTERNAL_NAMESPACE || canonical.startsWith(INTERNAL_PREFIX)
  )
}

async function runRgStream(opts: {
  rgPath: string
  args: string[]
  onLine: (line: string) => boolean // return false to stop
  spawnImpl?: typeof spawn
}): Promise<{ truncated: boolean }> {
  const spawnImpl = opts.spawnImpl ?? spawn
  return await new Promise((resolve, reject) => {
    const child = spawnImpl(opts.rgPath, opts.args, {
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcess
    let killed = false
    let buffered = ""
    let outputBytes = 0
    let truncated = false
    const timer = setTimeout(() => {
      killed = true
      try {
        child.kill("SIGKILL")
      } catch {
        /* swallow */
      }
    }, SEARCH_TIMEOUT_MS)
    let stopped = false
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stopped) return
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8")
      outputBytes += s.length
      if (outputBytes > MAX_OUTPUT_BYTES) {
        truncated = true
        stopped = true
        try {
          child.kill("SIGTERM")
        } catch {
          /* swallow */
        }
        return
      }
      buffered += s
      let idx = buffered.indexOf("\n")
      while (idx >= 0) {
        const line = buffered.slice(0, idx)
        buffered = buffered.slice(idx + 1)
        if (line.length > 0) {
          const cont = opts.onLine(line)
          if (!cont) {
            stopped = true
            try {
              child.kill("SIGTERM")
            } catch {
              /* swallow */
            }
            break
          }
        }
        idx = buffered.indexOf("\n")
      }
    })
    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on("close", () => {
      clearTimeout(timer)
      if (killed) {
        // Treat timeout-kill as a soft termination — return what we have.
        resolve({ truncated: true })
        return
      }
      if (buffered.length > 0) opts.onLine(buffered)
      resolve({ truncated })
    })
  })
}

export async function dispatchRipgrep(
  input: RipgrepDispatchInput
): Promise<RipgrepDispatchOutput> {
  const rgPath = input.deps?.ripgrepPath ?? detectRipgrep(input.deps) ?? "rg"
  const hostRootPath = input.hostRootPath
  const hostRootWithSep = hostRootPath.endsWith(sep)
    ? hostRootPath
    : hostRootPath + sep
  // Resolve grant prefixes to host paths.
  const allowedHostPaths: string[] = []
  for (const p of input.allowedPrefixes) {
    try {
      const host = await input.backend.safeResolve(p)
      allowedHostPaths.push(host)
    } catch {
      // skip prefixes that can't be resolved
    }
  }
  if (allowedHostPaths.length === 0) {
    return { hits: [], truncated: false }
  }
  const args: string[] = []
  if (input.mode === "content") {
    args.push("--json", "--no-messages", "--max-filesize", "50M")
    args.push("--glob", "!.synapse-internal/**")
    if (input.glob) args.push("--glob", input.glob)
    if (input.regex) {
      args.push("--pcre2", input.query)
    } else {
      args.push("--fixed-strings", input.query)
    }
    args.push(...allowedHostPaths)
  } else {
    // mode=path
    args.push("--files", "--no-messages")
    args.push("--glob", "!.synapse-internal/**")
    args.push(...allowedHostPaths)
  }
  const hits: RipgrepHit[] = []
  const seen = new Set<string>()
  const targetCount = input.offset + input.limit
  let regexFilter: RegExp | null = null
  if (input.mode === "path" && input.query.length > 0) {
    regexFilter = input.regex ? new RegExp(input.query) : null
  }
  let globFilter: ((path: string) => boolean) | null = null
  if (input.mode === "path" && input.glob) {
    // picomatch is the de-facto glob matcher (powers fast-glob/globby/chokidar)
    // and implements **, *, ?, braces, negation, and POSIX classes — the gaps
    // the previous "minimal glob translator" left open. dot:true so dotfiles
    // match like rg's --glob does.
    const isMatch = picomatch(input.glob, { dot: true })
    globFilter = (path: string) => isMatch(path)
  }
  const { truncated } = await runRgStream({
    rgPath,
    args,
    spawnImpl: input.deps?.spawnImpl,
    onLine: (line) => {
      if (input.mode === "content") {
        let frame: {
          type?: string
          data?: {
            path?: { text?: string }
            line_number?: number
            absolute_offset?: number
            lines?: { text?: string }
          }
        }
        try {
          frame = JSON.parse(line)
        } catch {
          return true
        }
        if (frame.type !== "match") return true
        const p = frame.data?.path?.text
        if (!p) return true
        const canonical = hostToCanonical(p, hostRootPath, hostRootWithSep)
        if (!canonical) return true
        if (isInternal(canonical)) return true
        if (
          !input.allowedPrefixes.some((pref) =>
            pathUnderPrefix(canonical, pref)
          )
        ) {
          return true
        }
        const key = `${canonical}:${frame.data?.line_number ?? 0}:${frame.data?.absolute_offset ?? 0}:${frame.data?.lines?.text ?? ""}`
        if (seen.has(key)) return true
        seen.add(key)
        const snippet = frame.data?.lines?.text ?? ""
        hits.push({
          path: canonical,
          line_no: frame.data?.line_number,
          byte_offset: frame.data?.absolute_offset,
          snippet,
        })
        return hits.length < targetCount
      }
      // mode = path: each line is a host path
      const canonical = hostToCanonical(line, hostRootPath, hostRootWithSep)
      if (!canonical) return true
      if (isInternal(canonical)) return true
      if (
        !input.allowedPrefixes.some((pref) => pathUnderPrefix(canonical, pref))
      ) {
        return true
      }
      if (input.query.length > 0) {
        if (input.regex) {
          if (!regexFilter || !regexFilter.test(canonical)) return true
        } else {
          if (!canonical.includes(input.query)) return true
        }
      }
      if (globFilter) {
        // Strip leading slash for glob matching — globs are interpreted
        // relative to the search root (matches `rg --glob` semantics).
        const relForGlob = canonical.startsWith("/")
          ? canonical.slice(1)
          : canonical
        if (!globFilter(relForGlob)) return true
      }
      if (seen.has(canonical)) return true
      seen.add(canonical)
      hits.push({ path: canonical })
      return hits.length < targetCount
    },
  })
  const sliced = hits.slice(input.offset, input.offset + input.limit)
  return { hits: sliced, truncated }
}
