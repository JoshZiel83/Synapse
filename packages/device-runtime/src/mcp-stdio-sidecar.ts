// Thin MCP stdio wrapper for device-runtime providers (chrome-devtools-mcp
// today; future stdio MCP backings as well). Reuses
// `@modelcontextprotocol/sdk` to handle the initialize handshake and
// tools/list / tools/call protocol so we never have to hand-roll JSON-RPC
// here (unlike device-runtime/src/sidecar.ts which is the line-protocol
// helper for the Go CUA binary).
//
// Plan §Phase 4, clarification #9 + #34.

import { spawn, type ChildProcess } from "node:child_process"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { createDeviceLogger } from "./logger.js"
import { DEVICE_RUNTIME_VERSION } from "./version.js"

// Unified device-runtime logger (structured NDJSON to stderr); see logger.ts.
const sidecarLog = createDeviceLogger("mcp-stdio-sidecar")

export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpCallToolResult {
  content?: Array<Record<string, unknown>>
  structuredContent?: unknown
  isError?: boolean
  _meta?: Record<string, unknown>
}

export interface McpClient {
  listTools(): Promise<{ tools: McpToolDescriptor[] }>
  callTool(args: {
    name: string
    arguments?: Record<string, unknown>
  }): Promise<McpCallToolResult>
  close(): Promise<void>
}

export interface McpStdioSidecarOptions {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** Notified once with a reason string if the child exits without close() being called. */
  onUnexpectedExit?: (reason: string) => void
}

export interface McpStdioSidecarHandle {
  client: McpClient
  /** Resolves with no value when the child has fully exited. */
  exited: Promise<void>
}

class SdkBackedClient implements McpClient {
  constructor(
    private readonly client: Client,
    private readonly state: { closed: boolean; exitReason: string | null }
  ) {}

  async listTools(): Promise<{ tools: McpToolDescriptor[] }> {
    this.assertAlive()
    const result = await this.client.listTools()
    return {
      tools: (result.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
      })),
    }
  }

  async callTool(args: {
    name: string
    arguments?: Record<string, unknown>
  }): Promise<McpCallToolResult> {
    this.assertAlive()
    const raw = await this.client.callTool({
      name: args.name,
      arguments: args.arguments,
    })
    return raw as McpCallToolResult
  }

  async close(): Promise<void> {
    if (this.state.closed) return
    this.state.closed = true
    try {
      await this.client.close()
    } catch {
      /* best-effort */
    }
  }

  private assertAlive() {
    if (this.state.exitReason !== null) {
      throw new Error(`sidecar_exited: ${this.state.exitReason}`)
    }
  }
}

/**
 * Spawn a stdio MCP server, run the initialize handshake, and return a
 * minimal McpClient that talks to it. The child is owned by this wrapper —
 * `close()` shuts it down cleanly; abnormal exits resolve `exited` and
 * fire `onUnexpectedExit`.
 *
 * We do NOT auto-restart. Restarts hide configuration errors (wrong pin
 * version, missing Chrome binary, bad CLI flag) — better to fail loudly
 * and let the device runtime degrade until the operator addresses the
 * root cause.
 */
export async function startMcpStdioSidecar(
  opts: McpStdioSidecarOptions
): Promise<McpStdioSidecarHandle> {
  const state: { closed: boolean; exitReason: string | null } = {
    closed: false,
    exitReason: null,
  }

  // We need direct access to the spawned child so onUnexpectedExit fires
  // even when the close path is server-initiated. StdioClientTransport
  // spawns its own child internally; we mirror its argv but pre-spawn so
  // the wrapper can observe `exit` deterministically.
  // The SDK Transport does its own spawning; we let it own the child. To
  // observe exit, we listen on the transport's `onclose` plus a manual
  // wrapping ChildProcess for `.on("exit")` semantics is unavailable —
  // so we proxy through StdioClientTransport's stderr/stdout events.
  //
  // Implementation note: `StdioClientTransport` exposes `.start()` /
  // `.close()` and emits `close` when the child exits. We hook it to
  // flip state.exitReason and resolve `exited`.

  const transport = new StdioClientTransport({
    command: opts.command,
    args: opts.args,
    env: opts.env as Record<string, string> | undefined,
    cwd: opts.cwd,
    stderr: "pipe",
  })

  let exitResolve!: () => void
  const exited = new Promise<void>((resolve) => {
    exitResolve = resolve
  })

  transport.onclose = () => {
    if (state.exitReason === null) {
      state.exitReason = state.closed ? "closed" : "process_exited"
      if (!state.closed && opts.onUnexpectedExit) {
        try {
          opts.onUnexpectedExit(state.exitReason)
        } catch {
          /* listener errors must not block exit propagation */
        }
      }
    }
    exitResolve()
  }
  transport.onerror = (err: Error) => {
    // Surface stderr/transport errors as exit reasons so the next call
    // produces a useful message.
    if (state.exitReason === null) {
      state.exitReason = `transport_error: ${err.message}`
    }
  }

  // Drain stderr so the pipe doesn't fill up + back-pressure the child.
  ;(
    transport as unknown as {
      stderr?: { on(event: string, cb: (chunk: Buffer) => void): void }
    }
  ).stderr?.on("data", (chunk) => {
    const message = chunk.toString().trim()
    if (message) {
      sidecarLog.error("sidecar stderr", { line: message })
    }
  })

  const client = new Client(
    { name: "synapse-device-runtime", version: DEVICE_RUNTIME_VERSION },
    { capabilities: {} }
  )

  try {
    await client.connect(transport)
  } catch (err) {
    state.exitReason = `initialize_failed: ${(err as Error).message}`
    try {
      await transport.close()
    } catch {
      /* best-effort */
    }
    throw err
  }

  const wrapped = new SdkBackedClient(client, state)
  return { client: wrapped, exited }
}

// Re-export the spawn type so tests that need to assert against the SDK
// internals don't have to re-import node:child_process.
export type { ChildProcess }
export { spawn }
