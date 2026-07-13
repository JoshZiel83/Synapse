// Commandline builtin: registers bash / powershell / exec_file tools and
// routes invocations through the terminal/ stack landed in Commits 1-4.
//
// Tool registration is platform-aware:
//   - POSIX: bash (if bash on PATH), exec_file (always)
//   - Windows: powershell (if pwsh/powershell.exe on PATH), exec_file
//
// invokeTool flow (设计红线 §11/§13/§16/§17/§18):
//   1. strict argument validation (program/args type, isBareCommandName,
//      command non-empty) — produces invalid_request BEFORE the matcher.
//   2. checkCommandlineAccess: matcher against signed envelope's
//      commandline grants; returns matched policy or permission_denied.
//   3. exec_file branch: resolve the program (bundle-eligible -> resolver
//      with policy.allowBundledToolchain; otherwise resolveBare for system
//      PATH only). Both branches yield a ResolvedToolchain.
//   4. build spawn descriptor (shell provider for bash/powershell,
//      buildExecFileDescriptor for exec_file).
//   5. spawnTerminalProcess with the resolved environment, toolchain env,
//      toolchain binDirs, sanitized PATH. Windows policy+request workdir
//      already filtered out by the matcher; we still defense-in-depth
//      double-check before spawn.

import type { CatalogProvider, CatalogToolInvocationResult } from "../types.js"
import type {
  RuntimeCatalogExposure,
  RuntimeCatalogTool,
} from "@synapse/device-protocol"
import { toolErrorResult } from "../mcp-host.js"
import { isBareCommandName, isBundleEligibleProgram } from "@synapse/shared"

import { detectTerminalEnvironment } from "../terminal/environment.js"
import { spawnTerminalProcess } from "../terminal/executor.js"
import {
  buildExecFileDescriptor,
  PosixBashProvider,
  PowerShellProvider,
  ShellNotAvailableError,
} from "../terminal/shell-provider.js"
import { buildUtf8Env, InvalidAllowedEnvError } from "../terminal/utf8.js"
import { defaultPrestageDirs } from "../bundles/install.js"
import {
  createToolchainManager,
  ToolchainSha256MismatchError,
  ToolchainUnavailableError,
} from "../terminal/toolchain-manager.js"
import { checkCommandlineAccess } from "../terminal/permissions.js"
import { defaultPathResolver } from "../terminal/environment.js"
import {
  wrapDescriptorWithBwrap,
  bwrapAvailable,
  DEFAULT_SANDBOX_CWD,
} from "../terminal/sandbox-confinement.js"
import type {
  CommandlineMatchRequest,
  NormalizedCommandlinePolicy,
} from "@synapse/shared/access/policies"
import type {
  PathResolver,
  ResolvedTerminalEnvironment,
  ResolvedToolchain,
  ToolchainManager,
} from "../terminal/types.js"
import type { CliCatalog } from "./cli-catalog/index.js"

import { fileURLToPath } from "node:url"
import { dirname, join, resolve as pathResolve } from "node:path"

const PROVIDER_KEY = "builtin.commandline"

// Bundle eligibility (which programs get ToolchainManager.resolve with
// bundled fallback vs resolveBare for system PATH only) is the SAME list
// the API uses to decide whether to set `allowBundledToolchain: true` on
// the grant. Centralized in @synapse/shared/access/policies via
// BUNDLE_ELIGIBLE_PROGRAMS so the two sides can't drift — see the
// extensive comment there before touching the list.

// ───────────────────────────── tool definitions ─────────────────────────────

const BASH_TOOL: RuntimeCatalogTool = {
  stable_key: "commandline/bash",
  name: "bash",
  description:
    "Run a bash command on the device. Output is captured and returned synchronously. Subject to runtime authorization grants of capability='commandline'.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Bash command to execute" },
      working_directory: {
        type: "string",
        description: "Optional working directory",
      },
      timeout_ms: {
        type: "integer",
        description: "Max execution time (default 60s)",
      },
    },
    required: ["command"],
  },
}

const POWERSHELL_TOOL: RuntimeCatalogTool = {
  stable_key: "commandline/powershell",
  name: "powershell",
  description:
    "Run a PowerShell command on the device (pwsh preferred, falling back to Windows PowerShell). UTF-8 output. Subject to runtime authorization grants of capability='commandline'.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "PowerShell command to execute" },
      working_directory: {
        type: "string",
        description: "Optional working directory (not supported on Windows v1)",
      },
      timeout_ms: {
        type: "integer",
        description: "Max execution time (default 60s)",
      },
    },
    required: ["command"],
  },
}

