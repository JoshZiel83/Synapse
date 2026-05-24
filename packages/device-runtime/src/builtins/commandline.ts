// Commandline builtin (§4.5 / spec §10). v3.0 replaces relay/internal/builtinmcp/
// commandline. Provides two tools: bash (sync) and bash_task (async via
// task_mode='async'); v3.0 ships sync only — async lifecycle wiring lands
// when the API-side task plumbing is in place.

import { spawn } from "node:child_process"
import type { CatalogProvider } from "../types.js"
import type {
  DeviceCatalogExposure,
  DeviceCatalogTool,
} from "@synapse/device-protocol"

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
