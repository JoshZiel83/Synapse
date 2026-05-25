// Commandline builtin (§4.5 / spec §10). v3.0 replaces relay/internal/builtinmcp/
// commandline. Provides two tools: bash (sync) and bash_task (async via
// task_mode='async'); v3.0 ships sync only — async lifecycle wiring lands
// when the API-side task plumbing is in place.

import { spawn } from "node:child_process"
import type {
  CatalogProvider,
  CatalogToolInvocationResult,
} from "../types.js"
import type {
  DeviceCatalogExposure,
  DeviceCatalogTool,
} from "@synapse/device-protocol"
import { toolErrorResult } from "../mcp-host.js"

const PROVIDER_KEY = "builtin.commandline"

const BASH_TOOL: DeviceCatalogTool = {
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

export interface CommandlineBuiltinOptions {
  displayName?: string
}

export function createCommandlineBuiltin(
  opts: CommandlineBuiltinOptions = {}
): CatalogProvider {
  return {
    providerKey: PROVIDER_KEY,
    async describeExposures(): Promise<DeviceCatalogExposure[]> {
      return [
        {
          stable_key: "builtin/commandline",
          display_name: opts.displayName ?? "Commandline (bash)",
          transport: "builtin",
          builtin_kind: "commandline",
          metadata: {
            executors: ["bash"],
            asyncTasksSupported: false,
            schemaVersion: 1,
          },
          tools: [BASH_TOOL],
        },
      ]
    },
    async invokeTool(input): Promise<CatalogToolInvocationResult> {
      if (input.toolName !== "bash") {
        return toolErrorResult({
          code: "invalid_request",
          message: `commandline builtin does not handle ${input.toolName}`,
        })
      }
      const command = input.args["command"]
      if (typeof command !== "string" || command.length === 0) {
        return toolErrorResult({
          code: "invalid_request",
          message: "bash: 'command' (string) is required",
        })
      }
      const workingDirectory = input.args["working_directory"]
      // Device-side runtime authorization: the server-signed envelope must
      // carry a commandline grant_spec whose policy allows this command.
      // Reject if no commandline policy is present.
      const grantSpecs = input.envelope?.runtime_authorization?.grant_specs ?? []
      const commandlinePolicies = grantSpecs
        .filter((g) => g.capability === "commandline" && g.commandline)
        .map((g) => g.commandline!)
      if (input.envelope && commandlinePolicies.length === 0) {
        return toolErrorResult({
          code: "permission_denied",
          message:
            "no runtime_authorization grant covers capability='commandline' for this bash call",
        })
      }
      if (commandlinePolicies.length > 0) {
        const matched = commandlinePolicies.some((p) =>
          commandMatchesPolicy(command, p)
        )
        if (!matched) {
          return toolErrorResult({
            code: "permission_denied",
            message: `bash command not covered by any commandline grant policy: ${command.slice(0, 80)}`,
          })
        }
      }
      const timeoutMs = input.args["timeout_ms"]
      const exec = await executeBash({
        command,
        workingDirectory:
          typeof workingDirectory === "string" ? workingDirectory : undefined,
        timeoutMs: typeof timeoutMs === "number" ? timeoutMs : undefined,
      })
      const exitText = exec.killed
        ? `(killed after ${exec.durationMs}ms)`
        : `exit ${exec.exitCode} in ${exec.durationMs}ms`
      const text = [
        `# ${exitText}`,
        exec.stdout ? `## stdout\n${exec.stdout}` : "",
        exec.stderr ? `## stderr\n${exec.stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n")
      return {
        content: [{ type: "text", text }],
        isError: exec.exitCode !== 0 || exec.killed,
        _meta: {
          exit_code: exec.exitCode,
          duration_ms: exec.durationMs,
          killed: exec.killed,
        },
      }
    },
  }
}

function commandMatchesPolicy(
  command: string,
  policy: {
    executor: "bash"
    command_match_type: "exact" | "prefix" | "tool"
    command_text?: string
    working_directory?: string
  }
): boolean {
  if (policy.executor !== "bash") return false
  switch (policy.command_match_type) {
    case "exact":
      return policy.command_text === command
    case "prefix":
      return (
        typeof policy.command_text === "string" &&
        command.startsWith(policy.command_text)
      )
    case "tool": {
      // "tool" match: the command_text is the leading token (binary name).
      if (typeof policy.command_text !== "string") return false
      const head = command.trim().split(/\s+/)[0] ?? ""
      return head === policy.command_text
    }
    default:
      return false
  }
}

export interface BashExecutionResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  killed: boolean
}

export interface BashExecutionOptions {
  command: string
  workingDirectory?: string
  timeoutMs?: number
}

/**
 * Synchronous bash execution helper used by the MCP host's tool handler.
 * Returns the captured streams + exit code. Throws only on spawn failure;
 * non-zero exits surface as part of the result.
 */
export function executeBash(
  opts: BashExecutionOptions
): Promise<BashExecutionResult> {
  const timeoutMs = Math.max(
    1000,
    Math.min(opts.timeoutMs ?? 60_000, 5 * 60_000)
  )
  return new Promise<BashExecutionResult>((resolve, reject) => {
    const started = Date.now()
    let killed = false
    let stdoutChunks: Buffer[] = []
    let stderrChunks: Buffer[] = []
    const child = spawn("bash", ["-lc", opts.command], {
      cwd: opts.workingDirectory ?? process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const timer = setTimeout(() => {
      killed = true
      try {
        child.kill("SIGKILL")
      } catch {
        /* ignore */
      }
    }, timeoutMs)
    child.stdout.on("data", (b: Buffer) => stdoutChunks.push(b))
    child.stderr.on("data", (b: Buffer) => stderrChunks.push(b))
    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        durationMs: Date.now() - started,
        killed,
      })
    })
  })
}