const EXEC_FILE_TOOL: RuntimeCatalogTool = {
  stable_key: "commandline/exec_file",
  name: "exec_file",
  description:
    "Spawn an executable directly with structured argv (no shell). Program must be a bare command name (no path separators, parent traversal, or absolute paths). Subject to runtime authorization grants of capability='commandline' with executor='exec_file'.",
  input_schema: {
    type: "object",
    properties: {
      program: {
        type: "string",
        description:
          "Bare command name (e.g. 'python', 'node', 'git', or any system PATH binary like 'rg'). Resolved via system PATH; programs on the bundled-toolchain allow-list (python + node on linux/darwin x64/arm64; git on Windows x64/arm64 via MinGit) may additionally fall back to a vetted bundled archive when policy.allow_bundled_toolchain=true. Other programs require a working system installation.",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments to pass to the program (default [])",
      },
      working_directory: {
        type: "string",
        description: "Optional working directory",
      },
      timeout_ms: {
        type: "integer",
        description: "Max execution time (default 60s)",
      },
    },
    required: ["program"],
  },
}

/**
 * CORE commandline tool defs the api-authored bare-sandbox catalog derives from
 * (§4.3 / F-D). Exported as the SINGLE source of truth so the static catalog and
 * the device builtin's describeExposures() cannot drift — the golden-drift test
 * asserts equivalence. Linux bare adapters expose bash + exec_file (no
 * powershell).
 */
export const COMMANDLINE_CORE_TOOL_DEFS: readonly RuntimeCatalogTool[] = [
  BASH_TOOL,
  EXEC_FILE_TOOL,
]

// ─────────────────────────── builtin factory ────────────────────────────────

export interface CommandlineBuiltinOptions {
  displayName?: string
  /**
   * Pre-detected environment. Production (bin.ts) shares one snapshot
   * across all builtins; tests typically omit and let the builtin lazy-
   * detect via getDefaultEnvironment().
   */
  environment?: ResolvedTerminalEnvironment
  /**
   * Pre-constructed manager. When omitted, the builtin builds a default
   * manager pointing at the packaged manifest under bundles/manifest.json.
   */
  toolchainManager?: ToolchainManager
  /** Path resolver — defaults to defaultPathResolver. */
  pathResolver?: PathResolver
  /**
   * When set, every command is wrapped in a bwrap jail rooted at this sandbox
   * (no network, mount points bound to /conversation·/actor·/actor-conversation,
   * cwd=/conversation). Set by the sandbox device-runtime (`run --cmd-sandbox`);
   * Linux-only. Absent = normal host execution.
   */
  sandboxRoot?: string
  /**
   * When true, the bwrap jail does NOT `--unshare-net` (shares the runtime's
   * network namespace). Only meaningful with `sandboxRoot`. Set when network
   * isolation is delegated to the container layer (Docker without
   * CAP_NET_ADMIN, where `--unshare-net`'s loopback bring-up fails). Default
   * false = isolated empty netns. See SandboxConfinement.shareNet.
   */
  sandboxShareNet?: boolean
  /**
   * CLI-Anything catalog helper. When set, describeExposures merges an
   * entryPoint-keyed availableClis map into the exposure metadata so the
   * server can gate/mint per-CLI program_only grants. See plan §4.2/§5.B.
   */
  cliCatalog?: CliCatalog
}

export function createCommandlineBuiltin(
  opts: CommandlineBuiltinOptions = {}
): CatalogProvider {
  return {
    providerKey: PROVIDER_KEY,
    async describeExposures(): Promise<RuntimeCatalogExposure[]> {
      const env = await resolveEnvironment(opts)
      const tools: RuntimeCatalogTool[] = []
      const executors: string[] = []
      if (env.platform === "win32") {
        if (env.powershell) {
          tools.push(POWERSHELL_TOOL)
          executors.push("powershell")
        }
      } else if (env.bash) {
        tools.push(BASH_TOOL)
        executors.push("bash")
      }
      tools.push(EXEC_FILE_TOOL)
      executors.push("exec_file")
      // CLI-Anything availability rides this exposure's metadata (zero-migration
      // carrier, plan §4.2). Keyed by entryPoint so the server-side program_only
      // grant (program=entryPoint) lines up with the matcher's program equality.
      // FAIL-CLOSED (plan §5.B): a probe error must omit availableClis, never break
      // the bash/exec_file exposure this metadata rides on. invalidate() so a
      // rejected memo isn't cached and the next sync re-probes.
      let availableClis: Record<string, unknown> | undefined
      if (opts.cliCatalog) {
        try {
          availableClis = await opts.cliCatalog.getAvailableClis(env)
        } catch {
          opts.cliCatalog.invalidate()
        }
      }
      return [
        {
          stable_key: "builtin/commandline",
          display_name: opts.displayName ?? "Commandline (shell + exec_file)",
          transport: "builtin",
          builtin_kind: "commandline",
          metadata: {
            executors,
            asyncTasksSupported: false,
            schemaVersion: 2,
            ...(availableClis ? { availableClis } : {}),
          },
          tools,
        },
      ]
    },
    async invokeTool(input): Promise<CatalogToolInvocationResult> {
      const env = await resolveEnvironment(opts)
      const platform = env.platform

      // Strict parameter validation FIRST (设计红线 §13: must precede
      // the matcher so a malformed call returns invalid_request, not
      // permission_denied).
      let request: CommandlineMatchRequest
      let resolvedWorkingDirectory: string | undefined

      const rawWorkingDirectory = input.args["working_directory"]
      if (
        rawWorkingDirectory !== undefined &&
        typeof rawWorkingDirectory !== "string"
      ) {
        return toolErrorResult({
          code: "invalid_request",
          message: "working_directory must be a string",
        })
      }
      resolvedWorkingDirectory =
        typeof rawWorkingDirectory === "string"
          ? rawWorkingDirectory
          : undefined

      // In a sandbox, default the working directory to the sandbox cwd
      // (/conversation) BEFORE the permission gate. The sandbox matcher requires
      // a cwd inside a mount point and denies a request with none; applying the
      // default here (not just at the spawn layer) means a normal sandbox
      // command with no explicit cwd is authorized against the default mount and
      // runs there, instead of being rejected by the matcher.
      if (opts.sandboxRoot && resolvedWorkingDirectory === undefined) {
        resolvedWorkingDirectory = DEFAULT_SANDBOX_CWD
      }

      const rawTimeout = input.args["timeout_ms"]
      if (rawTimeout !== undefined && typeof rawTimeout !== "number") {
        return toolErrorResult({
          code: "invalid_request",
          message: "timeout_ms must be a number",
        })
      }
      const timeoutMs = typeof rawTimeout === "number" ? rawTimeout : undefined

      switch (input.toolName) {
        case "bash":
        case "powershell": {
          const command = input.args["command"]
          if (typeof command !== "string" || command.length === 0) {
            return toolErrorResult({
              code: "invalid_request",
              message: `${input.toolName}: 'command' (non-empty string) is required`,
            })
          }
          request = {
            kind: "shell",
            executor: input.toolName,
            command,
            workingDirectory: resolvedWorkingDirectory,
            platform,
          }
          break
        }
        case "exec_file": {
          const program = input.args["program"]
          if (typeof program !== "string" || program.length === 0) {
            return toolErrorResult({
              code: "invalid_request",
              message: "exec_file: 'program' (non-empty string) is required",
            })
          }
          if (!isBareCommandName(program)) {
            return toolErrorResult({
              code: "invalid_request",
              message:
                "exec_file: 'program' must be a bare command name (no /, \\, .., absolute path, or ~ prefix)",
            })
          }
          const rawArgv = input.args["args"]
          let argv: string[] = []
          if (rawArgv !== undefined) {
            if (
              !Array.isArray(rawArgv) ||
              rawArgv.some((v) => typeof v !== "string")
            ) {
              return toolErrorResult({
                code: "invalid_request",
                message: "exec_file: 'args' must be string[] if provided",
              })
            }
            argv = rawArgv as string[]
          }
          request = {
            kind: "exec_file",
            program,
            argv,
            workingDirectory: resolvedWorkingDirectory,
            platform,
          }
          break
        }
        default:
          return toolErrorResult({
            code: "invalid_request",
            message: `commandline builtin does not handle ${input.toolName}`,
          })
      }

      // Permission gate.
      const access = checkCommandlineAccess({
        envelope: input.envelope,
        request,
        toolName: input.toolName,
      })
      if (!access.ok) return access.tool

      // Resolve toolchain (exec_file only).
      let resolved: ResolvedToolchain | undefined
      if (request.kind === "exec_file") {
        const manager = await getDefaultToolchainManager(opts, env)
        // A sandbox grant carries no allowBundledToolchain (isolation is the
        // boundary; bundled-toolchain capping is a shell/exec_file concept).
        const allowBundled =
          access.policy.executor === "sandbox"
            ? false
            : Boolean(access.policy.allowBundledToolchain)
        try {
          if (isBundleEligibleProgram(request.program)) {
            resolved = await manager.resolve(request.program, allowBundled)
          } else {
            const bare = await manager.resolveBare(request.program)
            if (!bare) {
              return toolErrorResult({
                code: "permission_denied",
                message: `program not found on PATH: ${request.program}`,
                details: { reason: "program_not_found" },
              })
            }
            resolved = bare
          }
        } catch (err) {
          if (err instanceof ToolchainUnavailableError) {
            return toolErrorResult({
              code: "runtime_constraint",
              message: err.message,
              details: { reason: "toolchain_unavailable" },
            })
          }
          if (err instanceof ToolchainSha256MismatchError) {
            return toolErrorResult({
              code: "runtime_constraint",
              message: err.message,
              details: { reason: "toolchain_sha256_mismatch" },
            })
          }
          throw err
        }
      }

      // Build spawn descriptor.
      let descriptor
      if (request.kind === "shell") {
        try {
          if (request.executor === "bash") {
            const provider = PosixBashProvider.fromEnvironment(env)
            if (!provider) throw new ShellNotAvailableError("bash")
            descriptor = provider.buildShellDescriptor(request)
          } else {
            const provider = PowerShellProvider.fromEnvironment(env)
            if (!provider) throw new ShellNotAvailableError("powershell")
            descriptor = provider.buildShellDescriptor(request)
          }
        } catch (err) {
          if (err instanceof ShellNotAvailableError) {
            return toolErrorResult({
              code: "runtime_constraint",
              message: err.message,
              details: { reason: `${err.executor}_unavailable` },
            })
          }
          throw err
        }
      } else {
        // Map matcher request (uses `argv`) to TerminalExecFileRequest
        // (uses `args`). The shared matcher names mirror the wire format
        // (argv_prefix etc); the executor's descriptor naming is just
        // node's `child_process.spawn` shape.
        descriptor = buildExecFileDescriptor(
          {
            kind: "exec_file",
            program: (request as { program: string }).program,
            args: (request as { argv: readonly string[] }).argv,
            workingDirectory: resolvedWorkingDirectory,
            timeoutMs,
          },
          resolved!
        )
      }

      // Build base env (utf8 + dangerous strip + locale + sanitized PATH).
      let baseEnv: Record<string, string>
      try {
        baseEnv = buildUtf8Env(env.osEnv, {
          allowedEnv: access.policy.allowedEnv ?? [],
          platform,
        })
      } catch (err) {
        if (err instanceof InvalidAllowedEnvError) {
          return toolErrorResult({
            code: "invalid_request",
            message: err.message,
            details: { reason: "allowed_env_path_forbidden" },
          })
        }
        throw err
      }

      // Defense in depth: matcher should already have filtered Windows cwd,
      // but if anything slipped through (e.g. matcher called with
      // platform=undefined), refuse before spawn.
      if (platform === "win32") {
        const policyWd = access.policy.workingDirectory
        if (policyWd || resolvedWorkingDirectory) {
          return toolErrorResult({
            code: "permission_denied",
            message:
              "Windows commandline policy v1 does not support working_directory",
            details: { reason: "windows_workdir_unsupported" },
          })
        }
      }

      // Sandbox confinement (Step 10): wrap the command in a bwrap jail so the
      // commandline:"sandbox" grant is safe — no network, host FS unreachable
      // outside the mount points, cwd defaults to /conversation. Fail-closed:
      // if sandboxRoot is configured but bwrap isn't actually invocable, refuse
      // rather than run unconfined on the host.
      let spawnDescriptor = descriptor
      let spawnCwd = resolvedWorkingDirectory
      if (opts.sandboxRoot) {
        if (!bwrapAvailable()) {
          return toolErrorResult({
            code: "runtime_constraint",
            message:
              "sandbox commandline requires bwrap, which is not available",
            details: { reason: "bwrap_unavailable" },
          })
        }
        const toolchainBinDirs = resolved ? [resolved.binDir] : []
        spawnDescriptor = wrapDescriptorWithBwrap(descriptor, {
          sandboxRoot: opts.sandboxRoot,
          readonlyBinds: toolchainBinDirs,
          // resolvedWorkingDirectory is defaulted to DEFAULT_SANDBOX_CWD above
          // for sandbox requests, so it's always set here.
          cwd: resolvedWorkingDirectory || DEFAULT_SANDBOX_CWD,
          shareNet: opts.sandboxShareNet,
        })
        // bwrap sets the in-jail cwd via --chdir; the bwrap process itself runs
        // from the sandbox root on the host.
        spawnCwd = opts.sandboxRoot
      }

      const exec = await spawnTerminalProcess(spawnDescriptor, {
        cwd: spawnCwd,
        baseEnv,
        toolchainBinDirs: resolved ? [resolved.binDir] : [],
        toolchainEnv: resolved?.env ?? {},
        platform,
        osEnv: env.osEnv,
        timeoutMs,
      })
      const exitText = exec.killed
        ? `(killed after ${exec.durationMs}ms)`
        : `exit ${exec.exitCode} in ${exec.durationMs}ms`
      // Surface a "..." marker inline so the model can tell its tool
      // result was clipped. Detailed counts go in _meta below.
      const stdoutText = exec.stdoutTruncated
        ? `${exec.stdout}\n... (truncated: ${exec.stdoutDroppedBytes ?? 0} bytes dropped)`
        : exec.stdout
      const stderrText = exec.stderrTruncated
        ? `${exec.stderr}\n... (truncated: ${exec.stderrDroppedBytes ?? 0} bytes dropped)`
        : exec.stderr
      const text = [
        `# ${exitText}`,
        stdoutText ? `## stdout\n${stdoutText}` : "",
        stderrText ? `## stderr\n${stderrText}` : "",
      ]
        .filter(Boolean)
        .join("\n")
      const meta: Record<string, unknown> = {
        exit_code: exec.exitCode,
        duration_ms: exec.durationMs,
        killed: exec.killed,
      }
      if (resolved) meta.toolchain_source = resolved.source
      // Only emit truncation fields when truncation actually happened —
      // keeps the happy-path _meta minimal (设计红线 §12: stable set).
      if (exec.stdoutTruncated || exec.stderrTruncated) {
        meta.truncated = true
        meta.stdout_truncated = exec.stdoutTruncated ?? false
        meta.stderr_truncated = exec.stderrTruncated ?? false
        meta.stdout_dropped_bytes = exec.stdoutDroppedBytes ?? 0
        meta.stderr_dropped_bytes = exec.stderrDroppedBytes ?? 0
      }
      return {
        content: [{ type: "text", text }],
        isError: exec.exitCode !== 0 || exec.killed,
        _meta: meta,
      }
    },
  }
}

// ─────────────────────── environment + manager cache ─────────────────────────

let cachedEnvironment: Promise<ResolvedTerminalEnvironment> | null = null
let cachedManager: ToolchainManager | null = null

async function resolveEnvironment(
  opts: CommandlineBuiltinOptions
): Promise<ResolvedTerminalEnvironment> {
  if (opts.environment) return opts.environment
  if (!cachedEnvironment) {
    cachedEnvironment = detectTerminalEnvironment({
      pathResolver: opts.pathResolver,
    })
  }
  return cachedEnvironment
}

async function getDefaultToolchainManager(
  opts: CommandlineBuiltinOptions,
  env: ResolvedTerminalEnvironment
): Promise<ToolchainManager> {
  if (opts.toolchainManager) return opts.toolchainManager
  if (cachedManager) return cachedManager
  const manifestPath = defaultManifestPath()
  const toolchainDir = defaultToolchainDir()
  // Pre-stage lookup uses the canonical `defaultPrestageDirs` helper
  // from bundles/install.ts so EVERY entry point (install-bundles CLI,
  // synapse-device run wiring, and this lazy commandline builtin path)
  // sees the same lookup order:
  //   1. SYNAPSE_DEVICE_PRESTAGED_DIR env override
  //   2. Installed @synapse/device-runtime-bundles-<platformKey>
  //      sidecar packages (via node_modules walk OR monorepo packages/
  //      walk — same helper handles both layouts)
  //   3. device-runtime's own bundles/archives directory
  // Symmetric behavior between entry points means an archive staged
  // anywhere in that list is honored wherever the runtime ultimately
  // resolves, and a fresh `npm install @synapse/device-runtime` on a
  // host with the matching optional dep populates the sidecar path
  // BEFORE the runtime ever reaches the HTTPS fallback.
  const packageRoot = pathResolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    ".."
  )
  const prestageDirs = defaultPrestageDirs(packageRoot)
  cachedManager = createToolchainManager({
    manifestPath,
    toolchainDir,
    environment: env,
    pathResolver: opts.pathResolver ?? defaultPathResolver,
    prestageDirs,
  })
  return cachedManager
}

function defaultManifestPath(): string {
  // dist/builtins/commandline.js → walk up to package root, then bundles/.
  const here = dirname(fileURLToPath(import.meta.url))
  return pathResolve(here, "..", "..", "bundles", "manifest.json")
}

function defaultToolchainDir(): string {
  const xdg = process.env.XDG_CACHE_HOME
  const home = process.env.HOME ?? process.cwd()
  if (xdg && xdg.length > 0) {
    return join(xdg, "synapse", "device-toolchains")
  }
  return join(home, ".cache", "synapse", "device-toolchains")
}
